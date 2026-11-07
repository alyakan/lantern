//! The HTTP proxy the phone's Wi-Fi settings can point at (what Network Monitor was): plain requests are sent on as they
//! come, a CONNECT is answered and its TLS read (see intercept.rs), and a request for the proxy itself gets the page
//! that hands out Lantern's root certificate.

use super::ca::Authority;
use super::intercept::{self, Body, Engine};
use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use std::io;
use std::sync::Arc;
use tokio::net::TcpListener;

/// How the proxy knows a request is for itself: its port, and this Mac's addresses.
pub struct Me {
    pub port: u16,
    pub addresses: Vec<String>,
}

impl Me {
    fn is(&self, url: &hyper::Uri) -> bool {
        let Some(host) = url.host() else { return true };
        let port = url.port_u16().unwrap_or(if url.scheme_str() == Some("https") { 443 } else { 80 });
        let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
        port == self.port && (host == "localhost" || self.addresses.iter().any(|a| a.eq_ignore_ascii_case(&host)))
    }
}

pub async fn run(engine: Arc<Engine>, listener: TcpListener, me: Arc<Me>) {
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        let (engine, me) = (engine.clone(), me.clone());
        tokio::spawn(async move {
            let service = hyper::service::service_fn(move |req| handle(engine.clone(), me.clone(), req));
            let _ = hyper::server::conn::http1::Builder::new().preserve_header_case(true).serve_connection(TokioIo::new(stream), service).with_upgrades().await;
        });
    }
}

async fn handle(engine: Arc<Engine>, me: Arc<Me>, req: Request<Incoming>) -> Result<Response<Body>, io::Error> {
    if req.method() == Method::CONNECT {
        let Some(authority) = req.uri().authority().cloned() else {
            return Ok(intercept::text(StatusCode::BAD_REQUEST, "Lantern: a CONNECT with no host."));
        };
        let host = authority.host().trim_matches(['[', ']']).to_ascii_lowercase();
        let port = authority.port_u16().unwrap_or(443);
        tokio::spawn(async move {
            if let Ok(upgraded) = hyper::upgrade::on(req).await {
                let connect = format!("{}:{port}", authority.host());
                intercept::intercept(engine, TokioIo::new(upgraded), host, port, connect).await;
            }
        });
        return Ok(Response::new(Full::new(Bytes::new()).map_err(|never| match never {}).boxed()));
    }
    if me.is(req.uri()) {
        return Ok(setup(req.uri().path(), &engine.ca));
    }
    intercept::forward(engine, req, None).await
}

/// The page a phone opens to install Lantern's root, or the root itself (at /ca, as Network Monitor served it).
pub fn setup(path: &str, ca: &Authority) -> Response<Body> {
    let (kind, name, body) = match path {
        "/ca" | "/ca.cer" | "/ca.crt" => ("application/x-x509-ca-cert", Some("Lantern-CA.cer"), Bytes::from(ca.der.clone())),
        "/ca.pem" => ("application/x-pem-file", Some("Lantern-CA.pem"), Bytes::from(ca.pem.clone())),
        _ => ("text/html; charset=utf-8", None, Bytes::from_static(SETUP_PAGE.as_bytes())),
    };
    let mut res = Response::new(Full::new(body).map_err(|never| match never {}).boxed());
    res.headers_mut().insert("content-type", kind.parse().unwrap());
    if let Some(name) = name {
        res.headers_mut().insert("content-disposition", format!("attachment; filename=\"{name}\"").parse().unwrap());
    }
    res
}

const SETUP_PAGE: &str = r#"<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lantern capture</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;margin:40px auto;max-width:560px;padding:0 20px;line-height:1.5;color:#1d1d1f}
@media (prefers-color-scheme: dark){body{background:#1c1c1e;color:#f2f2f7}}
a.btn{display:inline-block;padding:12px 20px;background:#0a84ff;color:#fff;border-radius:10px;text-decoration:none;font-weight:600}
li{margin-bottom:8px}
</style></head>
<body>
<h1>Lantern capture</h1>
<p>Install Lantern's root certificate so Lantern can read this phone's HTTPS traffic.</p>
<p><a class="btn" href="/ca">Download the certificate</a></p>
<h2>iPhone and iPad</h2>
<ol>
<li>Tap the button and allow the profile download.</li>
<li>Settings &rarr; General &rarr; VPN &amp; Device Management &rarr; install &ldquo;Lantern Capture Root CA&rdquo; (or &ldquo;Network Monitor Root CA&rdquo;, if Lantern took over Network Monitor's).</li>
<li>Settings &rarr; General &rarr; About &rarr; Certificate Trust Settings &rarr; turn on full trust for it.</li>
</ol>
<h2>Android</h2>
<ol>
<li>Tap the button; the file goes to Downloads.</li>
<li>Settings &rarr; Security &rarr; Encryption &amp; credentials &rarr; Install a certificate &rarr; CA certificate &rarr; pick the file.</li>
<li>Apps only trust a CA the user installed if their network security config allows it.</li>
</ol>
<p>Remove the certificate when you're done capturing.</p>
</body></html>
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::recorder::Recorder;
    use crate::network::Source;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn proxy() -> (u16, Arc<Recorder>, Arc<Engine>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let recorder = Arc::new(Recorder::new());
        recorder.active.store(true, std::sync::atomic::Ordering::Relaxed);
        let engine = Arc::new(Engine::new(Authority::load(dir.path(), None).unwrap(), recorder.clone()).unwrap());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(run(engine.clone(), listener, Arc::new(Me { port, addresses: vec!["127.0.0.1".into()] })));
        (port, recorder, engine, dir)
    }

    /// Reads what's on `s` until `until` shows up in it.
    async fn read_until(s: &mut tokio::net::TcpStream, until: &str) -> String {
        let mut got = Vec::new();
        let mut buf = [0u8; 4096];
        while !String::from_utf8_lossy(&got).contains(until) {
            let n = tokio::time::timeout(Duration::from_secs(5), s.read(&mut buf)).await.expect("it came in time").unwrap();
            assert!(n > 0, "closed before {until:?}: {}", String::from_utf8_lossy(&got));
            got.extend_from_slice(&buf[..n]);
        }
        String::from_utf8_lossy(&got).into_owned()
    }

    #[tokio::test]
    async fn a_stream_reaches_the_app_as_it_comes() {
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let up = upstream.local_addr().unwrap().port();
        let (go_on, wait) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let (mut s, _) = upstream.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = s.read(&mut buf).await.unwrap();
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
            s.write_all(b"d\r\ndata: first\n\n\r\n").await.unwrap();
            // The rest only once the app has had the first event.
            wait.await.unwrap();
            s.write_all(b"e\r\ndata: second\n\n\r\n0\r\n\r\n").await.unwrap();
        });
        let (port, recorder, _engine, _dir) = proxy().await;
        let mut app = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        app.write_all(format!("GET http://127.0.0.1:{up}/events HTTP/1.1\r\nHost: 127.0.0.1:{up}\r\n\r\n").as_bytes()).await.unwrap();
        read_until(&mut app, "data: first").await;
        let pending = recorder.list(0).unwrap();
        assert_eq!(pending.transactions[0].state, "pending");
        go_on.send(()).unwrap();
        read_until(&mut app, "data: second").await;
        for _ in 0..100 {
            if recorder.list(0).unwrap().transactions[0].state == "completed" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let tx = recorder.list(0).unwrap().transactions.remove(0);
        assert_eq!((tx.state.as_str(), tx.status, tx.response_size), ("completed", Some(200), 27));
        assert_eq!(recorder.detail(&tx.id).unwrap().response_body.text(), Some("data: first\n\ndata: second\n\n"));
    }

    #[tokio::test]
    async fn a_connect_to_plain_http_is_read_as_http() {
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let up = upstream.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = upstream.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = s.read(&mut buf).await.unwrap();
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok").await.unwrap();
        });
        let (port, recorder, _engine, _dir) = proxy().await;
        let mut app = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        app.write_all(format!("CONNECT 127.0.0.1:{up} HTTP/1.1\r\nHost: 127.0.0.1:{up}\r\n\r\n").as_bytes()).await.unwrap();
        read_until(&mut app, "\r\n\r\n").await;
        app.write_all(format!("GET /plain HTTP/1.1\r\nHost: 127.0.0.1:{up}\r\n\r\n").as_bytes()).await.unwrap();
        assert!(read_until(&mut app, "\r\n\r\nok").await.starts_with("HTTP/1.1 200 OK"));
        assert_eq!(recorder.list(0).unwrap().transactions[0].url, format!("http://127.0.0.1:{up}/plain"));
    }

    #[tokio::test]
    async fn https_through_the_proxy_is_read_with_a_certificate_the_app_trusts() {
        let (port, recorder, engine, _dir) = proxy().await;
        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).unwrap())
            .tls_certs_only([reqwest::Certificate::from_der(&engine.ca.der).unwrap()])
            .build()
            .unwrap();
        // Nothing answers at .invalid: the TLS was read (the client trusted the certificate), and sending it on failed.
        let res = client.get("https://shop.invalid/api/search?q=milk").send().await.unwrap();
        assert_eq!(res.status(), 502);
        let tx = recorder.list(0).unwrap().transactions.remove(0);
        assert_eq!((tx.url.as_str(), tx.state.as_str()), ("https://shop.invalid/api/search?q=milk", "failed"));
    }

    #[tokio::test]
    async fn the_setup_page_and_the_root_are_served() {
        let (port, _recorder, engine, _dir) = proxy().await;
        let mut app = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        app.write_all(b"GET /ca HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").await.unwrap();
        let got = read_until(&mut app, "\r\n\r\n").await;
        assert!(got.contains("application/x-x509-ca-cert"), "{got}");
        assert!(got.to_lowercase().contains(&format!("content-length: {}", engine.ca.der.len())), "{got}");
    }
}
