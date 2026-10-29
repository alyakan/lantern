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
    /// Newest first.
    pub items: Vec<Artifact>,
}

/// The folders artifacts are served for, by key, and the theme `lantern.css` gives them.
#[derive(Default)]
pub struct Artifacts {
    keys: Mutex<HashMap<String, PathBuf>>,
    theme: Mutex<Vec<(String, String)>>,
}

impl Artifacts {
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

/// `path`, resolved, if it really is inside the folder's artifacts folder (not through a symlink out of it).
fn inside_artifacts(folder: &Path, path: &Path) -> Result<PathBuf, ()> {
    let root = folder.join(DIR).canonicalize().map_err(|_| ())?;
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
    let Ok(canonical_root) = root.canonicalize() else { return Vec::new() };
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
    if name.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return Err("That isn't an artifact.".into());
    }
    let full = inside_artifacts(folder, &folder.join(DIR).join(name)).map_err(|_| "That artifact is gone.".to_string())?;
    let meta = std::fs::metadata(&full).map_err(|e| e.to_string())?;
    if meta.len() > MAX_BYTES {
        return Err("That artifact is too big to show.".into());
    }
    std::fs::read_to_string(&full).map_err(|_| "That artifact isn't text.".to_string())
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
