use serde::Serialize;
use std::path::{Path, PathBuf};

/// Previews stop at this size; anything bigger is almost never something you want to read in a side pane.
const MAX_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;

/// Always hidden, even in folders without a .gitignore.
const ALWAYS_HIDDEN: &[&str] = &[".git", "node_modules", ".DS_Store"];

#[derive(Debug, Serialize, PartialEq)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub dir: bool,
}

/// Resolves `path` and checks it lies inside `root`, so the webview can't read arbitrary files.
fn inside(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let full = path.canonicalize().map_err(|e| e.to_string())?;
    if full.starts_with(&root) {
        Ok(full)
    } else {
        Err("That path is outside the open folder.".into())
    }
}

/// The direct children of `dir`, skipping gitignored entries. Folders first, then files, each sorted by name.
/// Paths are built from `dir` as given (not canonicalised) so they match the paths Claude reports edits under.
pub fn list_dir(root: &Path, dir: &Path) -> Result<Vec<Entry>, String> {
    inside(root, dir)?;
    let walker = ignore::WalkBuilder::new(dir).max_depth(Some(1)).hidden(false).require_git(false).build();
    let mut entries: Vec<Entry> = walker
        .filter_map(Result::ok)
        .filter(|e| e.depth() == 1)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if ALWAYS_HIDDEN.contains(&name.as_str()) {
                return None;
            }
            let dir_flag = e.file_type().is_some_and(|t| t.is_dir());
            Some(Entry { path: dir.join(&name).display().to_string(), name, dir: dir_flag })
        })
        .collect();
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

/// Past this many files a folder isn't listed further for search.
const MAX_INDEXED: usize = 200_000;

/// Every file under `root` the tree would show (gitignored and always-hidden ones left out), as paths from `root`.
pub fn all_files(root: &Path) -> Vec<String> {
    ignore::WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .filter_entry(|e| !ALWAYS_HIDDEN.contains(&e.file_name().to_string_lossy().as_ref()))
        .build()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
        .take(MAX_INDEXED)
        .filter_map(|e| e.path().strip_prefix(root).ok().map(|p| p.to_string_lossy().into_owned()))
        .collect()
}

/// A file search result: the file, and which characters of `rel` matched the query (to highlight).
#[derive(Debug, Serialize, PartialEq)]
pub struct Found {
    pub path: String,
    pub rel: String,
    pub hits: Vec<usize>,
}

/// Whether `c` starts a word in `s` at `i`: after a separator, or a lower-to-upper case change.
fn word_start(chars: &[char], i: usize) -> bool {
    i == 0 || matches!(chars[i - 1], '/' | '.' | '_' | '-' | ' ') || (chars[i - 1].is_lowercase() && chars[i].is_uppercase())
}

/// Fuzzy-matches `query` (lowercase, no spaces) against `text[from..]`, all its characters in order. Returns the score
/// and the matched character positions. Word starts and runs of consecutive characters score higher; gaps cost a bit.
fn subsequence(query: &[char], text: &[char], from: usize) -> Option<(i64, Vec<usize>)> {
    let mut hits = Vec::with_capacity(query.len());
    let mut score = 0i64;
    let mut at = from;
    for q in query {
        // Prefer the next word start that matches; otherwise the next plain match.
        let plain = (at..text.len()).find(|&i| text[i].to_lowercase().eq(q.to_lowercase()))?;
        let word = (plain..text.len()).find(|&i| word_start(text, i) && text[i].to_lowercase().eq(q.to_lowercase()) && !hits.last().is_some_and(|&l: &usize| l + 1 == plain));
        let i = match word {
            Some(w) if w - plain <= 12 => w,
            _ => plain,
        };
        score += 10;
        if word_start(text, i) {
            score += 15;
        }
        if hits.last().is_some_and(|&l| l + 1 == i) {
            score += 20;
        } else if let Some(&l) = hits.last() {
            score -= (i - l - 1).min(10) as i64;
        }
        hits.push(i);
        at = i + 1;
    }
    Some((score, hits))
}

/// How well `query` matches the path `rel`: best in the file name, then anywhere in the path. None when it doesn't.
pub fn score(query: &str, rel: &str) -> Option<(i64, Vec<usize>)> {
    let q: Vec<char> = query.chars().filter(|c| !c.is_whitespace()).collect();
    if q.is_empty() {
        return None;
    }
    let text: Vec<char> = rel.chars().collect();
    let name_from = text.iter().rposition(|c| *c == '/').map_or(0, |i| i + 1);
    let (base, hits) = if query.contains('/') {
        subsequence(&q, &text, 0)?
    } else if let Some((s, h)) = subsequence(&q, &text, name_from) {
        // All in the file name: it's what you were looking for. A name that starts with the query more so.
        let name: String = text[name_from..].iter().collect::<String>().to_lowercase();
        let query_lower: String = q.iter().collect::<String>().to_lowercase();
        let stem = name.rsplit_once('.').map_or(name.as_str(), |(stem, _)| stem);
        let exact = if stem == query_lower { 60 } else { 0 };
        (s + 100 + exact + if name.starts_with(&query_lower) { 50 } else { 0 }, h)
    } else {
        subsequence(&q, &text, 0)?
    };
    // Between equal matches, the shorter (shallower) path first.
    Some((base - (text.len() as i64) / 8, hits))
}

/// The best `limit` matches for `query` among `paths` (from `root`).
pub fn find(root: &Path, paths: &[String], query: &str, limit: usize) -> Vec<Found> {
    let mut scored: Vec<(i64, &String, Vec<usize>)> = paths.iter().filter_map(|p| score(query, p).map(|(s, h)| (s, p, h))).collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.len().cmp(&b.1.len())));
    scored.into_iter().take(limit).map(|(_, rel, hits)| Found { path: root.join(rel).display().to_string(), rel: rel.clone(), hits }).collect()
}

/// The file a mention in Claude's text means (`src/a.ts`, `./a.ts`, `/abs/path/a.ts`, `client/a.ts`, `a.ts`), as an
/// absolute path, if it's one of `paths` (files under `root`). A partial path or bare name matching several files
/// means the shallowest.
pub fn resolve(root: &Path, paths: &std::collections::HashSet<&str>, mention: &str) -> Option<String> {
    let mention = mention.trim().trim_start_matches("./");
    if mention.is_empty() {
        return None;
    }
    if mention.starts_with('/') {
        let rel = Path::new(mention).strip_prefix(root).ok()?.to_string_lossy().into_owned();
        return paths.contains(rel.as_str()).then(|| mention.to_string());
    }
    if paths.contains(mention) {
        return Some(root.join(mention).display().to_string());
    }
    let tail = format!("/{mention}");
    paths.iter().filter(|p| p.ends_with(&tail)).min_by_key(|p| (p.len(), p.to_string())).map(|p| root.join(p).display().to_string())
}

/// What to look for in files' text.
#[derive(Debug, serde::Deserialize)]
pub struct TextQuery {
    pub pattern: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    /// `pattern` is a regular expression rather than literal text.
    #[serde(default)]
    pub regex: bool,
}

/// A piece of a matching line: matched text or the text around it.
#[derive(Debug, Serialize, PartialEq)]
pub struct Piece {
    pub text: String,
    pub hit: bool,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct LineHit {
    /// 1-based.
    pub line: usize,
    pub pieces: Vec<Piece>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct FileHits {
    pub path: String,
    pub rel: String,
    pub lines: Vec<LineHit>,
    /// Matching lines past the ones listed.
    pub more: usize,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct TextResults {
    pub files: Vec<FileHits>,
    /// The search stopped at its limit: there are more matches than listed.
    pub truncated: bool,
}

const MAX_SEARCHED_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LINES_PER_FILE: usize = 50;
const MAX_LINES: usize = 2000;
/// Long lines (minified code) are cut to this much around their first match.
const LINE_WINDOW: usize = 240;

fn text_regex(q: &TextQuery) -> Result<regex::Regex, String> {
    let body = if q.regex { q.pattern.clone() } else { regex::escape(&q.pattern) };
    let body = if q.whole_word { format!(r"\b(?:{body})\b") } else { body };
    // ^ and $ are line starts and ends, as in an editor: the whole file is searched, not one line at a time. CRLF
    // files end their lines with \r\n, so $ has to match before the \r too.
    regex::RegexBuilder::new(&body).multi_line(true).crlf(true).case_insensitive(!q.case_sensitive).size_limit(1 << 22).build().map_err(|e| format!("That isn't a valid regular expression: {e}"))
}

/// A line split into matched and unmatched pieces; a long one cut to a window around its first match.
fn pieces(line: &str, re: &regex::Regex) -> Vec<Piece> {
    let first = re.find(line).map_or(0, |m| m.start());
    let (from, to) = if line.len() <= LINE_WINDOW {
        (0, line.len())
    } else {
        let from = line.floor_char_boundary(first.saturating_sub(LINE_WINDOW / 3));
        (from, line.floor_char_boundary((from + LINE_WINDOW).min(line.len())))
    };
    let shown = &line[from..to];
    let mut out = vec![];
    let mut at = 0;
    for m in re.find_iter(shown) {
        if m.start() == m.end() {
            continue;
        }
        if m.start() > at {
            out.push(Piece { text: shown[at..m.start()].to_string(), hit: false });
        }
        out.push(Piece { text: m.as_str().to_string(), hit: true });
        at = m.end();
    }
    if at < shown.len() {
        out.push(Piece { text: shown[at..].to_string(), hit: false });
    }
    if from > 0 {
        out.insert(0, Piece { text: "…".into(), hit: false });
    }
    if to < line.len() {
        out.push(Piece { text: "…".into(), hit: false });
    }
    out
}

/// Every line under `root` matching `q`, grouped by file (sorted by path), in the files the tree would show. Stops
/// early when `cancelled` says a newer search has started.
pub fn search_text(root: &Path, q: &TextQuery, cancelled: &(dyn Fn() -> bool + Sync)) -> Result<TextResults, String> {
    if q.pattern.is_empty() {
        return Ok(TextResults { files: vec![], truncated: false });
    }
    let re = text_regex(q)?;
    let found = std::sync::Mutex::new(Vec::<FileHits>::new());
    let total = std::sync::atomic::AtomicUsize::new(0);
    let truncated = std::sync::atomic::AtomicBool::new(false);
    ignore::WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .filter_entry(|e| !ALWAYS_HIDDEN.contains(&e.file_name().to_string_lossy().as_ref()))
        .build_parallel()
        .run(|| {
            Box::new(|entry| {
                use ignore::WalkState;
                use std::sync::atomic::Ordering;
                if cancelled() || total.load(Ordering::Relaxed) >= MAX_LINES {
                    if total.load(Ordering::Relaxed) >= MAX_LINES {
                        truncated.store(true, Ordering::Relaxed);
                    }
                    return WalkState::Quit;
                }
                let Ok(e) = entry else { return WalkState::Continue };
                if !e.file_type().is_some_and(|t| t.is_file()) || e.metadata().map_or(true, |m| m.len() > MAX_SEARCHED_BYTES) {
                    return WalkState::Continue;
                }
                let Ok(bytes) = std::fs::read(e.path()) else { return WalkState::Continue };
                if bytes.iter().take(8000).any(|b| *b == 0) {
                    return WalkState::Continue;
                }
                let text = String::from_utf8_lossy(&bytes);
                if !re.is_match(&text) {
                    return WalkState::Continue;
                }
                let matching: Vec<(usize, &str)> = text.lines().enumerate().filter(|(_, l)| re.is_match(l)).collect();
                if matching.is_empty() {
                    return WalkState::Continue;
                }
                let lines: Vec<LineHit> = matching.iter().take(MAX_LINES_PER_FILE).map(|(i, l)| LineHit { line: i + 1, pieces: pieces(l, &re) }).collect();
                total.fetch_add(lines.len(), Ordering::Relaxed);
                let rel = e.path().strip_prefix(root).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
                let more = matching.len() - lines.len();
                found.lock().unwrap().push(FileHits { path: e.path().display().to_string(), rel, lines, more });
                WalkState::Continue
            })
        });
    if cancelled() {
        return Err("cancelled".into());
    }
    let mut files = found.into_inner().unwrap();
    files.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(TextResults { files, truncated: truncated.into_inner() })
}

const BOM: &str = "\u{feff}";

/// The text of a file inside `root`, for the editor. A leading byte-order mark isn't part of the text the editor
/// shows (it keeps it aside); `write_file` puts it back.
pub fn read_file(root: &Path, path: &Path) -> Result<String, String> {
    let full = inside(root, path)?;
    let size = std::fs::metadata(&full).map_err(|e| e.to_string())?.len();
    if size > MAX_PREVIEW_BYTES {
        return Err(format!("This file is too large to open ({} MB).", size / (1024 * 1024)));
    }
    let bytes = std::fs::read(&full).map_err(|e| e.to_string())?;
    if bytes.contains(&0) {
        return Err("This file is binary and can't be opened.".into());
    }
    let text = String::from_utf8(bytes).map_err(|_| "This file isn't UTF-8 text and can't be opened.".to_string())?;
    Ok(text.strip_prefix(BOM).map(String::from).unwrap_or(text))
}

/// What saving a file came to.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Written {
    /// Written (or already that text). `previous` is what was on disk before, None for a new file; Rust-only.
    Saved {
        #[serde(skip)]
        previous: Option<String>,
        /// Whether anything was written.
        changed: bool,
    },
    /// The file isn't what the editor was based on: `current` is what's there now (None: it's gone). Nothing written.
    Conflict { current: Option<String> },
}

/// Resolves a file that may not exist yet: itself if it does, otherwise its folder (which must) plus its name.
fn inside_or_new(root: &Path, path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return inside(root, path);
    }
    let name = path.file_name().ok_or("That isn't a file path.")?;
    let parent = inside(root, path.parent().ok_or("That isn't a file path.")?)?;
    Ok(parent.join(name))
}

/// A new temporary file beside `target`, named for this process and a counter, never one that already exists.
fn create_temp(target: &Path) -> std::io::Result<(PathBuf, std::fs::File)> {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut last = None;
    for _ in 0..16 {
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = target.with_file_name(format!(".{name}.lantern-save-{}-{n}", std::process::id()));
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp) {
            Ok(f) => return Ok((tmp, f)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => last = Some(e),
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("no temporary name was free")))
}

/// Saves `text` as the file at `path` inside `root`, if the file is still what the editor opened it as: `expected` is
/// that text (None: the file shouldn't exist). Anything else on disk is a Conflict and nothing is written, so a save
/// never overwrites what changed meanwhile (Claude's edit, git). Writes go to a temporary file beside it, then replace
/// it, so a crash can't leave half a file, and keep its permissions and a byte-order mark it had. The check and the
/// replace are two steps: an edit that lands between them is overwritten (Claude's tools don't take this lock).
pub fn write_file(root: &Path, path: &Path, text: &str, expected: Option<&str>) -> Result<Written, String> {
    let full = inside_or_new(root, path)?;
    // Only a regular file: reading a pipe or device here would hang, and there's nothing to edit in one.
    if std::fs::metadata(&full).is_ok_and(|m| !m.is_file()) {
        return Err("That isn't a regular file.".into());
    }
    let disk = match std::fs::read(&full) {
        Ok(bytes) => Some(String::from_utf8(bytes).map_err(|_| "This file isn't UTF-8 text, so it can't be saved from here.".to_string())?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    let plain = |t: &Option<String>| t.as_deref().map(|t| t.strip_prefix(BOM).unwrap_or(t).to_string());
    let on_disk = plain(&disk);
    if on_disk.as_deref() != expected.map(|t| t.strip_prefix(BOM).unwrap_or(t)) {
        return Ok(Written::Conflict { current: on_disk });
    }
    if on_disk.as_deref() == Some(text) {
        return Ok(Written::Saved { previous: disk, changed: false });
    }
    let bom = disk.as_deref().is_some_and(|t| t.starts_with(BOM));
    let mut out = String::with_capacity(text.len() + 3);
    if bom {
        out.push_str(BOM);
    }
    out.push_str(text);
    // The temporary file is made new (O_EXCL: it fails if anything is there, a symlink planted at that name included, so
    // the write can't be led outside the folder), under a name no other save shares.
    let (tmp, mut file) = create_temp(&full).map_err(|e| format!("Couldn't save: {e}"))?;
    let mut write = || -> std::io::Result<()> {
        use std::io::Write;
        file.write_all(out.as_bytes())?;
        file.flush()?;
        // The bytes reach the disk before the rename can make them the file: a crash can't leave it empty or short.
        file.sync_all()?;
        if let Ok(meta) = std::fs::metadata(&full) {
            std::fs::set_permissions(&tmp, meta.permissions())?;
        }
        std::fs::rename(&tmp, &full)?;
        // And the rename itself is flushed to disk (best effort: not every filesystem allows syncing a folder).
        if let Some(dir) = full.parent().and_then(|d| std::fs::File::open(d).ok()) {
            let _ = dir.sync_all();
        }
        Ok(())
    };
    write().map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Couldn't save: {e}")
    })?;
    // `previous` is the file as it was, byte-order mark and all, which is what the change tracker compares with.
    Ok(Written::Saved { previous: disk, changed: true })
}

/// Saves an exported document at `path`, a place the user picked in the save dialog: not inside the chat's folder, so
/// not for `write_file`. Only a markdown file, so this can't be pointed at anything else (a dotfile, a script), and it
/// replaces what is there whole, through a temporary file beside it so a crash can't leave half a document.
pub fn write_export(path: &Path, text: &str) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("That isn't a full path.".into());
    }
    if !path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown")) {
        return Err("An export is saved as a .md file.".into());
    }
    if std::fs::metadata(path).is_ok_and(|m| !m.is_file()) {
        return Err("That isn't a regular file.".into());
    }
    let (tmp, mut file) = create_temp(path).map_err(|e| format!("Couldn't save: {e}"))?;
    let mut write = || -> std::io::Result<()> {
        use std::io::Write;
        file.write_all(text.as_bytes())?;
        file.flush()?;
        if let Ok(meta) = std::fs::metadata(path) {
            std::fs::set_permissions(&tmp, meta.permissions())?;
        }
        std::fs::rename(&tmp, path)
    };
    write().map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Couldn't save: {e}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn names(entries: &[Entry]) -> Vec<&str> {
        entries.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn lists_folders_first_and_respects_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join(".gitignore"), "target/\n*.log\n").unwrap();
        fs::write(root.join("b.ts"), "").unwrap();
        fs::write(root.join("A.md"), "").unwrap();
        fs::write(root.join("debug.log"), "").unwrap();
        fs::write(root.join(".DS_Store"), "").unwrap();
        for d in ["src", "target", ".git", "node_modules"] {
            fs::create_dir(root.join(d)).unwrap();
        }
        let entries = list_dir(root, root).unwrap();
        assert_eq!(names(&entries), vec!["src", ".gitignore", "A.md", "b.ts"]);
        assert!(entries[0].dir);
        assert_eq!(entries[0].path, root.join("src").display().to_string());
    }

    #[test]
    fn applies_parent_gitignore_in_subfolders() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join(".gitignore"), "*.gen.ts\n").unwrap();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(root.join("src/a.ts"), "").unwrap();
        fs::write(root.join("src/a.gen.ts"), "").unwrap();
        assert_eq!(names(&list_dir(root, &root.join("src")).unwrap()), vec!["a.ts"]);
    }

    #[test]
    fn refuses_paths_outside_the_root() {
        let outer = tempfile::tempdir().unwrap();
        let root = outer.path().join("project");
        fs::create_dir(&root).unwrap();
        fs::write(outer.path().join("secret.txt"), "no").unwrap();
        assert!(list_dir(&root, outer.path()).is_err());
        assert!(read_file(&root, &root.join("../secret.txt")).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outer.path().join("secret.txt"), root.join("link.txt")).unwrap();
            assert!(read_file(&root, &root.join("link.txt")).is_err());
        }
    }

    #[test]
    fn reads_text_and_rejects_binary() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.ts"), "export {};\n").unwrap();
        fs::write(root.join("img.png"), [0x89, b'P', b'N', b'G', 0, 1]).unwrap();
        assert_eq!(read_file(root, &root.join("a.ts")).unwrap(), "export {};\n");
        assert!(read_file(root, &root.join("img.png")).unwrap_err().contains("binary"));
    }

    #[test]
    fn indexes_every_file_but_ignored_and_hidden_ones() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join(".gitignore"), "dist/\n").unwrap();
        fs::create_dir_all(root.join("src/client")).unwrap();
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::create_dir_all(root.join("node_modules/x")).unwrap();
        fs::write(root.join("src/client/retry.ts"), "").unwrap();
        fs::write(root.join("dist/bundle.js"), "").unwrap();
        fs::write(root.join("node_modules/x/index.js"), "").unwrap();
        let mut files = all_files(root);
        files.sort();
        assert_eq!(files, vec![".gitignore", "src/client/retry.ts"]);
    }

    #[test]
    fn fuzzy_search_prefers_file_names_word_starts_and_short_paths() {
        let paths: Vec<String> = ["src/client/retry.ts", "src/client/retry.test.ts", "src/components/ReviewPanel.tsx", "docs/retrospective.md", "src/deep/nested/folder/retry.ts"].iter().map(|s| s.to_string()).collect();
        let root = Path::new("/p");
        let rels = |q: &str| find(root, &paths, q, 10).into_iter().map(|f| f.rel).collect::<Vec<_>>();
        // The name starting with the query wins, and the shallow one before the deep one.
        assert_eq!(rels("retry")[..3], ["src/client/retry.ts", "src/deep/nested/folder/retry.ts", "src/client/retry.test.ts"]);
        // Initials of words: ReviewPanel.
        assert_eq!(rels("rp")[0], "src/components/ReviewPanel.tsx");
        // Skipping characters.
        assert_eq!(rels("rtts")[0], "src/client/retry.test.ts");
        // A "/" matches along the path.
        assert_eq!(rels("comp/rev"), vec!["src/components/ReviewPanel.tsx"]);
        assert!(rels("zzz").is_empty());
        let hit = &find(root, &paths, "retry", 1)[0];
        assert_eq!((hit.path.as_str(), hit.hits.clone()), ("/p/src/client/retry.ts", vec![11, 12, 13, 14, 15]));
    }

    #[test]
    fn resolves_mentions_to_files_in_the_folder() {
        let paths: std::collections::HashSet<&str> = ["src/client/retry.ts", "src/server/retry.ts", "README.md", "ios/App/AppDelegate.swift"].into_iter().collect();
        let root = Path::new("/p");
        let r = |m: &str| resolve(root, &paths, m);
        assert_eq!(r("src/client/retry.ts").as_deref(), Some("/p/src/client/retry.ts"));
        assert_eq!(r("./README.md").as_deref(), Some("/p/README.md"));
        assert_eq!(r("/p/ios/App/AppDelegate.swift").as_deref(), Some("/p/ios/App/AppDelegate.swift"));
        assert_eq!(r("client/retry.ts").as_deref(), Some("/p/src/client/retry.ts"));
        assert_eq!(r("AppDelegate.swift").as_deref(), Some("/p/ios/App/AppDelegate.swift"));
        // Several files share the name: the shallowest (then the first by name).
        assert_eq!(r("retry.ts").as_deref(), Some("/p/src/client/retry.ts"));
        // Not files here: something that only looks like one, a path outside the folder, a partial name.
        for m in ["res.json", "/etc/hosts", "etry.ts", ""] {
            assert_eq!(r(m), None, "{m}");
        }
    }

    #[test]
    fn searches_text_by_word_case_and_regex_and_skips_ignored_and_binary_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join(".gitignore"), "dist/\n").unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(root.join("src/user.ts"), "class User {}\nconst userProfile = new User();\n// USER docs\n").unwrap();
        fs::write(root.join("src/other.ts"), "nothing here\n").unwrap();
        fs::write(root.join("dist/bundle.js"), "class User {}\n").unwrap();
        fs::write(root.join("blob.bin"), [0u8, b'U', b's', b'e', b'r']).unwrap();
        let never = || false;
        let q = |pattern: &str, case_sensitive: bool, whole_word: bool, regex: bool| TextQuery { pattern: pattern.into(), case_sensitive, whole_word, regex };
        let lines = |r: TextResults| r.files.iter().flat_map(|f| f.lines.iter().map(|l| format!("{}:{}", f.rel, l.line))).collect::<Vec<_>>();
        assert_eq!(lines(search_text(root, &q("user", false, false, false), &never).unwrap()), vec!["src/user.ts:1", "src/user.ts:2", "src/user.ts:3"]);
        assert_eq!(lines(search_text(root, &q("User", true, false, false), &never).unwrap()), vec!["src/user.ts:1", "src/user.ts:2"]);
        assert_eq!(lines(search_text(root, &q("user", false, true, false), &never).unwrap()), vec!["src/user.ts:1", "src/user.ts:2", "src/user.ts:3"]);
        assert_eq!(lines(search_text(root, &q("userProfile", true, true, false), &never).unwrap()), vec!["src/user.ts:2"]);
        assert_eq!(lines(search_text(root, &q("class \\w+ \\{", true, false, true), &never).unwrap()), vec!["src/user.ts:1"]);
        // Literal text isn't a pattern.
        assert!(search_text(root, &q("U.er", true, false, false), &never).unwrap().files.is_empty());
        let r = search_text(root, &q("User", true, false, false), &never).unwrap();
        assert_eq!(r.files[0].lines[1].pieces, vec![Piece { text: "const userProfile = new ".into(), hit: false }, Piece { text: "User".into(), hit: true }, Piece { text: "();".into(), hit: false }]);
        assert!(search_text(root, &q("(", false, false, true), &never).is_err());
        assert!(search_text(root, &q("user", false, false, false), &|| true).is_err());
    }

    #[test]
    fn anchors_match_at_every_line_not_only_the_first_and_last() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.ts"), "// header\nimport x from 'x';\n").unwrap();
        fs::write(root.join("b.ts"), "import y from 'y';\r\nconst z = 1;\r\n").unwrap();
        let never = || false;
        let q = |pattern: &str| TextQuery { pattern: pattern.into(), case_sensitive: true, whole_word: false, regex: true };
        let lines = |r: TextResults| r.files.iter().flat_map(|f| f.lines.iter().map(|l| format!("{}:{}", f.rel, l.line))).collect::<Vec<_>>();
        assert_eq!(lines(search_text(root, &q("^import"), &never).unwrap()), vec!["a.ts:2", "b.ts:1"]);
        // A CRLF file's line ends before its \r.
        assert_eq!(lines(search_text(root, &q("';$"), &never).unwrap()), vec!["a.ts:2", "b.ts:1"]);
    }

    /// Opt-in timing on a real folder: `LANTERN_SEARCH_ROOT=/path cargo test --lib real_search -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_search() {
        let root = std::path::PathBuf::from(std::env::var("LANTERN_SEARCH_ROOT").expect("set LANTERN_SEARCH_ROOT"));
        let t = std::time::Instant::now();
        let paths = all_files(&root);
        println!("{} files indexed in {:?}", paths.len(), t.elapsed());
        let t = std::time::Instant::now();
        let r = search_text(&root, &TextQuery { pattern: "FeatureFlag".into(), case_sensitive: true, whole_word: true, regex: false }, &|| false).unwrap();
        println!("text FeatureFlag: {:?}, {} files, {} lines, truncated {}", t.elapsed(), r.files.len(), r.files.iter().map(|f| f.lines.len()).sum::<usize>(), r.truncated);
        for q in ["user", "flagtest", "api/feat"] {
            let t = std::time::Instant::now();
            let found = find(&root, &paths, q, 60);
            println!("{q:>10}: {:?}, top: {:?}", t.elapsed(), found.iter().take(3).map(|f| f.rel.as_str()).collect::<Vec<_>>());
        }
    }

    #[test]
    fn saves_a_file_that_is_still_what_the_editor_opened_and_keeps_its_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("run.sh");
        fs::write(&f, "echo one\n").unwrap();
        fs::set_permissions(&f, fs::Permissions::from_mode(0o755)).unwrap();
        let r = write_file(dir.path(), &f, "echo two\n", Some("echo one\n")).unwrap();
        assert_eq!(r, Written::Saved { previous: Some("echo one\n".into()), changed: true });
        assert_eq!(fs::read_to_string(&f).unwrap(), "echo two\n");
        assert_eq!(fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o755);
        // No temporary file is left beside it.
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn writes_nothing_when_the_text_is_unchanged_and_keeps_line_endings_and_a_bom() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        fs::write(&f, "\u{feff}one\r\ntwo\r\n").unwrap();
        // The editor is given the text without the mark.
        assert_eq!(read_file(dir.path(), &f).unwrap(), "one\r\ntwo\r\n");
        let same = write_file(dir.path(), &f, "one\r\ntwo\r\n", Some("one\r\ntwo\r\n")).unwrap();
        assert_eq!(same, Written::Saved { previous: Some("\u{feff}one\r\ntwo\r\n".into()), changed: false });
        // `previous` is the file as it was, mark included (what the change tracker compares with).
        let r = write_file(dir.path(), &f, "one\r\nthree\r\n", Some("one\r\ntwo\r\n")).unwrap();
        assert_eq!(r, Written::Saved { previous: Some("\u{feff}one\r\ntwo\r\n".into()), changed: true });
        assert_eq!(fs::read(&f).unwrap(), "\u{feff}one\r\nthree\r\n".as_bytes());
    }

    #[test]
    fn a_save_never_overwrites_what_changed_meanwhile() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        fs::write(&f, "claude's version\n").unwrap();
        let r = write_file(dir.path(), &f, "mine\n", Some("what I opened\n")).unwrap();
        assert_eq!(r, Written::Conflict { current: Some("claude's version\n".into()) });
        assert_eq!(fs::read_to_string(&f).unwrap(), "claude's version\n");
        // Deleted meanwhile: a conflict too, with nothing there.
        fs::remove_file(&f).unwrap();
        assert_eq!(write_file(dir.path(), &f, "mine\n", Some("what I opened\n")).unwrap(), Written::Conflict { current: None });
        assert!(!f.exists());
        // Told it's gone (expected None), it makes the file again.
        assert_eq!(write_file(dir.path(), &f, "mine\n", None).unwrap(), Written::Saved { previous: None, changed: true });
        assert_eq!(fs::read_to_string(&f).unwrap(), "mine\n");
    }

    #[test]
    fn will_not_write_outside_the_folder_not_even_through_a_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, "keep\n").unwrap();
        let root = dir.path().join("proj");
        fs::create_dir(&root).unwrap();
        assert!(write_file(&root, &secret, "x", Some("keep\n")).is_err());
        std::os::unix::fs::symlink(&secret, root.join("link.txt")).unwrap();
        assert!(write_file(&root, &root.join("link.txt"), "x", Some("keep\n")).is_err());
        // A new file whose folder is outside, or through ".." — refused too.
        assert!(write_file(&root, &outside.path().join("new.txt"), "x", None).is_err());
        assert!(write_file(&root, &root.join("../escape.txt"), "x", None).is_err());
        assert_eq!(fs::read_to_string(&secret).unwrap(), "keep\n");
    }

    #[test]
    fn saving_through_a_symlink_inside_the_folder_updates_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.txt");
        fs::write(&real, "a\n").unwrap();
        std::os::unix::fs::symlink(&real, dir.path().join("link.txt")).unwrap();
        write_file(dir.path(), &dir.path().join("link.txt"), "b\n", Some("a\n")).unwrap();
        assert_eq!(fs::read_to_string(&real).unwrap(), "b\n");
        assert!(fs::symlink_metadata(dir.path().join("link.txt")).unwrap().file_type().is_symlink());
    }

    #[test]
    fn a_symlink_planted_where_the_temporary_file_would_go_is_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("victim.txt");
        fs::write(&target, "untouched\n").unwrap();
        let f = dir.path().join("a.txt");
        fs::write(&f, "one\n").unwrap();
        // Every name a save could try (the counter is shared with other tests), pointing out of the folder.
        for n in 0..512 {
            let name = format!(".a.txt.lantern-save-{}-{n}", std::process::id());
            std::os::unix::fs::symlink(&target, dir.path().join(name)).unwrap();
        }
        // It gives up rather than write through one of them.
        assert!(write_file(dir.path(), &f, "two\n", Some("one\n")).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "untouched\n");
        assert_eq!(fs::read_to_string(&f).unwrap(), "one\n");
    }

    #[test]
    fn refuses_something_that_is_not_a_regular_file_and_two_saves_at_once_dont_clash() {
        let dir = tempfile::tempdir().unwrap();
        assert!(write_file(dir.path(), dir.path(), "x", Some("")).is_err());
        let f = dir.path().join("a.txt");
        fs::write(&f, "start\n").unwrap();
        let (root, f2) = (dir.path().to_path_buf(), f.clone());
        let a = std::thread::spawn(move || write_file(&root, &f2, "from a\n", Some("start\n")));
        let b = write_file(dir.path(), &f, "from b\n", Some("start\n"));
        let a = a.join().unwrap();
        // One of them wins and the other sees a conflict or also saves; neither fails on a shared temporary file.
        for r in [a, b] {
            assert!(matches!(r, Ok(Written::Saved { .. }) | Ok(Written::Conflict { .. })), "{r:?}");
        }
        assert!(["from a\n", "from b\n"].contains(&fs::read_to_string(&f).unwrap().as_str()));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "no temporary file left behind");
    }

    #[test]
    fn export_writes_a_markdown_file_anywhere_the_user_picked_and_replaces_an_old_one() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("plan.md");
        write_export(&f, "# One\n").unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "# One\n");
        write_export(&f, "# Two\n").unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "# Two\n");
        write_export(&dir.path().join("Notes.MARKDOWN"), "x").unwrap();
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2, "no temporary file left behind");
    }

    #[test]
    fn export_refuses_other_kinds_of_file_relative_paths_and_missing_folders() {
        let dir = tempfile::tempdir().unwrap();
        assert!(write_export(&dir.path().join(".zshrc"), "x").is_err());
        assert!(write_export(&dir.path().join("run.sh"), "x").is_err());
        assert!(write_export(&dir.path().join("noext"), "x").is_err());
        assert!(write_export(Path::new("plan.md"), "x").is_err());
        assert!(write_export(&dir.path().join("missing").join("plan.md"), "x").is_err());
        let folder = dir.path().join("plan.md");
        fs::create_dir(&folder).unwrap();
        assert!(write_export(&folder, "x").is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
