//! Network Monitor (github.com/alyakan/network-monitor): the user's HTTPS proxy app. While it's open it serves what it
//! captured on a loopback API, with its port and a token in its support folder's api.json.
//!
//! Lantern reads it for two things: Claude's network_* tools (search the traffic, read one response, save a watch or a
//! summary), and the Network tab, which lists the requests matching the folder's watches as they happen. Watches and
//! summaries are kept per folder in network.json; the responses themselves stay in memory, never on disk.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The most matches kept for a folder, newest first; older ones drop off (their summaries are kept).
const MAX_MATCHES: usize = 300;
/// The most summaries kept for a folder.
const MAX_SUMMARIES: usize = 200;
/// A response body longer than this is kept cut short.
const MAX_KEPT_BODY: usize = 2 << 20;
/// The largest reply read from Network Monitor (5,000 requests' metadata is well under this).
const MAX_REPLY: u64 = 64 << 20;

// MARK: - Network Monitor's API

/// One captured request, as Network Monitor lists it (no headers or bodies).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
pub struct Tx {
    pub id: String,
    #[serde(default)]
    pub revision: u64,
    /// Milliseconds since 1970.
    pub started_at: f64,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub path: String,
    pub status: Option<u16>,
    pub duration_ms: Option<f64>,
    /// pending, completed or failed.
    pub state: String,
    pub error: Option<String>,
    pub request_content_type: Option<String>,
    pub response_content_type: Option<String>,
    #[serde(default)]
    pub request_size: u64,
    #[serde(default)]
    pub response_size: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct List {
    pub instance: String,
    pub revision: u64,
    pub transactions: Vec<Tx>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Header {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Body {
    /// utf8 or base64.
    pub encoding: String,
    pub data: String,
    pub size: u64,
    /// Cut short by Lantern (see MAX_KEPT_BODY).
    #[serde(default)]
    pub truncated: bool,
}

impl Body {
    pub fn text(&self) -> Option<&str> {
        (self.encoding == "utf8").then_some(self.data.as_str())
    }
}

/// One request with its headers and bodies.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
pub struct Detail {
    pub transaction: Tx,
    pub request_headers: Vec<Header>,
    pub request_body: Body,
    pub response_headers: Vec<Header>,
    pub response_body: Body,
}

/// Why Network Monitor couldn't be read.
#[derive(Debug, Clone, PartialEq)]
pub enum Fault {
    /// Not open (no api.json, or nothing listening): the user should start it.
    NotRunning,
    /// No such request (cleared, or past the 5,000 it keeps).
    NotFound,
    Other(String),
}

impl Fault {
    pub fn explain(&self) -> String {
        match self {
            Fault::NotRunning => "Network Monitor isn't running, so there's no captured traffic to read. Ask the user to open it (github.com/alyakan/network-monitor) and route their app's traffic through it.".into(),
            Fault::NotFound => "Network Monitor no longer has that request: it was cleared, or dropped past the 5,000 it keeps.".into(),
            Fault::Other(e) => format!("Couldn't read Network Monitor: {e}"),
        }
    }
}

/// Where the captured traffic comes from (Network Monitor's API; a fake in tests).
pub trait Source: Send + Sync {
    fn list(&self, since: u64) -> Result<List, Fault>;
    fn detail(&self, id: &str) -> Result<Detail, Fault>;
}

/// Network Monitor's loopback API, found through its api.json each time (it picks a new port every launch).
pub struct Api {
    info: PathBuf,
}

impl Api {
    pub fn new(info: PathBuf) -> Self {
        Self { info }
    }

    /// ~/Library/Application Support/NetworkMonitor/api.json
    pub fn default_info() -> Option<PathBuf> {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support/NetworkMonitor/api.json"))
    }

    fn get(&self, path: &str) -> Result<Value, Fault> {
        #[derive(Deserialize)]
        struct Info {
            port: u16,
            token: String,
        }
        let bytes = std::fs::read(&self.info).map_err(|_| Fault::NotRunning)?;
        let info: Info = serde_json::from_slice(&bytes).map_err(|e| Fault::Other(format!("its api.json doesn't read: {e}")))?;
        let addr = SocketAddr::from(([127, 0, 0, 1], info.port));
        let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(1)).map_err(|_| Fault::NotRunning)?;
        stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
        stream.set_write_timeout(Some(Duration::from_secs(5))).ok();
        let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nAccept: application/json\r\nConnection: close\r\n\r\n", info.port, info.token);
        stream.write_all(request.as_bytes()).map_err(|e| Fault::Other(e.to_string()))?;
        let mut reply = Vec::new();
        stream.take(MAX_REPLY).read_to_end(&mut reply).map_err(|e| Fault::Other(e.to_string()))?;
        let (status, body) = parse_reply(&reply).ok_or_else(|| Fault::Other("its reply isn't HTTP".into()))?;
        let value: Value = serde_json::from_slice(body).map_err(|e| Fault::Other(format!("its reply isn't JSON: {e}")))?;
        match status {
            200 => Ok(value),
            404 if path.starts_with("/v1/transactions/") => Err(Fault::NotFound),
            401 => Err(Fault::Other("it turned down Lantern's token (restart Network Monitor)".into())),
            _ => Err(Fault::Other(value["error"].as_str().map(String::from).unwrap_or_else(|| format!("HTTP {status}")))),
        }
    }
}

impl Source for Api {
    fn list(&self, since: u64) -> Result<List, Fault> {
        serde_json::from_value(self.get(&format!("/v1/transactions?since={since}"))?).map_err(|e| Fault::Other(e.to_string()))
    }

    fn detail(&self, id: &str) -> Result<Detail, Fault> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
            return Err(Fault::NotFound);
        }
        serde_json::from_value(self.get(&format!("/v1/transactions/{id}"))?).map_err(|e| Fault::Other(e.to_string()))
    }
}

/// The status code and body of an HTTP/1.1 reply (sent with Content-Length, then closed).
fn parse_reply(reply: &[u8]) -> Option<(u16, &[u8])> {
    let split = reply.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&reply[..split]).ok()?;
    let status = head.split_whitespace().nth(1)?.parse().ok()?;
    let mut body = &reply[split + 4..];
    let length = head.lines().find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.trim().parse::<usize>().ok()));
    if let Some(n) = length {
        body = &body[..n.min(body.len())];
    }
    Some((status, body))
}

// MARK: - Watches

/// A kind of request the user said matters, for one folder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Watch {
    pub label: String,
    /// GET, POST…; any method when None.
    pub method: Option<String>,
    /// Text the URL contains; `*` stands for anything (`api.example.com/*/items`). Case doesn't matter.
    pub url: String,
}

impl Watch {
    pub fn matches(&self, method: &str, url: &str) -> bool {
        if self.method.as_deref().is_some_and(|m| !m.eq_ignore_ascii_case(method)) {
            return false;
        }
        let url = url.to_lowercase();
        let mut rest = url.as_str();
        for part in self.url.to_lowercase().split('*').filter(|p| !p.is_empty()) {
            match rest.find(part) {
                Some(at) => rest = &rest[at + part.len()..],
                None => return false,
            }
        }
        true
    }
}

/// A summary Claude wrote of one response, with enough of the request to show after Network Monitor forgets it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Summary {
    pub id: String,
    pub method: String,
    pub url: String,
    pub status: Option<u16>,
    pub started_at: f64,
    /// Markdown.
    pub text: String,
    /// Milliseconds since 1970.
    pub written_at: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct FolderData {
    #[serde(default)]
    watches: Vec<Watch>,
    #[serde(default)]
    summaries: Vec<Summary>,
}

/// Watches and summaries by folder (its rule key), saved as JSON. A file that doesn't parse is moved aside.
pub struct Store {
    path: Option<PathBuf>,
    data: Mutex<BTreeMap<String, FolderData>>,
}

impl Store {
    pub fn load(path: Option<PathBuf>) -> Self {
        let data = path.as_deref().map(read_store).unwrap_or_default();
        Self { path, data: Mutex::new(data) }
    }

    pub fn watches(&self, folder: &str) -> Vec<Watch> {
        self.data.lock().unwrap().get(folder).map(|d| d.watches.clone()).unwrap_or_default()
    }

    pub fn summaries(&self, folder: &str) -> Vec<Summary> {
        self.data.lock().unwrap().get(folder).map(|d| d.summaries.clone()).unwrap_or_default()
    }

    /// Every folder's watches, for matching new traffic.
    pub fn all_watches(&self) -> Vec<(String, Vec<Watch>)> {
        self.data.lock().unwrap().iter().filter(|(_, d)| !d.watches.is_empty()).map(|(f, d)| (f.clone(), d.watches.clone())).collect()
    }

    /// Adds a watch, or replaces the one with its label.
    pub fn watch(&self, folder: &str, watch: Watch) {
        self.change(folder, |d| match d.watches.iter_mut().find(|w| w.label.eq_ignore_ascii_case(&watch.label)) {
            Some(w) => *w = watch,
            None => d.watches.push(watch),
        });
    }

    /// Whether there was a watch with that label.
    pub fn unwatch(&self, folder: &str, label: &str) -> bool {
        let mut found = false;
        self.change(folder, |d| {
            let before = d.watches.len();
            d.watches.retain(|w| !w.label.eq_ignore_ascii_case(label));
            found = d.watches.len() != before;
        });
        found
    }

    /// Saves a summary, replacing an earlier one of the same request.
    pub fn summarize(&self, folder: &str, summary: Summary) {
        self.change(folder, |d| {
            d.summaries.retain(|s| s.id != summary.id);
            d.summaries.push(summary);
            if d.summaries.len() > MAX_SUMMARIES {
                d.summaries.drain(..d.summaries.len() - MAX_SUMMARIES);
            }
        });
    }

    fn change(&self, folder: &str, f: impl FnOnce(&mut FolderData)) {
        let mut data = self.data.lock().unwrap();
        f(data.entry(folder.to_string()).or_default());
        if data.get(folder).is_some_and(|d| d.watches.is_empty() && d.summaries.is_empty()) {
            data.remove(folder);
        }
        self.save(&data);
    }

    fn save(&self, data: &BTreeMap<String, FolderData>) {
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Written beside the file and renamed over it, so a write cut short can't leave a truncated file.
        let tmp = path.with_extension("json.tmp");
        if let Ok(json) = serde_json::to_string_pretty(data) {
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }
}

fn read_store(path: &Path) -> BTreeMap<String, FolderData> {
    let Ok(bytes) = std::fs::read(path) else { return BTreeMap::new() };
    serde_json::from_slice(&bytes).unwrap_or_else(|_| {
        let _ = std::fs::rename(path, path.with_extension("json.corrupt"));
        BTreeMap::new()
    })
}

// MARK: - Following the traffic

/// A request that matched one of a folder's watches. The detail comes once it has finished.
#[derive(Debug, Clone)]
struct Match {
    tx: Tx,
    watch: String,
    detail: Option<Arc<Detail>>,
}

/// Whether Network Monitor could be read last time.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Link {
    /// Not looked at yet (no folder has a watch).
    Unknown,
    Connected,
    NotRunning,
    Error { message: String },
}

impl From<&Fault> for Link {
    fn from(f: &Fault) -> Self {
        match f {
            Fault::NotRunning => Link::NotRunning,
            Fault::NotFound => Link::Connected,
            Fault::Other(e) => Link::Error { message: e.clone() },
        }
    }
}

struct Live {
    /// Network Monitor's run: a new one starts its revisions again.
    instance: Option<String>,
    /// The newest revision read.
    cursor: u64,
    link: Link,
    /// By folder, newest first.
    matches: HashMap<String, Vec<Match>>,
}

/// One row of the Network tab: a matched request, a summarized one, or both.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Item {
    pub tx: Tx,
    /// The watch it matched (None: only its summary is left).
    pub watch: Option<String>,
    pub summary: Option<Summary>,
    /// Its response is in Lantern's memory, so the tab can show it.
    pub has_response: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct View {
    pub link: Link,
    pub watches: Vec<Watch>,
    pub items: Vec<Item>,
}

/// Network Monitor as Lantern follows it: the store, what matched, and the source it reads.
pub struct Monitor {
    pub store: Store,
    source: Box<dyn Source>,
    live: Mutex<Live>,
    /// Told when a folder's tab has something new (the app emits an event).
    on_change: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}

impl Monitor {
    pub fn new(store: Store, source: Box<dyn Source>) -> Self {
        Self { store, source, live: Mutex::new(Live { instance: None, cursor: 0, link: Link::Unknown, matches: HashMap::new() }), on_change: Mutex::new(None) }
    }

    pub fn set_on_change(&self, f: impl Fn() + Send + Sync + 'static) {
        *self.on_change.lock().unwrap() = Some(Box::new(f));
    }

    fn changed(&self) {
        if let Some(f) = self.on_change.lock().unwrap().as_ref() {
            f();
        }
    }

    /// One poll, telling the app when there's something new (the background follower calls this).
    pub fn tick(&self) {
        if self.poll() {
            self.changed();
        }
    }

    /// Reads what changed in Network Monitor and matches it to every folder's watches. Returns whether anything did
    /// (a new or finished match, or the link going up or down). Does nothing while no folder has a watch.
    pub fn poll(&self) -> bool {
        let watches = self.store.all_watches();
        if watches.is_empty() {
            return false;
        }
        let since = self.live.lock().unwrap().cursor;
        let list = match self.source.list(since) {
            Ok(list) => list,
            Err(fault) => return self.set_link(Link::from(&fault)),
        };
        let mut changed = self.set_link(Link::Connected);
        let list = {
            let mut live = self.live.lock().unwrap();
            if live.instance.as_deref() != Some(list.instance.as_str()) && live.instance.is_some() && since > 0 {
                // Network Monitor restarted: everything it has now is new to us. The matches already kept stay.
                live.instance = Some(list.instance.clone());
                live.cursor = 0;
                drop(live);
                match self.source.list(0) {
                    Ok(list) => list,
                    Err(fault) => return self.set_link(Link::from(&fault)) || changed,
                }
            } else {
                live.instance = Some(list.instance.clone());
                list
            }
        };
        for tx in &list.transactions {
            for (folder, ws) in &watches {
                if let Some(w) = ws.iter().find(|w| w.matches(&tx.method, &tx.url)) {
                    changed |= self.record(folder, tx, &w.label);
                }
            }
        }
        self.live.lock().unwrap().cursor = list.revision;
        changed
    }

    fn set_link(&self, link: Link) -> bool {
        let mut live = self.live.lock().unwrap();
        let changed = live.link != link;
        live.link = link;
        changed
    }

    /// Keeps a match (with its response once it has finished). Whether that's new.
    fn record(&self, folder: &str, tx: &Tx, watch: &str) -> bool {
        {
            let live = self.live.lock().unwrap();
            let kept = live.matches.get(folder).and_then(|ms| ms.iter().find(|m| m.tx.id == tx.id));
            if kept.is_some_and(|m| m.tx.revision >= tx.revision && (m.detail.is_some() || tx.state == "pending")) {
                return false;
            }
        }
        let detail = if tx.state == "pending" { None } else { self.source.detail(&tx.id).ok().map(|d| Arc::new(trimmed(d))) };
        let mut live = self.live.lock().unwrap();
        let ms = live.matches.entry(folder.to_string()).or_default();
        ms.retain(|m| m.tx.id != tx.id);
        ms.push(Match { tx: tx.clone(), watch: watch.to_string(), detail });
        ms.sort_by(|a, b| b.tx.started_at.total_cmp(&a.tx.started_at));
        ms.truncate(MAX_MATCHES);
        true
    }

    /// Re-reads everything Network Monitor has, so a new watch finds the requests already captured.
    fn rescan(&self) {
        self.live.lock().unwrap().cursor = 0;
        self.poll();
        self.changed();
    }

    /// What the folder's Network tab shows: newest first, each match with its summary, then summaries of requests no
    /// longer matched or kept.
    pub fn view(&self, folder: &str) -> View {
        let live = self.live.lock().unwrap();
        let summaries = self.store.summaries(folder);
        let mut items: Vec<Item> = live.matches.get(folder).into_iter().flatten().map(|m| Item { tx: m.tx.clone(), watch: Some(m.watch.clone()), summary: summaries.iter().find(|s| s.id == m.tx.id).cloned(), has_response: m.detail.is_some() }).collect();
        for s in &summaries {
            if !items.iter().any(|i| i.tx.id == s.id) {
                items.push(Item { tx: summary_tx(s), watch: None, summary: Some(s.clone()), has_response: false });
            }
        }
        items.sort_by(|a, b| b.tx.started_at.total_cmp(&a.tx.started_at));
        View { link: live.link.clone(), watches: self.store.watches(folder), items }
    }

    /// A request's headers and bodies: the copy kept for the folder's tab, else Network Monitor's.
    pub fn detail(&self, folder: Option<&str>, id: &str) -> Result<Arc<Detail>, Fault> {
        let kept = {
            let live = self.live.lock().unwrap();
            let mut all = live.matches.iter().filter(|(f, _)| folder.is_none_or(|x| x == f.as_str())).flat_map(|(_, ms)| ms.iter());
            all.find(|m| m.tx.id == id).and_then(|m| m.detail.clone())
        };
        match kept {
            Some(d) => Ok(d),
            None => self.source.detail(id).map(|d| Arc::new(trimmed(d))),
        }
    }

    pub fn unwatch(&self, folder: &str, label: &str) -> bool {
        let found = self.store.unwatch(folder, label);
        if found {
            let mut live = self.live.lock().unwrap();
            if let Some(ms) = live.matches.get_mut(folder) {
                ms.retain(|m| !m.watch.eq_ignore_ascii_case(label));
            }
            drop(live);
            self.changed();
        }
        found
    }

    // MARK: - Claude's tools

    /// Runs one of the network_* tools for a chat in `folder`. The text is what Claude reads; Err is an error result.
    pub fn call(&self, folder: Option<&str>, tool: &str, args: &Value) -> Result<String, String> {
        let s = |k: &str| args[k].as_str().map(str::trim).filter(|v| !v.is_empty());
        let folder_or_err = || folder.ok_or_else(|| "This chat has no folder yet.".to_string());
        match tool {
            "network_requests" => {
                let list = self.source.list(0).map_err(|f| f.explain())?;
                let limit = args["limit"].as_u64().unwrap_or(25).clamp(1, 200) as usize;
                let query = s("query").map(str::to_lowercase);
                let method = s("method");
                let status = s("status");
                let found: Vec<&Tx> = list
                    .transactions
                    .iter()
                    .rev()
                    .filter(|t| query.as_ref().is_none_or(|q| t.url.to_lowercase().contains(q)))
                    .filter(|t| method.is_none_or(|m| t.method.eq_ignore_ascii_case(m)))
                    .filter(|t| status.is_none_or(|st| t.status.is_some_and(|code| code.to_string().starts_with(st)) || (st == "failed" && t.state == "failed")))
                    .collect();
                if found.is_empty() {
                    return Ok(format!("None of the {} requests Network Monitor has captured match.", list.transactions.len()));
                }
                let now = now_ms() as f64;
                let mut out = format!("{} of {} captured requests match, newest first{}:\n", found.len(), list.transactions.len(), if found.len() > limit { format!(" (showing {limit})") } else { String::new() });
                for t in found.iter().take(limit) {
                    out.push_str(&format!("{}  {}  {} {}  {}  ({}{})\n", t.id, ago(now - t.started_at), t.method, status_text(t), t.url, size_text(t.response_size), t.duration_ms.map(|d| format!(", {d:.0} ms")).unwrap_or_default()));
                }
                out.push_str("\nRead one with network_request and its id.");
                Ok(out)
            }
            "network_request" => {
                let id = s("id").ok_or("Give the request's id (from network_requests).")?;
                let id = self.resolve_id(folder, id)?;
                let detail = self.detail(folder, &id).map_err(|f| f.explain())?;
                let max = args["max_chars"].as_u64().unwrap_or(20_000).clamp(500, 200_000) as usize;
                describe(&detail, s("path"), max)
            }
            "network_watch" => {
                let folder = folder_or_err()?;
                let label = s("label").ok_or("Give the watch a label.")?;
                let url = s("url").ok_or("Give the URL text to match (`*` stands for anything).")?;
                if label.chars().count() > 60 || url.len() > 500 {
                    return Err("Keep the label under 60 characters and the URL pattern under 500.".into());
                }
                let method = s("method").map(str::to_uppercase);
                let watch = Watch { label: label.to_string(), method: method.clone(), url: url.to_string() };
                self.store.watch(folder, watch.clone());
                self.rescan();
                let link = self.live.lock().unwrap().link.clone();
                let matched = self.view(folder).items.iter().filter(|i| i.watch.as_deref() == Some(label)).count();
                let what = format!("{} {}", method.as_deref().unwrap_or("any method"), url);
                Ok(match link {
                    Link::Connected => format!("Watching \"{label}\" ({what}). {matched} captured request{} match so far; new ones show up in the Network tab as they happen.", if matched == 1 { "" } else { "s" }),
                    _ => format!("Watching \"{label}\" ({what}), saved for this folder. Network Monitor isn't running, so nothing has matched yet; requests show up in the Network tab once it is."),
                })
            }
            "network_unwatch" => {
                let folder = folder_or_err()?;
                let label = s("label").ok_or("Give the label of the watch to remove.")?;
                if self.unwatch(folder, label) { Ok(format!("Stopped watching \"{label}\".")) } else { Err(format!("There's no watch called \"{label}\" in this folder.")) }
            }
            "network_watches" => {
                let folder = folder_or_err()?;
                let view = self.view(folder);
                if view.watches.is_empty() {
                    return Ok("No watches in this folder yet. Save one with network_watch.".into());
                }
                let mut out = String::from("Watches in this folder:\n");
                for w in &view.watches {
                    let n = view.items.iter().filter(|i| i.watch.as_deref() == Some(w.label.as_str())).count();
                    out.push_str(&format!("- {}: {} {} ({n} matched)\n", w.label, w.method.as_deref().unwrap_or("any method"), w.url));
                }
                Ok(out)
            }
            "network_summarize" => {
                let folder = folder_or_err()?;
                let id = s("id").ok_or("Give the request's id.")?;
                let text = s("summary").ok_or("Give the summary (markdown).")?;
                let id = self.resolve_id(Some(folder), id)?;
                let tx = self.detail(Some(folder), &id).map(|d| d.transaction.clone()).or_else(|_| self.store.summaries(folder).into_iter().find(|s| s.id == id).map(|s| summary_tx(&s)).ok_or(Fault::NotFound)).map_err(|f| f.explain())?;
                self.store.summarize(folder, Summary { id: tx.id.clone(), method: tx.method.clone(), url: tx.url.clone(), status: tx.status, started_at: tx.started_at, text: text.to_string(), written_at: now_ms() });
                self.changed();
                Ok(format!("Saved. The summary of {} {} shows in the Network tab.", tx.method, tx.url))
            }
            _ => Err(format!("Lantern has no tool called {tool}.")),
        }
    }

    /// A full id from one or a unique start of one (at least 8 characters), among what's kept and what Network Monitor has.
    fn resolve_id(&self, folder: Option<&str>, id: &str) -> Result<String, String> {
        let id = id.to_lowercase();
        if id.len() == 36 {
            return Ok(id);
        }
        if id.len() < 8 {
            return Err("Give the request's whole id (or its first 8 characters at least).".into());
        }
        let mut ids: Vec<String> = folder.map(|f| self.view(f).items.into_iter().map(|i| i.tx.id).collect()).unwrap_or_default();
        if let Ok(list) = self.source.list(0) {
            ids.extend(list.transactions.into_iter().map(|t| t.id));
        }
        ids.sort();
        ids.dedup();
        let hits: Vec<&String> = ids.iter().filter(|i| i.starts_with(&id)).collect();
        match hits.as_slice() {
            [one] => Ok((*one).clone()),
            [] => Err(Fault::NotFound.explain()),
            _ => Err("More than one request's id starts with that: give the whole id.".into()),
        }
    }
}

/// A body past MAX_KEPT_BODY, cut short (on a character boundary) so a huge download doesn't sit in memory.
fn trimmed(mut d: Detail) -> Detail {
    for body in [&mut d.request_body, &mut d.response_body] {
        if body.data.len() > MAX_KEPT_BODY {
            let mut end = MAX_KEPT_BODY;
            while !body.data.is_char_boundary(end) {
                end -= 1;
            }
            body.data.truncate(end);
            body.truncated = true;
        }
    }
    d
}

fn summary_tx(s: &Summary) -> Tx {
    Tx { id: s.id.clone(), revision: 0, started_at: s.started_at, method: s.method.clone(), url: s.url.clone(), host: String::new(), path: String::new(), status: s.status, duration_ms: None, state: "completed".into(), error: None, request_content_type: None, response_content_type: None, request_size: 0, response_size: 0 }
}

// MARK: - What Claude reads

/// Headers whose values are credentials: shown as redacted, so they don't land in the conversation.
fn secret_header(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    matches!(n.as_str(), "authorization" | "proxy-authorization" | "cookie" | "set-cookie") || ["token", "secret", "api-key", "apikey", "password", "session"].iter().any(|w| n.contains(w))
}

fn headers_text(headers: &[Header]) -> String {
    if headers.is_empty() {
        return "  (none)\n".into();
    }
    headers.iter().map(|h| if secret_header(&h.name) { format!("  {}: <redacted, {} chars>\n", h.name, h.value.len()) } else { format!("  {}: {}\n", h.name, h.value) }).collect()
}

/// One request for Claude: the request line and outcome, headers (credentials redacted), the request body cut short,
/// and the response body: JSON pretty-printed (or the part at `path`), cut at `max` characters with its outline.
fn describe(d: &Detail, path: Option<&str>, max: usize) -> Result<String, String> {
    let t = &d.transaction;
    let mut out = format!("{} {} → {}", t.method, t.url, status_text(t));
    if let Some(ms) = t.duration_ms {
        out.push_str(&format!(" in {ms:.0} ms"));
    }
    out.push_str(&format!(", {}{}\n", size_text(d.response_body.size), t.response_content_type.as_deref().map(|c| format!(", {c}")).unwrap_or_default()));
    if let Some(e) = &t.error {
        out.push_str(&format!("Failed: {e}\n"));
    }
    out.push_str(&format!("id {}\n\nRequest headers:\n{}", t.id, headers_text(&d.request_headers)));
    if d.request_body.size > 0 {
        out.push_str(&format!("\nRequest body ({}):\n{}\n", size_text(d.request_body.size), body_text(&d.request_body, 2_000)));
    }
    out.push_str(&format!("\nResponse headers:\n{}", headers_text(&d.response_headers)));
    out.push_str(&format!("\nResponse body ({}):\n", size_text(d.response_body.size)));
    let json = d.response_body.text().and_then(|s| serde_json::from_str::<Value>(s).ok());
    match (json, path) {
        (Some(v), Some(p)) => {
            let part = at_path(&v, p).ok_or_else(|| format!("The response has nothing at {p:?}. Its outline:\n{}", outline(&v, 4, 3_000)))?;
            out.push_str(&format!("(the part at {p})\n"));
            out.push_str(&json_text(part, max));
        }
        (Some(v), None) => out.push_str(&json_text(&v, max)),
        (None, Some(_)) => return Err("That response isn't JSON, so it has no path to read.".into()),
        (None, None) => out.push_str(&body_text(&d.response_body, max)),
    }
    if d.response_body.truncated {
        out.push_str("\n(Lantern kept only the first 2 MB of this response.)");
    }
    Ok(out)
}

fn json_text(v: &Value, max: usize) -> String {
    let pretty = serde_json::to_string_pretty(v).unwrap_or_default();
    if pretty.len() <= max {
        return pretty;
    }
    format!("{}\n… cut at {max} of {} characters. Outline of the whole:\n{}\nRead a part with `path` (e.g. \"data.items[0]\"), or raise `max_chars`.", cut(&pretty, max), pretty.len(), outline(v, 4, 3_000))
}

fn body_text(b: &Body, max: usize) -> String {
    match b.text() {
        Some("") => "(empty)".into(),
        Some(text) if text.len() > max => format!("{}\n… cut at {max} of {} characters.", cut(text, max), text.len()),
        Some(text) => text.to_string(),
        None => format!("(binary, {})", size_text(b.size)),
    }
}

fn cut(s: &str, max: usize) -> &str {
    let mut end = max.min(s.len());
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// The value at a path like `data.items[0].name` (a leading `$` is allowed).
pub fn at_path<'a>(v: &'a Value, path: &str) -> Option<&'a Value> {
    let path = path.trim().trim_start_matches('$').trim_start_matches('.');
    let mut cur = v;
    for seg in path.split('.').filter(|s| !s.is_empty()) {
        let (key, mut rest) = match seg.find('[') {
            Some(i) => (&seg[..i], &seg[i..]),
            None => (seg, ""),
        };
        if !key.is_empty() {
            cur = cur.get(key)?;
        }
        while let Some(stripped) = rest.strip_prefix('[') {
            let close = stripped.find(']')?;
            cur = cur.get(stripped[..close].trim().parse::<usize>().ok()?)?;
            rest = &stripped[close + 1..];
        }
    }
    Some(cur)
}

/// The JSON's shape: keys and their types, arrays with their length and their first item's shape.
pub fn outline(v: &Value, depth: usize, max: usize) -> String {
    fn walk(v: &Value, depth: usize, indent: usize, out: &mut String) {
        let pad = "  ".repeat(indent);
        match v {
            Value::Object(map) if depth > 0 => {
                for (k, child) in map {
                    out.push_str(&format!("{pad}{k}: {}\n", kind(child)));
                    if matches!(child, Value::Object(_) | Value::Array(_)) {
                        walk(child, depth - 1, indent + 1, out);
                    }
                }
            }
            Value::Array(items) if depth > 0 => {
                if let Some(first) = items.first().filter(|f| f.is_object() || f.is_array()) {
                    out.push_str(&format!("{pad}[0]: {}\n", kind(first)));
                    walk(first, depth - 1, indent + 1, out);
                }
            }
            _ => {}
        }
    }
    fn kind(v: &Value) -> String {
        match v {
            Value::Null => "null".into(),
            Value::Bool(_) => "boolean".into(),
            Value::Number(_) => "number".into(),
            Value::String(_) => "string".into(),
            Value::Array(a) => format!("array of {}", a.len()),
            Value::Object(o) => format!("object ({} keys)", o.len()),
        }
    }
    let mut out = format!("{}\n", kind(v));
    walk(v, depth, 1, &mut out);
    if out.len() > max {
        format!("{}\n…", cut(&out, max))
    } else {
        out
    }
}

fn status_text(t: &Tx) -> String {
    match (t.state.as_str(), t.status) {
        ("pending", _) => "pending".into(),
        ("failed", _) => "failed".into(),
        (_, Some(code)) => code.to_string(),
        _ => "?".into(),
    }
}

fn size_text(bytes: u64) -> String {
    match bytes {
        0 => "empty".into(),
        b if b < 1024 => format!("{b} B"),
        b if b < 1 << 20 => format!("{:.1} KB", b as f64 / 1024.0),
        b => format!("{:.1} MB", b as f64 / (1 << 20) as f64),
    }
}

fn ago(ms: f64) -> String {
    let s = (ms / 1000.0).max(0.0) as u64;
    match s {
        0..=59 => format!("{s}s ago"),
        60..=3599 => format!("{}m ago", s / 60),
        3600..=86399 => format!("{}h ago", s / 3600),
        _ => format!("{}d ago", s / 86400),
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The network_* tools' definitions, for the helper's tools/list.
pub fn tool_list() -> Vec<Value> {
    let id = json!({"type": "string", "description": "The request's id, as network_requests lists it (its first 8 characters are enough when they're unique)."});
    vec![
        json!({
            "name": "network_requests",
            "description": "Search the HTTP(S) traffic the user's Network Monitor app has captured (their app or device sends it through that proxy). Newest first: id, when, method, status, URL, size, time taken.",
            "inputSchema": {"type": "object", "properties": {
                "query": {"type": "string", "description": "Text the URL contains (host, path or query)."},
                "method": {"type": "string", "description": "GET, POST…"},
                "status": {"type": "string", "description": "A status code or its start (\"4\" for every 4xx), or \"failed\"."},
                "limit": {"type": "integer", "description": "How many to list (default 25, at most 200)."}
            }}
        }),
        json!({
            "name": "network_request",
            "description": "One captured request: its URL, status and timing, headers (credentials redacted), request body and response body. JSON is pretty-printed; a long one is cut, with an outline of its structure, and `path` reads just one part of it.",
            "inputSchema": {"type": "object", "properties": {
                "id": id,
                "path": {"type": "string", "description": "Only this part of a JSON response, e.g. \"data.items[0]\" or \"meta.pagination\"."},
                "max_chars": {"type": "integer", "description": "How much of the body to return (default 20000)."}
            }, "required": ["id"]}
        }),
        json!({
            "name": "network_watch",
            "description": "Save a watch for requests the user says matter, in this folder: Lantern's Network tab then lists every captured request that matches, live, with its response. A watch with the same label is replaced.",
            "inputSchema": {"type": "object", "properties": {
                "label": {"type": "string", "description": "A short name the user will recognise (\"Checklist list\")."},
                "url": {"type": "string", "description": "Text the URL contains; `*` stands for anything (\"api.example.com/v1/checklists*\"). Case doesn't matter."},
                "method": {"type": "string", "description": "Only this method; omit for any."}
            }, "required": ["label", "url"]}
        }),
        json!({
            "name": "network_unwatch",
            "description": "Remove one of this folder's watches.",
            "inputSchema": {"type": "object", "properties": {"label": {"type": "string"}}, "required": ["label"]}
        }),
        json!({
            "name": "network_watches",
            "description": "This folder's watches, and how many captured requests each has matched.",
            "inputSchema": {"type": "object", "properties": {}}
        }),
        json!({
            "name": "network_summarize",
            "description": "Show your summary of a response in the Network tab, on that request. Read it first with network_request. Write markdown for someone scanning: what the response holds (key fields and values, counts), then anything odd (nulls, errors, empty lists, unexpected values). Don't repeat the method, URL or status, or paste the raw JSON: the tab shows those around your summary.",
            "inputSchema": {"type": "object", "properties": {
                "id": id,
                "summary": {"type": "string", "description": "Markdown."}
            }, "required": ["id", "summary"]}
        }),
    ]
}

/// The tools' names, as the helper and the allowed-tools list need them.
pub const TOOLS: &[&str] = &["network_requests", "network_request", "network_watch", "network_unwatch", "network_watches", "network_summarize"];

#[cfg(test)]
mod tests {
    use super::*;

    fn tx(id: &str, revision: u64, method: &str, url: &str, state: &str) -> Tx {
        Tx { id: id.into(), revision, started_at: revision as f64 * 1000.0, method: method.into(), url: url.into(), host: String::new(), path: String::new(), status: (state == "completed").then_some(200), duration_ms: Some(12.0), state: state.into(), error: None, request_content_type: None, response_content_type: Some("application/json".into()), request_size: 0, response_size: 20 }
    }

    fn detail_of(t: &Tx, body: &str) -> Detail {
        Detail {
            transaction: t.clone(),
            request_headers: vec![Header { name: "Authorization".into(), value: "Bearer abc".into() }, Header { name: "Accept".into(), value: "*/*".into() }],
            request_body: Body { encoding: "utf8".into(), data: String::new(), size: 0, truncated: false },
            response_headers: vec![Header { name: "Content-Type".into(), value: "application/json".into() }],
            response_body: Body { encoding: "utf8".into(), data: body.into(), size: body.len() as u64, truncated: false },
        }
    }

    /// A Network Monitor in memory: its transactions, and how often its details were read.
    #[derive(Default)]
    struct Fake {
        instance: Mutex<String>,
        txs: Mutex<Vec<Tx>>,
        bodies: Mutex<HashMap<String, String>>,
        down: Mutex<bool>,
        detail_reads: Mutex<usize>,
    }

    impl Fake {
        fn add(&self, t: Tx, body: &str) {
            self.bodies.lock().unwrap().insert(t.id.clone(), body.into());
            let mut txs = self.txs.lock().unwrap();
            txs.retain(|x| x.id != t.id);
            txs.push(t);
        }
    }

    impl Source for Arc<Fake> {
        fn list(&self, since: u64) -> Result<List, Fault> {
            if *self.down.lock().unwrap() {
                return Err(Fault::NotRunning);
            }
            let txs = self.txs.lock().unwrap();
            let revision = txs.iter().map(|t| t.revision).max().unwrap_or(0);
            Ok(List { instance: self.instance.lock().unwrap().clone(), revision, transactions: txs.iter().filter(|t| t.revision > since).cloned().collect() })
        }
        fn detail(&self, id: &str) -> Result<Detail, Fault> {
            *self.detail_reads.lock().unwrap() += 1;
            let t = self.txs.lock().unwrap().iter().find(|t| t.id == id).cloned().ok_or(Fault::NotFound)?;
            let body = self.bodies.lock().unwrap().get(id).cloned().unwrap_or_default();
            Ok(detail_of(&t, &body))
        }
    }

    fn monitor() -> (Arc<Fake>, Monitor) {
        let fake = Arc::new(Fake::default());
        *fake.instance.lock().unwrap() = "run-1".into();
        (fake.clone(), Monitor::new(Store::load(None), Box::new(fake)))
    }

    const A: &str = "aaaaaaaa-0000-0000-0000-000000000001";
    const B: &str = "bbbbbbbb-0000-0000-0000-000000000002";

    #[test]
    fn a_watch_matches_text_in_the_url_with_stars_for_anything_and_its_method() {
        let w = Watch { label: "x".into(), method: None, url: "api.example.com/*/Checklists".into() };
        assert!(w.matches("GET", "https://API.example.com/v1/checklists?page=2"));
        assert!(!w.matches("GET", "https://api.example.com/checklists"));
        let posts = Watch { method: Some("POST".into()), url: "/checklists".into(), ..w };
        assert!(posts.matches("post", "https://a/checklists"));
        assert!(!posts.matches("GET", "https://a/checklists"));
    }

    #[test]
    fn nothing_is_read_until_a_folder_has_a_watch_then_matches_come_with_their_response() {
        let (fake, m) = monitor();
        fake.add(tx(A, 1, "GET", "https://api/v1/checklists", "completed"), r#"{"items":[1,2]}"#);
        assert!(!m.poll());
        assert_eq!(m.view("/p").link, Link::Unknown);
        m.call(Some("/p"), "network_watch", &json!({"label": "Checklists", "url": "/v1/checklists"})).unwrap();
        let view = m.view("/p");
        assert_eq!(view.link, Link::Connected);
        assert_eq!(view.items.len(), 1);
        assert!(view.items[0].has_response);
        assert_eq!(view.items[0].watch.as_deref(), Some("Checklists"));
        // Another folder sees none of it.
        assert!(m.view("/q").items.is_empty());
    }

    #[test]
    fn a_pending_match_gets_its_response_once_it_finishes_and_nothing_is_read_twice() {
        let (fake, m) = monitor();
        m.store.watch("/p", Watch { label: "c".into(), method: None, url: "/c".into() });
        fake.add(tx(A, 1, "GET", "https://x/c", "pending"), "");
        assert!(m.poll());
        assert!(!m.view("/p").items[0].has_response);
        assert_eq!(*fake.detail_reads.lock().unwrap(), 0);
        fake.add(tx(A, 2, "GET", "https://x/c", "completed"), "{}");
        assert!(m.poll());
        assert!(m.view("/p").items[0].has_response);
        assert!(!m.poll(), "nothing changed since");
        assert_eq!(*fake.detail_reads.lock().unwrap(), 1);
    }

    #[test]
    fn the_link_going_down_is_a_change_and_a_restarted_monitor_is_read_from_the_start() {
        let (fake, m) = monitor();
        m.store.watch("/p", Watch { label: "c".into(), method: None, url: "/c".into() });
        fake.add(tx(A, 5, "GET", "https://x/c", "completed"), "{}");
        m.poll();
        *fake.down.lock().unwrap() = true;
        assert!(m.poll());
        assert_eq!(m.view("/p").link, Link::NotRunning);
        // It comes back as a new run, its revisions starting again below where Lantern had read to.
        *fake.down.lock().unwrap() = false;
        *fake.instance.lock().unwrap() = "run-2".into();
        fake.txs.lock().unwrap().clear();
        fake.add(Tx { started_at: 9000.0, ..tx(B, 1, "GET", "https://x/c/2", "completed") }, "{}");
        assert!(m.poll());
        let ids: Vec<String> = m.view("/p").items.into_iter().map(|i| i.tx.id).collect();
        assert_eq!(ids, [B, A], "the new run's request, and the one kept from before");
    }

    #[test]
    fn a_summary_shows_on_its_request_and_outlasts_network_monitor_forgetting_it() {
        let (fake, m) = monitor();
        fake.add(tx(A, 1, "GET", "https://x/c", "completed"), "{}");
        m.call(Some("/p"), "network_watch", &json!({"label": "c", "url": "/c"})).unwrap();
        let reply = m.call(Some("/p"), "network_summarize", &json!({"id": &A[..8], "summary": "**2 items**"})).unwrap();
        assert!(reply.contains("https://x/c"), "{reply}");
        assert_eq!(m.view("/p").items[0].summary.as_ref().unwrap().text, "**2 items**");
        m.unwatch("/p", "c");
        fake.txs.lock().unwrap().clear();
        let view = m.view("/p");
        assert_eq!(view.items.len(), 1);
        assert!(!view.items[0].has_response && view.items[0].watch.is_none());
        assert_eq!(view.items[0].tx.url, "https://x/c");
    }

    #[test]
    fn requests_are_searched_newest_first_by_url_method_and_status() {
        let (fake, m) = monitor();
        fake.add(tx(A, 1, "GET", "https://x/users", "completed"), "{}");
        fake.add(tx(B, 2, "POST", "https://x/users", "failed"), "");
        let all = m.call(None, "network_requests", &json!({"query": "USERS"})).unwrap();
        assert!(all.find(B).unwrap() < all.find(A).unwrap(), "{all}");
        let failed = m.call(None, "network_requests", &json!({"status": "failed"})).unwrap();
        assert!(failed.contains(B) && !failed.contains(A));
        let none = m.call(None, "network_requests", &json!({"method": "DELETE"})).unwrap();
        assert!(none.starts_with("None of the 2"));
        *fake.down.lock().unwrap() = true;
        assert!(m.call(None, "network_requests", &json!({})).unwrap_err().contains("isn't running"));
    }

    #[test]
    fn a_request_reads_with_credentials_redacted_and_a_path_into_its_json() {
        let (fake, m) = monitor();
        fake.add(tx(A, 1, "GET", "https://x/c", "completed"), r#"{"data":{"items":[{"id":7,"name":"Fire safety"}]}}"#);
        let full = m.call(None, "network_request", &json!({"id": A})).unwrap();
        assert!(full.contains("Authorization: <redacted, 10 chars>") && !full.contains("Bearer abc"), "{full}");
        assert!(full.contains("\"name\": \"Fire safety\""));
        let part = m.call(None, "network_request", &json!({"id": A, "path": "data.items[0].name"})).unwrap();
        assert!(part.ends_with("\"Fire safety\""), "{part}");
        let missing = m.call(None, "network_request", &json!({"id": A, "path": "data.nope"})).unwrap_err();
        assert!(missing.contains("items: array of 1"), "{missing}");
    }

    #[test]
    fn a_long_response_is_cut_with_its_outline() {
        let (fake, m) = monitor();
        let items: Vec<Value> = (0..500).map(|i| json!({"id": i, "title": "x".repeat(40)})).collect();
        fake.add(tx(A, 1, "GET", "https://x/c", "completed"), &json!({"items": items, "total": 500}).to_string());
        let out = m.call(None, "network_request", &json!({"id": A, "max_chars": 1000})).unwrap();
        assert!(out.contains("cut at 1000 of"), "{out}");
        assert!(out.contains("items: array of 500") && out.contains("title: string") && out.contains("total: number"), "{out}");
    }

    #[test]
    fn watches_are_replaced_by_label_removed_and_kept_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("network.json");
        let store = Store::load(Some(path.clone()));
        store.watch("/p", Watch { label: "Users".into(), method: None, url: "/users".into() });
        store.watch("/p", Watch { label: "users".into(), method: Some("GET".into()), url: "/v2/users".into() });
        assert_eq!(Store::load(Some(path.clone())).watches("/p"), vec![Watch { label: "users".into(), method: Some("GET".into()), url: "/v2/users".into() }]);
        assert!(store.unwatch("/p", "USERS"));
        assert!(!store.unwatch("/p", "users"));
        assert!(Store::load(Some(path.clone())).all_watches().is_empty());
        std::fs::write(&path, "{not json").unwrap();
        assert!(Store::load(Some(path.clone())).all_watches().is_empty());
        assert!(dir.path().join("network.json.corrupt").exists());
    }

    #[test]
    fn an_http_reply_is_read_by_its_content_length() {
        let reply = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\ncontent-length: 2\r\n\r\n{}junk";
        assert_eq!(parse_reply(reply), Some((200, &b"{}"[..])));
        assert_eq!(parse_reply(b"nonsense"), None);
    }

    #[test]
    fn network_monitor_not_running_reads_as_such() {
        let dir = tempfile::tempdir().unwrap();
        let api = Api::new(dir.path().join("api.json"));
        assert_eq!(api.list(0).unwrap_err(), Fault::NotRunning);
        // A stale api.json, from a run that has quit: nothing listens on its port.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        std::fs::write(dir.path().join("api.json"), format!(r#"{{"port": {port}, "token": "t"}}"#)).unwrap();
        assert_eq!(api.list(0).unwrap_err(), Fault::NotRunning);
    }

    #[test]
    fn the_api_is_asked_with_its_token_and_its_list_read() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("api.json"), format!(r#"{{"port": {port}, "token": "secret"}}"#)).unwrap();
        let server = std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = conn.read(&mut buf).unwrap();
            let request = String::from_utf8_lossy(&buf[..n]).to_string();
            let body = r#"{"instance":"i","revision":3,"transactions":[{"id":"a","revision":3,"startedAt":1000,"method":"GET","url":"https://x/","status":200,"durationMs":5,"state":"completed","responseSize":2}]}"#;
            write!(conn, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            request
        });
        let list = Api::new(dir.path().join("api.json")).list(2).unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /v1/transactions?since=2 HTTP/1.1\r\n"), "{request}");
        assert!(request.contains("Authorization: Bearer secret\r\n"));
        assert_eq!((list.revision, list.transactions[0].status, list.transactions[0].response_size), (3, Some(200), 2));
    }
}
