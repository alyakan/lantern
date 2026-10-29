//! Artifacts: pages Claude writes into a folder's `.lantern/artifacts/` (an architecture map, a flow, a chart, a report)
//! for the Artifacts tab to show. Markdown and Mermaid are drawn by the app itself; HTML and SVG are served from the
//! `lantern-artifact:` scheme into a sandboxed frame, so they can run their own scripts but can't reach the app, the
//! user's files or the network.
//!
//! A frame's address names its folder by a random key, never by its path: `lantern-artifact://localhost/<key>/<file>`.
//! The app gets a folder's key from `artifacts_list`, and the scheme serves only files that are really inside that
//! folder's artifacts folder (a symlink out of it is refused), with a strict Content-Security-Policy of its own.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::http::{header, Response, StatusCode};

pub const SCHEME: &str = "lantern-artifact";
/// Where a folder's artifacts live, from the folder.
pub const DIR: &str = ".lantern/artifacts";
/// The stylesheet every key serves, with the app's colours and fonts as CSS variables: `<link rel="stylesheet" href="lantern.css">`.
pub const THEME_FILE: &str = "lantern.css";
/// Bigger files aren't served: an artifact is a page, not a data dump.
const MAX_BYTES: u64 = 5 * 1024 * 1024;
/// How deep the list looks into subfolders of the artifacts folder.
const MAX_DEPTH: usize = 3;
/// Past this many files the list stops.
const MAX_LISTED: usize = 500;

/// What an artifact page may do: run its own inline scripts and styles, and show images and fonts it carries inline.
/// Nothing else: no requests, no frames from elsewhere, no forms, no plugins. `sandbox allow-scripts` repeats the
/// frame's own sandbox, so the page has an opaque origin even if something opened it outside its frame.
const CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' lantern-artifact:; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'; sandbox allow-scripts";

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Html,
    Svg,
    Markdown,
    Mermaid,
}

impl Kind {
    fn of(name: &str) -> Option<Kind> {
        let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
        match ext.as_str() {
            "html" | "htm" => Some(Kind::Html),
            "svg" => Some(Kind::Svg),
            "md" | "markdown" => Some(Kind::Markdown),
            "mmd" | "mermaid" => Some(Kind::Mermaid),
            _ => None,
        }
    }

    /// How a phone is told the kind: the same word the window's list uses.
    pub fn name(self) -> &'static str {
        match self {
            Kind::Html => "html",
            Kind::Svg => "svg",
            Kind::Markdown => "markdown",
            Kind::Mermaid => "mermaid",
        }
    }

    /// The kinds the scheme serves: the rest are read and drawn by the app.
    fn served(self) -> Option<&'static str> {
        match self {
            Kind::Html => Some("text/html; charset=utf-8"),
            Kind::Svg => Some("image/svg+xml"),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Artifact {
    /// From the artifacts folder, with `/` between folders: `maps/auth.html`.
    pub name: String,
    /// The full path, as the Files tab and the chat's edits name it.
    pub path: String,
    pub kind: Kind,
    /// Last changed, in milliseconds since 1970.
    pub modified: u64,
    pub size: u64,
}

#[derive(Debug, Serialize)]
pub struct Listing {
    /// The key the folder's frames are served under.
    pub key: String,
    /// Whether HTML may run its scripts: only once WebRTC and preconnect are off in the window (see `lock_down_webkit`).
    pub scripts: bool,
    /// Newest first.
    pub items: Vec<Artifact>,
}

/// The folders artifacts are served for, by key, and the theme `lantern.css` gives them.
#[derive(Default)]
pub struct Artifacts {
    keys: Mutex<HashMap<String, PathBuf>>,
    theme: Mutex<Vec<(String, String)>>,
    locked_down: AtomicBool,
}

impl Artifacts {
    /// Whether artifacts' scripts may run: the policy blocks every request a page makes, but not WebRTC or preconnect,
    /// which can reach any server; so scripts wait until those are off in the window (see `lock_down_webkit`).
    pub fn scripts_allowed(&self) -> bool {
        self.locked_down.load(Ordering::SeqCst)
    }

    /// The folder's key, made the first time it's asked for. Keys last until Lantern quits.
    pub fn key_for(&self, folder: &Path) -> Result<String, String> {
        let mut keys = self.keys.lock().unwrap();
        if let Some((key, _)) = keys.iter().find(|(_, f)| f.as_path() == folder) {
            return Ok(key.clone());
        }
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
        let key: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        keys.insert(key.clone(), folder.to_path_buf());
        Ok(key)
    }

    fn folder_of(&self, key: &str) -> Option<PathBuf> {
        self.keys.lock().unwrap().get(key).cloned()
    }

    /// Keeps the app's current theme for `lantern.css`. Names must be CSS custom properties and values plain: anything
    /// else is dropped, so a value can't end its rule or load anything.
    pub fn set_theme(&self, vars: HashMap<String, String>) {
        let mut kept: Vec<(String, String)> = vars.into_iter().filter(|(name, value)| valid_var(name) && valid_value(value)).collect();
        kept.sort();
        *self.theme.lock().unwrap() = kept;
    }

    fn theme_css(&self) -> String {
        let vars: String = self.theme.lock().unwrap().iter().map(|(n, v)| format!("  {n}: {v};\n")).collect();
        format!(":root {{\n{vars}}}\n{BASE_CSS}")
    }

    /// Answers a `lantern-artifact:` request: `/<key>/lantern.css`, or `/<key>/<file>` for an HTML or SVG artifact.
    pub fn serve(&self, path: &str) -> Response<Vec<u8>> {
        match self.resolve(path) {
            Ok(Served::Theme) => respond(StatusCode::OK, "text/css; charset=utf-8", self.theme_css().into_bytes()),
            Ok(Served::File(full, mime)) => match std::fs::read(&full) {
                Ok(bytes) => respond(StatusCode::OK, mime, bytes),
                Err(_) => not_found(),
            },
            Err(()) => not_found(),
        }
    }

    fn resolve(&self, path: &str) -> Result<Served, ()> {
        let path = decode(path.trim_start_matches('/')).ok_or(())?;
        let (key, rest) = path.split_once('/').ok_or(())?;
        let folder = self.folder_of(key).ok_or(())?;
        // Beside any page, so a page in a subfolder links it the same way.
        if rest.rsplit('/').next() == Some(THEME_FILE) {
            return Ok(Served::Theme);
        }
        let mime = Kind::of(rest).and_then(Kind::served).ok_or(())?;
        if rest.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
            return Err(());
        }
        let full = inside_artifacts(&folder, &folder.join(DIR).join(rest))?;
        let meta = std::fs::metadata(&full).map_err(|_| ())?;
        if !meta.is_file() || meta.len() > MAX_BYTES {
            return Err(());
        }
        Ok(Served::File(full, mime))
    }
}

enum Served {
    Theme,
    File(PathBuf, &'static str),
}

/// Switches off what in the window's WebKit reaches the network around a page's Content-Security-Policy: WebRTC (a
/// script can reach any STUN or TURN server), `<link rel="preconnect">` (opens a connection, and looks up the host's name,
/// to any server) and DNS prefetching. Private preferences, each sent only if WebKit answers to it; they hold for every
/// frame made afterwards. Scripts are allowed only once WebRTC and preconnect are confirmed off; elsewhere, or when WebKit
/// lacks one of them, artifacts' HTML is shown without its scripts.
pub fn lock_down_webkit(window: &tauri::WebviewWindow, artifacts: std::sync::Arc<Artifacts>) {
    #[cfg(target_os = "macos")]
    {
        let _ = window.with_webview(move |webview| {
            // SAFETY: on macOS `inner` is the window's WKWebView, and this runs on the main thread.
            let off = unsafe { macos::lock_down(webview.inner()) };
            artifacts.locked_down.store(off, Ordering::SeqCst);
            if !off {
                eprintln!("[artifacts] couldn't switch WebRTC and preconnect off: artifacts' HTML is shown without its scripts");
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, artifacts);
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::runtime::{AnyClass, AnyObject, Sel};
    use objc2::{msg_send, sel};
    use std::ffi::CStr;

    /// WebKit features that would let a page reach a server its CSP doesn't cover. The first must be found.
    const PRECONNECT: &str = "LinkPreconnect";
    const ALSO_OFF: [&str; 2] = ["LinkPreconnectEarlyHintsEnabled", "LinkDNSPrefetchEnabled"];

    unsafe fn responds(object: *mut AnyObject, selector: Sel) -> bool {
        msg_send![object, respondsToSelector: selector]
    }

    /// Switches the features off on the WKWebView `view`; true when WebRTC and preconnect are confirmed off.
    ///
    /// # Safety
    /// `view` must be a live WKWebView, and this must run on the main thread. Every private selector is checked with
    /// `respondsToSelector:` before it is sent.
    pub unsafe fn lock_down(view: *mut std::ffi::c_void) -> bool {
        let view = view as *mut AnyObject;
        let config: *mut AnyObject = msg_send![view, configuration];
        let prefs: *mut AnyObject = msg_send![config, preferences];
        if prefs.is_null() {
            return false;
        }
        if responds(prefs, sel!(_setDNSPrefetchingEnabled:)) {
            let _: () = msg_send![prefs, _setDNSPrefetchingEnabled: false];
        }
        let webrtc_off = responds(prefs, sel!(_setPeerConnectionEnabled:)) && {
            let _: () = msg_send![prefs, _setPeerConnectionEnabled: false];
            let enabled: bool = msg_send![prefs, _peerConnectionEnabled];
            !enabled
        };
        let Some(class) = AnyClass::get(c"WKPreferences") else { return false };
        let class_responds: bool = msg_send![class, respondsToSelector: sel!(_features)];
        if !class_responds || !responds(prefs, sel!(_setEnabled:forFeature:)) || !responds(prefs, sel!(_isEnabledForFeature:)) {
            return false;
        }
        let features: *mut AnyObject = msg_send![class, _features];
        if features.is_null() {
            return false;
        }
        let count: usize = msg_send![features, count];
        let mut preconnect_off = false;
        for i in 0..count {
            let feature: *mut AnyObject = msg_send![features, objectAtIndex: i];
            let key: *mut AnyObject = msg_send![feature, key];
            if key.is_null() {
                continue;
            }
            let text: *const std::ffi::c_char = msg_send![key, UTF8String];
            if text.is_null() {
                continue;
            }
            let key = CStr::from_ptr(text).to_string_lossy();
            if key == PRECONNECT || ALSO_OFF.contains(&key.as_ref()) {
                let _: () = msg_send![prefs, _setEnabled: false, forFeature: feature];
                let enabled: bool = msg_send![prefs, _isEnabledForFeature: feature];
                if key == PRECONNECT {
                    preconnect_off = !enabled;
                }
            }
        }
        webrtc_off && preconnect_off
    }
}

/// The folder's artifacts folder, resolved, if it really is inside the folder: a cloned repository could ship
/// `.lantern/artifacts` (or `.lantern`) as a symlink to somewhere else.
fn artifacts_root(folder: &Path) -> Result<PathBuf, ()> {
    let folder = folder.canonicalize().map_err(|_| ())?;
    let root = folder.join(DIR).canonicalize().map_err(|_| ())?;
    if root.starts_with(&folder) {
        Ok(root)
    } else {
        Err(())
    }
}

/// `path`, resolved, if it really is inside the folder's artifacts folder (not through a symlink out of it).
fn inside_artifacts(folder: &Path, path: &Path) -> Result<PathBuf, ()> {
    let root = artifacts_root(folder)?;
    let full = path.canonicalize().map_err(|_| ())?;
    if full.starts_with(&root) {
        Ok(full)
    } else {
        Err(())
    }
}

fn respond(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header("Content-Security-Policy", CSP)
        .header("X-Content-Type-Options", "nosniff")
        .header("X-DNS-Prefetch-Control", "off")
        .header("Referrer-Policy", "no-referrer")
        .header(header::CACHE_CONTROL, "no-store")
        .body(body)
        .unwrap()
}

fn not_found() -> Response<Vec<u8>> {
    respond(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", b"Not found".to_vec())
}

/// Percent-decodes a URL path; None when it isn't valid UTF-8 or has a bad escape.
fn decode(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    let text = String::from_utf8(out).ok()?;
    // A query or fragment isn't part of the file's name.
    Some(text.split(['?', '#']).next().unwrap_or_default().to_string())
}

fn valid_var(name: &str) -> bool {
    name.len() <= 64 && name.starts_with("--") && name.len() > 2 && name[2..].chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn valid_value(value: &str) -> bool {
    value.len() <= 300 && !value.trim().is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || " #%(),./-_\"'".contains(c)) && !value.to_ascii_lowercase().contains("url(")
}

/// The folder's artifacts, newest first: every HTML, SVG, Markdown and Mermaid file under `.lantern/artifacts/`.
pub fn list(folder: &Path) -> Vec<Artifact> {
    let root = folder.join(DIR);
    let Ok(canonical_root) = artifacts_root(folder) else { return Vec::new() };
    let mut items = Vec::new();
    let walker = ignore::WalkBuilder::new(&root).hidden(true).git_ignore(false).git_global(false).git_exclude(false).ignore(false).max_depth(Some(MAX_DEPTH)).build();
    for entry in walker.filter_map(Result::ok) {
        if items.len() >= MAX_LISTED {
            break;
        }
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Some(kind) = Kind::of(&entry.file_name().to_string_lossy()) else { continue };
        // A symlink to somewhere else isn't an artifact of this folder.
        if !entry.path().canonicalize().is_ok_and(|p| p.starts_with(&canonical_root)) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(rel) = entry.path().strip_prefix(&root) else { continue };
        let name = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
        let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
        items.push(Artifact { name, path: entry.path().display().to_string(), kind, modified, size: meta.len() });
    }
    items.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.name.cmp(&b.name)));
    items
}

/// Reads a Markdown or Mermaid artifact for the app to draw.
pub fn read(folder: &Path, name: &str) -> Result<String, String> {
    let kind = Kind::of(name).ok_or("That isn't an artifact.")?;
    if kind.served().is_some() {
        return Err("HTML and SVG artifacts are shown in their frame.".into());
    }
    read_text(folder, name, MAX_BYTES)
}

fn read_text(folder: &Path, name: &str, max: u64) -> Result<String, String> {
    if name.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return Err("That isn't an artifact.".into());
    }
    let full = inside_artifacts(folder, &folder.join(DIR).join(name)).map_err(|_| "That artifact is gone.".to_string())?;
    let meta = std::fs::metadata(&full).map_err(|e| e.to_string())?;
    if meta.len() > max {
        return Err("That artifact is too big to show.".into());
    }
    std::fs::read_to_string(&full).map_err(|_| "That artifact isn't text.".to_string())
}

/// The most of an artifact's text a phone is sent.
pub const PHONE_MAX: u64 = 1024 * 1024;

/// An artifact's text for a phone. Any kind: the phone has no frame to serve from, so it draws HTML and SVG itself, in a web
/// view with scripts off and a policy that blocks every request (see mobile/src/screens/ArtifactsSheet.tsx). The policy
/// doesn't stop a page's `<link rel=preconnect>` or a link's host being looked up ahead of a tap, which reach a server
/// without a request the policy sees; so those are taken out here, where they are text, before the phone has the page.
pub fn read_for_phone(folder: &Path, name: &str) -> Result<String, String> {
    let kind = Kind::of(name).ok_or("That isn't an artifact.")?;
    let text = read_text(folder, name, PHONE_MAX)?;
    Ok(if kind.served().is_some() { defuse(&text) } else { text })
}

/// `html` with what makes a web view reach a server on its own taken out: every `<link`, `<base` and `<meta` tag (preconnect,
/// dns-prefetch, prefetch, preload, a stylesheet from elsewhere, a refresh to another page), and every `href`, `src`, `srcset`, `action`, `formaction`,
/// `poster`, `ping`, `data`, `background`, `manifest`, `profile` and `srcdoc` attribute that doesn't point at the page itself (`#...`)
/// or carry its data inline (`data:`). Plain text replacement of the exact tokens, not a parse: a parse can disagree with
/// the web view about where a tag begins (a comment, a quote that never closes), and a token the web view reads is a token
/// this sees. A page's own words that look like these are changed too, which is the price.
pub fn defuse(html: &str) -> String {
    use std::sync::OnceLock;
    static TAGS: OnceLock<regex::Regex> = OnceLock::new();
    static ATTRS: OnceLock<regex::Regex> = OnceLock::new();
    let tags = TAGS.get_or_init(|| regex::Regex::new(r"(?i)<(link|base|meta)\b").unwrap());
    let attrs = ATTRS.get_or_init(|| {
        regex::Regex::new(r#"(?i)(^|[^A-Za-z0-9_-])((?:[A-Za-z]+:)?(?:href|src|srcset|action|formaction|poster|ping|data|background|manifest|profile|srcdoc))(\s*=\s*)(["']?)(#|data:)?"#).unwrap()
    });
    let html = tags.replace_all(html, "<x-$1");
    attrs
        .replace_all(&html, |c: &regex::Captures| {
            let (lead, name, eq, quote) = (&c[1], &c[2], &c[3], &c[4]);
            match c.get(5) {
                // Its own fragment, or data it carries: kept as it was.
                Some(keep) => format!("{lead}{name}{eq}{quote}{}", keep.as_str()),
                None => format!("{lead}x-{}{eq}{quote}", name.replace(':', "-")),
            }
        })
        .into_owned()
}

/// Plain defaults under the theme's variables, so a page that only links `lantern.css` already looks like the app.
const BASE_CSS: &str = "html { color-scheme: var(--color-scheme, light dark); }
body { margin: 0; padding: 16px; background: var(--pane, Canvas); color: var(--text, CanvasText); font: 13px/1.5 var(--ui, -apple-system, sans-serif); }
h1, h2, h3 { line-height: 1.25; margin: 1.2em 0 0.5em; }
h1 { font-size: 20px; } h2 { font-size: 16px; } h3 { font-size: 14px; }
a { color: inherit; }
code, pre { font-family: var(--mono, ui-monospace, monospace); font-size: 12px; background: var(--code-bg, transparent); border-radius: var(--radius-inner, 4px); }
code { padding: 1px 4px; } pre { padding: 10px 12px; overflow: auto; }
table { border-collapse: collapse; } th, td { border: 1px solid var(--line, #ccc); padding: 4px 8px; text-align: left; }
hr { border: none; border-top: 1px solid var(--line, #ccc); }
svg { max-width: 100%; height: auto; }
";

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn folder() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(DIR).join("maps")).unwrap();
        dir
    }

    fn header<'a>(r: &'a Response<Vec<u8>>, name: &str) -> &'a str {
        r.headers().get(name).unwrap().to_str().unwrap()
    }

    #[test]
    fn a_phone_gets_every_kind_with_the_ways_a_page_reaches_a_server_on_its_own_taken_out() {
        let dir = folder();
        let page = r##"<!doctype html><meta http-equiv="refresh" content="0;url=http://evil.test/"><LINK rel=preconnect href="http://evil.test"><base href="http://evil.test/"><a href="https://evil.test/x">x</a><a href='#top'>top</a><img src="data:image/png;base64,AA=="><img src=http://evil.test/p.png><svg><use xlink:href="#a"/><image xlink:href="http://evil.test/i.png"/></svg><form action=http://evil.test><button formaction="http://evil.test">go</button></form><a data-src="x" href = "http://evil.test">y</a><iframe srcdoc="&lt;link rel=preconnect href=http://evil.test&gt;"></iframe><IFRAME SRCDOC='&#60;link rel=preconnect&#62;'></IFRAME>"##;
        fs::write(dir.path().join(DIR).join("page.html"), page).unwrap();
        fs::write(dir.path().join(DIR).join("notes.md"), "# notes\n[a link](https://example.com)").unwrap();
        fs::write(dir.path().join(DIR).join("flow.mmd"), "graph TD; A-->B").unwrap();
        let html = read_for_phone(dir.path(), "page.html").unwrap();
        for gone in ["<link", "<LINK", "<base", "<meta", " href=\"http", " href = \"http", " src=http", "xlink:href=\"http", " action=http", " formaction=\"http", " srcdoc=", " SRCDOC="] {
            assert!(!html.contains(gone), "{gone:?} is still in {html}");
        }
        // Its own fragments and its inline data stay, and a word that only looks like an attribute is left alone.
        assert!(html.contains("href='#top'") && html.contains("xlink:href=\"#a\"") && html.contains("src=\"data:image/png;base64,AA==\"") && html.contains("data-src=\"x\""), "{html}");
        // Markdown and Mermaid are text the phone draws: not changed.
        assert_eq!(read_for_phone(dir.path(), "notes.md").unwrap(), "# notes\n[a link](https://example.com)");
        assert_eq!(read_for_phone(dir.path(), "flow.mmd").unwrap(), "graph TD; A-->B");
    }

    #[test]
    fn a_phone_cant_read_outside_the_artifacts_or_a_big_one() {
        let dir = folder();
        fs::write(dir.path().join("secret.md"), "secret").unwrap();
        fs::write(dir.path().join(DIR).join("big.html"), "x".repeat(PHONE_MAX as usize + 1)).unwrap();
        for name in ["../secret.md", "/etc/passwd", "maps/../../secret.md", "", "maps//x.md", "nothing.md", "notes.txt", "a.json"] {
            assert!(read_for_phone(dir.path(), name).is_err(), "{name:?}");
        }
        assert_eq!(read_for_phone(dir.path(), "big.html").unwrap_err(), "That artifact is too big to show.");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path().join("secret.md"), dir.path().join(DIR).join("link.md")).unwrap();
            assert!(read_for_phone(dir.path(), "link.md").is_err(), "a symlink out of the folder");
        }
    }

    #[test]
    fn serves_html_and_svg_under_the_folders_key_with_a_strict_policy() {
        let dir = folder();
        fs::write(dir.path().join(DIR).join("maps/auth flow.html"), "<p>hi</p>").unwrap();
        fs::write(dir.path().join(DIR).join("chart.svg"), "<svg/>").unwrap();
        let a = Artifacts::default();
        let key = a.key_for(dir.path()).unwrap();
        assert_eq!(a.key_for(dir.path()).unwrap(), key, "one key per folder");
        let r = a.serve(&format!("/{key}/maps/auth%20flow.html"));
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.body(), b"<p>hi</p>");
        assert_eq!(header(&r, "content-type"), "text/html; charset=utf-8");
        let csp = header(&r, "content-security-policy");
        assert!(csp.starts_with("default-src 'none'"));
        assert!(csp.contains("sandbox allow-scripts"));
        assert!(!csp.contains("connect-src"), "no requests at all");
        assert_eq!(a.serve(&format!("/{key}/chart.svg")).status(), StatusCode::OK);
        assert_eq!(header(&a.serve(&format!("/{key}/chart.svg")), "content-type"), "image/svg+xml");
    }

    #[test]
    fn refuses_unknown_keys_other_kinds_and_paths_out_of_the_folder() {
        let dir = folder();
        fs::write(dir.path().join("secret.html"), "secret").unwrap();
        fs::write(dir.path().join(DIR).join("notes.md"), "# notes").unwrap();
        fs::write(dir.path().join(DIR).join("data.json"), "{}").unwrap();
        let a = Artifacts::default();
        let key = a.key_for(dir.path()).unwrap();
        for path in [
            "/nope/notes.md".to_string(),
            format!("/{key}/../../secret.html"),
            format!("/{key}/%2e%2e/%2e%2e/secret.html"),
            format!("/{key}/maps/../../../secret.html"),
            format!("/{key}//etc/passwd.html"),
            format!("/{key}/notes.md"),
            format!("/{key}/data.json"),
            format!("/{key}/missing.html"),
            format!("/{key}/bad%zz.html"),
        ] {
            assert_eq!(a.serve(&path).status(), StatusCode::NOT_FOUND, "{path}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_artifacts_folder_is_neither_served_nor_listed() {
        let dir = folder();
        fs::write(dir.path().join("secret.html"), "secret").unwrap();
        std::os::unix::fs::symlink(dir.path().join("secret.html"), dir.path().join(DIR).join("leak.html")).unwrap();
        std::os::unix::fs::symlink(dir.path(), dir.path().join(DIR).join("up")).unwrap();
        let a = Artifacts::default();
        let key = a.key_for(dir.path()).unwrap();
        assert_eq!(a.serve(&format!("/{key}/leak.html")).status(), StatusCode::NOT_FOUND);
        assert_eq!(a.serve(&format!("/{key}/up/secret.html")).status(), StatusCode::NOT_FOUND);
        assert!(list(dir.path()).is_empty());
        assert!(read(dir.path(), "up/secret.md").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn an_artifacts_folder_that_is_a_symlink_out_of_the_folder_is_ignored() {
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.html"), "secret").unwrap();
        fs::write(outside.path().join("notes.md"), "secret").unwrap();
        // .lantern/artifacts itself points away.
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".lantern")).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join(DIR)).unwrap();
        // .lantern points away, with an artifacts folder there.
        let other = tempfile::tempdir().unwrap();
        fs::create_dir_all(outside.path().join("artifacts")).unwrap();
        fs::write(outside.path().join("artifacts/secret.html"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.path(), other.path().join(".lantern")).unwrap();
        let a = Artifacts::default();
        for folder in [dir.path(), other.path()] {
            let key = a.key_for(folder).unwrap();
            assert!(list(folder).is_empty());
            assert_eq!(a.serve(&format!("/{key}/secret.html")).status(), StatusCode::NOT_FOUND);
            assert!(read(folder, "notes.md").is_err());
        }
    }

    #[test]
    fn the_theme_keeps_only_plain_variables() {
        let dir = folder();
        let a = Artifacts::default();
        let key = a.key_for(dir.path()).unwrap();
        a.set_theme(HashMap::from([
            ("--bg".to_string(), "#ffffff".to_string()),
            ("--ui".to_string(), "-apple-system, \"SF Pro Text\", sans-serif".to_string()),
            ("--shadow".to_string(), "0 1px 3px rgba(0, 0, 0, 0.06)".to_string()),
            ("--evil".to_string(), "red; } body { background: url(https://x.example/)".to_string()),
            ("--img".to_string(), "url(data)".to_string()),
            ("color".to_string(), "red".to_string()),
        ]));
        assert_eq!(a.serve(&format!("/{key}/maps/lantern.css")).status(), StatusCode::OK);
        let r = a.serve(&format!("/{key}/lantern.css"));
        assert_eq!(header(&r, "content-type"), "text/css; charset=utf-8");
        let css = String::from_utf8(r.body().clone()).unwrap();
        assert!(css.contains("--bg: #ffffff;"));
        assert!(css.contains("--ui: -apple-system, \"SF Pro Text\", sans-serif;"));
        assert!(css.contains("--shadow: 0 1px 3px rgba(0, 0, 0, 0.06);"));
        assert!(!css.contains("--evil") && !css.contains("x.example") && !css.contains("--img") && !css.contains("color: red"));
    }

    #[test]
    fn lists_artifacts_newest_first_and_reads_markdown_and_mermaid() {
        let dir = folder();
        let root = dir.path().join(DIR);
        fs::write(root.join("old.md"), "# old").unwrap();
        fs::write(root.join("skip.txt"), "no").unwrap();
        fs::write(root.join(".hidden.html"), "no").unwrap();
        fs::write(root.join("maps/flow.mmd"), "graph TD; a-->b").unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        fs::File::options().write(true).open(root.join("old.md")).unwrap().set_modified(old).unwrap();
        let items = list(dir.path());
        let names: Vec<_> = items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["maps/flow.mmd", "old.md"]);
        assert_eq!(items[0].kind, Kind::Mermaid);
        assert_eq!(read(dir.path(), "maps/flow.mmd").unwrap(), "graph TD; a-->b");
        assert!(read(dir.path(), "../x.md").is_err());
        assert!(list(&dir.path().join("nowhere")).is_empty());
    }
}
