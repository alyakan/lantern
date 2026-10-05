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
    regex::RegexBuilder::new(&body).case_insensitive(!q.case_sensitive).size_limit(1 << 22).build().map_err(|e| format!("That isn't a valid regular expression: {e}"))
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

/// The text of a file inside `root`, for the read-only preview.
pub fn read_file(root: &Path, path: &Path) -> Result<String, String> {
    let full = inside(root, path)?;
    let size = std::fs::metadata(&full).map_err(|e| e.to_string())?.len();
    if size > MAX_PREVIEW_BYTES {
        return Err(format!("This file is too large to preview ({} MB).", size / (1024 * 1024)));
    }
    let bytes = std::fs::read(&full).map_err(|e| e.to_string())?;
    if bytes.contains(&0) {
        return Err("This file is binary and can't be previewed.".into());
    }
    String::from_utf8(bytes).map_err(|_| "This file isn't UTF-8 text and can't be previewed.".into())
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
}
