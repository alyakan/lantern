//! Reading a connection from the phone: TLS ended with a certificate minted for the host the app asked for (its SNI),
//! then each HTTP/1.1 request sent on to its server, recorded, and its response streamed back as it comes, so a long
//! stream (server-sent events) reaches the app live instead of after it ends.

use super::ca::Authority;
use super::recorder::{Recorder, Start, MAX_BODY};
use crate::network::Header;
use http_body_util::{combinators::BoxBody, BodyExt, Full, StreamBody};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use std::collections::HashMap;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};

pub type Body = BoxBody<Bytes, io::Error>;

/// How long a host whose app turned down Lantern's certificate is passed through unread.
const PASS_THROUGH_FOR: Duration = Duration::from_secs(10 * 60);
/// The most of a ClientHello waited for.
const MAX_HELLO: usize = 16 << 10;

/// Request headers that are about the hop to the proxy, not the request. Accept-Encoding is the upstream client's to
/// choose: it undoes what it asked for, so the app and the record both get the body as it is.
const HOP_REQUEST: &[&str] = &["connection", "proxy-connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", "accept-encoding", "proxy-authorization"];
const HOP_RESPONSE: &[&str] = &["connection", "proxy-connection", "keep-alive", "transfer-encoding", "upgrade", "trailer"];

pub struct Engine {
    pub ca: Authority,
    pub recorder: Arc<Recorder>,
    client: reqwest::Client,
    /// Hosts passed through unread, until when.
    passing: Mutex<HashMap<String, Instant>>,
}

impl Engine {
    pub fn new(ca: Authority, recorder: Arc<Recorder>) -> Result<Self, String> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            // Never back through a proxy (this one, if the Mac is set to use it).
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self { ca, recorder, client, passing: Mutex::new(HashMap::new()) })
    }

    fn passes(&self, host: &str) -> bool {
        let mut passing = self.passing.lock().unwrap();
        passing.retain(|_, until| *until > Instant::now());
        passing.contains_key(host)
    }
}

/// Where a connection's requests go when they don't name it themselves.
#[derive(Clone)]
pub struct Origin {
    pub scheme: &'static str,
    /// host or host:port.
    pub authority: String,
}

/// What the phone's TLS connection opens with.
#[derive(Debug, PartialEq)]
pub enum Hello {
    /// Not all of it has come yet.
    More,
    NotTls,
    /// A ClientHello, with the host it names (SNI), if any.
    Tls(Option<String>),
}

/// Reads the server name out of a TLS ClientHello's first record.
pub fn read_hello(buf: &[u8]) -> Hello {
    if buf.is_empty() {
        return Hello::More;
    }
    if buf[0] != 0x16 {
        return Hello::NotTls;
    }
    if buf.len() < 5 {
        return Hello::More;
    }
    let record = u16::from_be_bytes([buf[3], buf[4]]) as usize;
    if buf.len() < 5 + record {
        return if 5 + record > MAX_HELLO { Hello::Tls(None) } else { Hello::More };
    }
    Hello::Tls(sni(&buf[5..5 + record]))
}

fn sni(hs: &[u8]) -> Option<String> {
    let mut r = Reader(hs);
    if r.u8()? != 1 {
        return None;
    }
    r.take(3)?; // handshake length
    r.take(2 + 32)?; // version, random
    let n = r.u8()? as usize;
    r.take(n)?; // session id
    let n = r.u16()? as usize;
    r.take(n)?; // cipher suites
    let n = r.u8()? as usize;
    r.take(n)?; // compression
    let n = r.u16()? as usize;
    let mut ext = Reader(r.take(n).unwrap_or(r.0));
    while let (Some(kind), Some(len)) = (ext.u16(), ext.u16()) {
        let data = ext.take(len as usize)?;
        if kind == 0 {
            let mut names = Reader(data);
            let n = names.u16()? as usize;
            let mut names = Reader(names.take(n)?);
            while let Some(kind) = names.u8() {
                let n = names.u16()? as usize;
                let name = names.take(n)?;
                if kind == 0 {
                    return std::str::from_utf8(name).ok().map(|s| s.to_ascii_lowercase());
                }
            }
        }
    }
    None
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        (self.0.len() >= n).then(|| {
            let (a, b) = self.0.split_at(n);
            self.0 = b;
            a
        })
    }
    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }
    fn u16(&mut self) -> Option<u16> {
        self.take(2).map(|b| u16::from_be_bytes([b[0], b[1]]))
    }
}

/// A stream that gives back what was already read off it before the rest.
pub struct Prefixed<S> {
    prefix: Vec<u8>,
    at: usize,
    inner: S,
}

impl<S> Prefixed<S> {
    pub fn new(prefix: Vec<u8>, inner: S) -> Self {
        Self { prefix, at: 0, inner }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Prefixed<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        if self.at < self.prefix.len() {
            let n = buf.remaining().min(self.prefix.len() - self.at);
            let at = self.at;
            buf.put_slice(&self.prefix[at..at + n]);
            self.at += n;
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Prefixed<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Reads a connection that should be TLS for `host` (from the CONNECT, or the address the phone dialled), at `port`.
/// `connect` is where a passed-through connection goes. Plain HTTP on it is read as HTTP.
pub async fn intercept<S>(engine: Arc<Engine>, mut stream: S, host: String, port: u16, connect: String)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut buf = Vec::with_capacity(2048);
    let hello = loop {
        match read_hello(&buf) {
            Hello::More => {}
            done => break done,
        }
        let mut chunk = [0u8; 4096];
        match tokio::time::timeout(Duration::from_secs(10), stream.read(&mut chunk)).await {
            Ok(Ok(n)) if n > 0 => buf.extend_from_slice(&chunk[..n]),
            _ => return,
        }
    };
    let authority = if port == 443 { host.clone() } else { format!("{host}:{port}") };
    let sni = match hello {
        Hello::Tls(sni) => sni,
        _ => {
            let origin = Origin { scheme: "http", authority };
            return serve(engine, Prefixed::new(buf, stream), Some(origin)).await;
        }
    };
    let host = sni.unwrap_or(host);
    if engine.passes(&host) {
        return pass(Prefixed::new(buf, stream), &connect).await;
    }
    let config = match engine.ca.server_config(&host) {
        Ok(config) => config,
        Err(e) => {
            engine.recorder.failed_connection(format!("https://{authority}"), format!("Lantern couldn't make a certificate for it ({e}), so it was passed through unread."));
            return pass(Prefixed::new(buf, stream), &connect).await;
        }
    };
    match tokio_rustls::TlsAcceptor::from(config).accept(Prefixed::new(buf, stream)).await {
        Ok(tls) => serve(engine, tls, Some(Origin { scheme: "https", authority: if port == 443 { host } else { format!("{host}:{port}") } })).await,
        Err(e) => {
            engine.passing.lock().unwrap().insert(host.clone(), Instant::now() + PASS_THROUGH_FOR);
            engine.recorder.failed_connection(
                format!("https://{authority}"),
                format!("The app turned down Lantern's certificate ({e}). Either the phone doesn't trust Lantern's root yet, or the app pins its certificates. Its connections pass through unread for the next 10 minutes."),
            );
        }
    }
}

/// Copies a connection to `connect` and back, unread.
pub async fn pass<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, connect: &str) {
    if let Ok(Ok(mut upstream)) = tokio::time::timeout(Duration::from_secs(15), tokio::net::TcpStream::connect(connect)).await {
        let _ = tokio::io::copy_bidirectional(&mut stream, &mut upstream).await;
        let _ = upstream.shutdown().await;
    }
}

/// Serves HTTP/1.1 on a connection, sending each request on to its server.
pub async fn serve<S>(engine: Arc<Engine>, stream: S, origin: Option<Origin>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let service = hyper::service::service_fn(move |req| forward(engine.clone(), req, origin.clone()));
    let _ = hyper::server::conn::http1::Builder::new().preserve_header_case(true).title_case_headers(false).serve_connection(TokioIo::new(stream), service).await;
}

pub fn text(status: StatusCode, body: impl Into<String>) -> Response<Body> {
    let mut res = Response::new(Full::new(Bytes::from(body.into())).map_err(|never| match never {}).boxed());
    *res.status_mut() = status;
    res.headers_mut().insert("content-type", "text/plain; charset=utf-8".parse().unwrap());
    res
}

/// The full URL a request is for: as sent to a proxy, or its path on the connection's origin (its Host if it names one).
pub fn url_of(req: &Request<Incoming>, origin: Option<&Origin>) -> Option<String> {
    if req.uri().scheme().is_some() {
        return Some(req.uri().to_string());
    }
    let origin = origin?;
    let host = req.headers().get("host").and_then(|h| h.to_str().ok()).filter(|h| !h.is_empty()).unwrap_or(&origin.authority);
    let path = req.uri().path_and_query().map(|p| p.as_str()).unwrap_or("/");
    Some(format!("{}://{host}{path}", origin.scheme))
}

/// Sends one request on, recording it, and streams its response back.
pub async fn forward(engine: Arc<Engine>, req: Request<Incoming>, origin: Option<Origin>) -> Result<Response<Body>, io::Error> {
    let Some(url) = url_of(&req, origin.as_ref()) else {
        return Ok(text(StatusCode::BAD_REQUEST, "Lantern: a request with no host."));
    };
    let (parts, body) = req.into_parts();
    let headers: Vec<Header> = parts.headers.iter().map(|(k, v)| Header { name: k.as_str().to_string(), value: String::from_utf8_lossy(v.as_bytes()).into_owned() }).collect();
    let body = match body.collect().await {
        Ok(b) => b.to_bytes(),
        Err(_) => return Ok(text(StatusCode::BAD_REQUEST, "Lantern: the request's body didn't all come.")),
    };
    let id = engine.recorder.start(Start { method: parts.method.to_string(), url: url.clone(), headers, body: body.to_vec() });
    if parts.headers.contains_key("upgrade") {
        engine.recorder.fail(&id, "An upgrade (a WebSocket) isn't captured.".into(), Vec::new(), 0);
        return Ok(text(StatusCode::NOT_IMPLEMENTED, "Lantern doesn't capture WebSockets."));
    }
    let mut out = reqwest::header::HeaderMap::new();
    for (k, v) in parts.headers.iter() {
        if !HOP_REQUEST.contains(&k.as_str()) {
            out.append(k.clone(), v.clone());
        }
    }
    let method = reqwest::Method::from_bytes(parts.method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET);
    let sent = engine.client.request(method, &url).headers(out).body(body).send().await;
    let res = match sent {
        Ok(res) => res,
        Err(e) => {
            let why = error_chain(&e);
            engine.recorder.fail(&id, why.clone(), Vec::new(), 0);
            return Ok(text(StatusCode::BAD_GATEWAY, format!("Lantern couldn't reach the server: {why}")));
        }
    };
    let status = res.status().as_u16();
    let got: Vec<Header> = res.headers().iter().map(|(k, v)| Header { name: k.as_str().to_string(), value: String::from_utf8_lossy(v.as_bytes()).into_owned() }).collect();
    engine.recorder.respond(&id, status, got);

    let mut back = Response::builder().status(status);
    for (k, v) in res.headers() {
        if !HOP_RESPONSE.contains(&k.as_str()) {
            back = back.header(k, v);
        }
    }
    // No body to wait for: the app is never sent one.
    if parts.method == hyper::Method::HEAD || matches!(status, 204 | 304) || status < 200 {
        engine.recorder.complete(&id, Vec::new(), 0);
        return Ok(back.body(Full::new(Bytes::new()).map_err(|never| match never {}).boxed()).unwrap_or_else(|e| text(StatusCode::BAD_GATEWAY, format!("Lantern couldn't pass the response on: {e}"))));
    }
    let tee = Tee { recorder: engine.recorder.clone(), id, kept: Vec::new(), size: 0, expected: res.content_length(), done: false };
    let chunks = futures_util::stream::unfold(Some((tee, res)), |state| async move {
        let (mut tee, mut res) = state?;
        match res.chunk().await {
            Ok(Some(chunk)) => {
                tee.push(&chunk);
                Some((Ok(Frame::data(chunk)), Some((tee, res))))
            }
            Ok(None) => {
                tee.finish(None);
                None
            }
            Err(e) => {
                let why = error_chain(&e);
                tee.finish(Some(why.clone()));
                Some((Err(io::Error::other(why)), None))
            }
        }
    });
    Ok(back.body(StreamBody::new(chunks).boxed()).unwrap_or_else(|e| text(StatusCode::BAD_GATEWAY, format!("Lantern couldn't pass the response on: {e}"))))
}

/// Keeps what a response's body brings (up to MAX_BODY) and records it when it ends, or when the app hangs up first.
struct Tee {
    recorder: Arc<Recorder>,
    id: String,
    kept: Vec<u8>,
    size: u64,
    /// Its Content-Length: the app's connection stops reading once that much has come.
    expected: Option<u64>,
    done: bool,
}

impl Tee {
    fn push(&mut self, chunk: &[u8]) {
        self.size += chunk.len() as u64;
        let room = MAX_BODY.saturating_sub(self.kept.len());
        self.kept.extend_from_slice(&chunk[..room.min(chunk.len())]);
    }

    fn finish(&mut self, error: Option<String>) {
        if std::mem::replace(&mut self.done, true) {
            return;
        }
        let kept = std::mem::take(&mut self.kept);
        match error {
            None => self.recorder.complete(&self.id, kept, self.size),
            Some(e) => self.recorder.fail(&self.id, e, kept, self.size),
        }
    }
}

impl Drop for Tee {
    fn drop(&mut self) {
        if self.expected.is_some_and(|n| self.size >= n) {
            return self.finish(None);
        }
        self.finish(Some("The app closed the connection before the response ended.".into()));
    }
}

/// An error with what caused it, as one line.
fn error_chain(e: &(dyn std::error::Error + 'static)) -> String {
    let mut out = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        let line = s.to_string();
        if !out.contains(&line) {
            out.push_str(": ");
            out.push_str(&line);
        }
        source = s.source();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A ClientHello as rustls sends it, for `name`.
    fn hello(name: &str) -> Vec<u8> {
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider())).with_safe_default_protocol_versions().unwrap().with_root_certificates(rustls::RootCertStore::empty()).with_no_client_auth();
        let mut conn = rustls::ClientConnection::new(Arc::new(config), rustls::pki_types::ServerName::try_from(name.to_string()).unwrap()).unwrap();
        let mut out = Vec::new();
        conn.write_tls(&mut out).unwrap();
        out
    }

    #[test]
    fn the_host_is_read_from_the_hello() {
        let h = hello("API.Example.com");
        assert_eq!(read_hello(&h), Hello::Tls(Some("api.example.com".into())));
        assert_eq!(read_hello(&h[..3]), Hello::More);
        assert_eq!(read_hello(&h[..h.len() - 1]), Hello::More);
        assert_eq!(read_hello(b"GET / HTTP/1.1\r\n"), Hello::NotTls);
        // An IP address isn't sent as SNI.
        assert_eq!(read_hello(&hello("10.0.0.1")), Hello::Tls(None));
    }

    #[tokio::test]
    async fn a_prefixed_stream_reads_its_prefix_first() {
        let (mut a, b) = tokio::io::duplex(64);
        a.write_all(b" world").await.unwrap();
        drop(a);
        let mut p = Prefixed::new(b"hello".to_vec(), b);
        let mut s = String::new();
        p.read_to_string(&mut s).await.unwrap();
        assert_eq!(s, "hello world");
    }
}
