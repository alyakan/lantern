//! What the capture has seen: the newest MAX_KEPT requests, in memory only. Every change bumps a revision, so the Network
//! tab's follower reads only what changed since it last looked (as it read Network Monitor's API).

use crate::network::{Body, Detail, Fault, Header, List, Source, Tx};
use base64::Engine;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// The most requests kept; older ones drop off.
const MAX_KEPT: usize = 5000;
/// The most of one body kept (the app still gets all of it).
pub const MAX_BODY: usize = 8 << 20;

struct Entry {
    tx: Tx,
    request_headers: Vec<Header>,
    request_body: Vec<u8>,
    response_headers: Vec<Header>,
    response_body: Vec<u8>,
}

struct Inner {
    revision: u64,
    entries: VecDeque<Entry>,
}

pub struct Recorder {
    /// This run's id: the follower starts over when it changes.
    instance: String,
    inner: Mutex<Inner>,
    /// The capture is on. Off with nothing recorded, the Network tab and Claude are told to start it.
    pub active: AtomicBool,
}

impl Default for Recorder {
    fn default() -> Self {
        Self::new()
    }
}

/// A request as it starts.
pub struct Start {
    pub method: String,
    pub url: String,
    pub headers: Vec<Header>,
    pub body: Vec<u8>,
}

impl Recorder {
    pub fn new() -> Self {
        Self { instance: new_id(), inner: Mutex::new(Inner { revision: 0, entries: VecDeque::new() }), active: AtomicBool::new(false) }
    }

    /// How many requests it has now.
    pub fn count(&self) -> usize {
        self.inner.lock().unwrap().entries.len()
    }

    /// Records a request going out; its id, for finishing it.
    pub fn start(&self, start: Start) -> String {
        let id = new_id();
        let (host, path) = split_url(&start.url);
        let tx = Tx {
            id: id.clone(),
            revision: 0,
            started_at: now_ms(),
            method: start.method,
            url: start.url,
            host,
            path,
            status: None,
            duration_ms: None,
            state: "pending".into(),
            error: None,
            request_content_type: header(&start.headers, "content-type"),
            response_content_type: None,
            request_size: start.body.len() as u64,
            response_size: 0,
        };
        let mut body = start.body;
        body.truncate(MAX_BODY);
        let mut inner = self.inner.lock().unwrap();
        inner.revision += 1;
        let mut entry = Entry { tx, request_headers: start.headers, request_body: body, response_headers: Vec::new(), response_body: Vec::new() };
        entry.tx.revision = inner.revision;
        inner.entries.push_back(entry);
        while inner.entries.len() > MAX_KEPT {
            inner.entries.pop_front();
        }
        id
    }

    /// The response's status and headers have come; the body is still on its way.
    pub fn respond(&self, id: &str, status: u16, headers: Vec<Header>) {
        self.change(id, |e| {
            e.tx.status = Some(status);
            e.tx.response_content_type = header(&headers, "content-type");
            e.response_headers = headers;
        });
    }

    /// The response's body has all come (`size` bytes, of which `body` is what was kept).
    pub fn complete(&self, id: &str, body: Vec<u8>, size: u64) {
        self.change(id, |e| {
            e.tx.state = "completed".into();
            e.tx.duration_ms = Some(now_ms() - e.tx.started_at);
            e.tx.response_size = size;
            e.response_body = body;
        });
    }

    pub fn fail(&self, id: &str, error: String, body: Vec<u8>, size: u64) {
        self.change(id, |e| {
            e.tx.state = "failed".into();
            e.tx.error = Some(error);
            e.tx.duration_ms = Some(now_ms() - e.tx.started_at);
            e.tx.response_size = size;
            e.response_body = body;
        });
    }

    /// A connection the capture couldn't read (the app turned down Lantern's certificate, say), as a failed request.
    pub fn failed_connection(&self, url: String, error: String) {
        let id = self.start(Start { method: "CONNECT".into(), url, headers: Vec::new(), body: Vec::new() });
        self.fail(&id, error, Vec::new(), 0);
    }

    pub fn clear(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.revision += 1;
        inner.entries.clear();
    }

    fn change(&self, id: &str, f: impl FnOnce(&mut Entry)) {
        let mut inner = self.inner.lock().unwrap();
        let revision = inner.revision + 1;
        if let Some(e) = inner.entries.iter_mut().rev().find(|e| e.tx.id == id) {
            f(e);
            e.tx.revision = revision;
            inner.revision = revision;
        }
    }
}

impl Source for Recorder {
    fn list(&self, since: u64) -> Result<List, Fault> {
        let inner = self.inner.lock().unwrap();
        if inner.entries.is_empty() && !self.active.load(Ordering::Relaxed) {
            return Err(Fault::NotRunning);
        }
        let transactions = inner.entries.iter().filter(|e| e.tx.revision > since).map(|e| e.tx.clone()).collect();
        Ok(List { instance: self.instance.clone(), revision: inner.revision, transactions })
    }

    fn detail(&self, id: &str) -> Result<Detail, Fault> {
        let inner = self.inner.lock().unwrap();
        let e = inner.entries.iter().rev().find(|e| e.tx.id == id).ok_or(Fault::NotFound)?;
        Ok(Detail {
            transaction: e.tx.clone(),
            request_headers: e.request_headers.clone(),
            request_body: body(&e.request_body, e.tx.request_size),
            response_headers: e.response_headers.clone(),
            response_body: body(&e.response_body, e.tx.response_size),
        })
    }
}

/// The recorder the capture writes to, as the Network tab's follower reads it.
impl Source for std::sync::Arc<Recorder> {
    fn list(&self, since: u64) -> Result<List, Fault> {
        (**self).list(since)
    }

    fn detail(&self, id: &str) -> Result<Detail, Fault> {
        (**self).detail(id)
    }
}

fn body(bytes: &[u8], size: u64) -> Body {
    let truncated = (bytes.len() as u64) < size;
    match std::str::from_utf8(bytes) {
        Ok(text) => Body { encoding: "utf8".into(), data: text.to_string(), size, truncated },
        // Cut short mid-character, the text up to there is still text.
        Err(e) if truncated && e.error_len().is_none() => Body { encoding: "utf8".into(), data: String::from_utf8_lossy(&bytes[..e.valid_up_to()]).into_owned(), size, truncated },
        Err(_) => Body { encoding: "base64".into(), data: base64::engine::general_purpose::STANDARD.encode(bytes), size, truncated },
    }
}

fn header(headers: &[Header], name: &str) -> Option<String> {
    headers.iter().find(|h| h.name.eq_ignore_ascii_case(name)).map(|h| h.value.clone())
}

/// The host and the path with its query, from a full URL.
fn split_url(url: &str) -> (String, String) {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let at = rest.find(['/', '?']).unwrap_or(rest.len());
    let authority = &rest[..at];
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = match host.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(v6),
        None => host.split(':').next().unwrap_or(host),
    };
    let path = &rest[at..];
    (host.to_string(), if path.is_empty() || path.starts_with('?') { format!("/{path}") } else { path.to_string() })
}

/// A random (version 4) UUID, lower case: the shape the network_* tools expect of an id.
pub fn new_id() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("the system's random numbers");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start(r: &Recorder, url: &str) -> String {
        r.start(Start { method: "GET".into(), url: url.into(), headers: vec![Header { name: "Content-Type".into(), value: "text/plain".into() }], body: b"hi".to_vec() })
    }

    #[test]
    fn the_follower_reads_only_what_changed() {
        let r = Recorder::new();
        let a = start(&r, "https://api.example.com/items?page=2");
        let first = r.list(0).unwrap();
        assert_eq!(first.transactions.len(), 1);
        let tx = &first.transactions[0];
        assert_eq!((tx.host.as_str(), tx.path.as_str(), tx.state.as_str()), ("api.example.com", "/items?page=2", "pending"));
        assert_eq!(tx.request_content_type.as_deref(), Some("text/plain"));
        assert!(r.list(first.revision).unwrap().transactions.is_empty());

        r.respond(&a, 200, vec![Header { name: "content-type".into(), value: "application/json".into() }]);
        r.complete(&a, b"{\"ok\":true}".to_vec(), 11);
        let next = r.list(first.revision).unwrap();
        assert_eq!(next.transactions.len(), 1);
        assert_eq!(next.transactions[0].state, "completed");
        assert_eq!(next.instance, first.instance);

        let d = r.detail(&a).unwrap();
        assert_eq!(d.response_body.text(), Some("{\"ok\":true}"));
        assert_eq!(d.request_body.text(), Some("hi"));
        assert_eq!(r.detail("nope"), Err(Fault::NotFound));
    }

    #[test]
    fn bodies_that_arent_text_go_as_base64_and_cut_ones_say_so() {
        let r = Recorder::new();
        let a = start(&r, "http://example.com");
        r.complete(&a, vec![0xff, 0x00, 0x10], 3);
        let d = r.detail(&a).unwrap();
        assert_eq!((d.response_body.encoding.as_str(), d.response_body.data.as_str()), ("base64", "/wAQ"));
        assert_eq!(d.transaction.path, "/");

        let b = start(&r, "http://example.com");
        r.complete(&b, "é".as_bytes()[..1].to_vec(), 500);
        let d = r.detail(&b).unwrap();
        assert_eq!(d.response_body.text(), Some(""));
        assert!(d.response_body.truncated);
    }

    #[test]
    fn the_oldest_drop_off() {
        let r = Recorder::new();
        let first = start(&r, "http://example.com/0");
        for i in 1..=MAX_KEPT {
            start(&r, &format!("http://example.com/{i}"));
        }
        assert_eq!(r.list(0).unwrap().transactions.len(), MAX_KEPT);
        assert_eq!(r.detail(&first), Err(Fault::NotFound));
    }

    #[test]
    fn ids_are_uuids() {
        let id = new_id();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert_ne!(id, new_id());
    }
}
