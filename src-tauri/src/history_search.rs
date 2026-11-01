//! Full-text search over every past chat: what the user and Claude said (not tool results, thinking or file contents),
//! in the transcripts of every project (see history.rs). The query is literal text, compared without regard to case; it is
//! never a pattern and never a path. Transcripts are read line by line off the UI thread, newest first, within a time
//! budget; what was read is kept (bounded) so a repeated search doesn't read the files again.

use crate::history::{in_conversation, is_agent_folder, is_real_dir, is_temp, jsonl_files, modified_ms, prompt_text, title_of, title_record, valid_id, USER_ENTRYPOINTS};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MIN_QUERY_CHARS: usize = 2;
const MAX_QUERY_CHARS: usize = 200;
/// How much of a message a snippet shows around the match.
const SNIPPET_CHARS: usize = 120;
/// A line this long that holds only tool or thinking blocks is skipped without parsing it (see `skippable`).
const BIG_LINE: usize = 4096;

#[derive(Clone)]
pub struct Options {
    pub max_chats: usize,
    pub max_snippets: usize,
    /// After this long, the search returns what it has (flagged `partial`).
    pub budget: Duration,
    /// The most the kept text of read transcripts may take up.
    pub cache_bytes: usize,
    /// Transcripts bigger than this are searched as they are read and not kept.
    pub cache_file_max: u64,
    /// A line longer than this is skipped (a pasted file, a huge tool result).
    pub line_max: usize,
    /// Leave out chats of folders that are gone: they can't be opened.
    pub only_existing_folders: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self { max_chats: 200, max_snippets: 2, budget: Duration::from_secs(3), cache_bytes: 50 << 20, cache_file_max: 24 << 20, line_max: 8 << 20, only_existing_folders: true }
    }
}

/// What the search needs to know about the app: the titles it has given chats, and where folders moved to.
pub struct Scope<'a> {
    /// Titles Lantern made, and names the user gave (see history::summarize).
    pub titles: &'a HashMap<String, String>,
    pub renamed: &'a HashMap<String, String>,
    /// A folder's earlier places to where it is now.
    pub moved: &'a HashMap<String, String>,
}

/// A run of a snippet or a title; `hit` marks the text that matched.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Piece {
    pub text: String,
    pub hit: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Snippet {
    /// "user" or "assistant".
    pub role: &'static str,
    pub pieces: Vec<Piece>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChatHit {
    pub id: String,
    pub title: Vec<Piece>,
    /// The folder the chat opens in (where it was started, or where that folder is now).
    pub folder: String,
    /// The folder's name, for showing.
    pub project: String,
    pub updated_ms: u64,
    pub snippets: Vec<Snippet>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Results {
    /// Newest chat first.
    pub chats: Vec<ChatHit>,
    /// The search stopped (its limit, or its time) before it had read every chat.
    pub partial: bool,
    /// A newer search replaced this one.
    pub cancelled: bool,
}

/// One thing said in a chat, and the same lower-cased with each blank turned into a space (a character for a character, so a
/// position in one is a position in the other).
struct Msg {
    user: bool,
    text: String,
    folded: String,
}

#[derive(Clone)]
struct Meta {
    folder: String,
    custom: Option<String>,
    ai: Option<String>,
    first: String,
}

/// A transcript as read: `meta` is None for one that isn't a chat of the user's (plugin automation, no prompt typed).
struct Indexed {
    meta: Option<Meta>,
    messages: Vec<Msg>,
    bytes: usize,
}

struct Entry {
    key: (u64, u64),
    data: Arc<Indexed>,
    used: u64,
}

/// What was read of transcripts, by path and as they were (modified time and size), least recently used dropped first.
#[derive(Default)]
pub struct Index {
    entries: HashMap<PathBuf, Entry>,
    bytes: usize,
    clock: u64,
}

impl Index {
    fn get(&mut self, path: &Path, key: (u64, u64)) -> Option<Arc<Indexed>> {
        self.clock += 1;
        let clock = self.clock;
        let entry = self.entries.get_mut(path)?;
        if entry.key != key {
            return None;
        }
        entry.used = clock;
        Some(entry.data.clone())
    }

    fn put(&mut self, path: PathBuf, key: (u64, u64), data: Arc<Indexed>, limit: usize) {
        if let Some(old) = self.entries.remove(&path) {
            self.bytes -= old.data.bytes;
        }
        if data.bytes > limit {
            return;
        }
        self.clock += 1;
        self.bytes += data.bytes;
        self.entries.insert(path, Entry { key, data, used: self.clock });
        while self.bytes > limit {
            let Some(oldest) = self.entries.iter().min_by_key(|(_, e)| e.used).map(|(p, _)| p.clone()) else { break };
            if let Some(gone) = self.entries.remove(&oldest) {
                self.bytes -= gone.data.bytes;
            }
        }
    }
}

/// The search's shared state: what it has read, and the number of the newest search (an older one stops when it sees a
/// larger number than its own).
#[derive(Default)]
pub struct ChatSearch {
    pub index: Mutex<Index>,
    pub generation: AtomicU64,
}

/// A lower-cased character, one for one (so "İ" is "i"); a blank is a space.
fn fold_char(c: char) -> char {
    if c.is_whitespace() {
        ' '
    } else {
        c.to_lowercase().next().unwrap_or(c)
    }
}

fn fold(s: &str) -> String {
    s.chars().map(fold_char).collect()
}

/// `text` as runs, the matches of `needle` (already folded) marked.
pub(crate) fn highlight_text(text: &str, query: &str, excerpt: bool) -> Vec<Piece> {
    let chars: Vec<char> = text.chars().collect();
    let needle: Vec<char> = fold(query.trim()).chars().collect();
    if needle.is_empty() { return vec![Piece { text: text.into(), hit: false }]; }
    let folded: Vec<char> = chars.iter().copied().map(fold_char).collect();
    if excerpt {
        if let Some(at) = folded.windows(needle.len()).position(|w|w == needle.as_slice()) {
            let start = at.saturating_sub(60);
            return highlight(&chars[start..(at + needle.len() + 120).min(chars.len())], &needle);
        }
    }
    highlight(&chars, &needle)
}

fn highlight(text: &[char], needle: &[char]) -> Vec<Piece> {
    let shown: Vec<char> = text.iter().map(|&c| if c.is_whitespace() { ' ' } else { c }).collect();
    let folded: Vec<char> = text.iter().map(|&c| fold_char(c)).collect();
    let run = |from: usize, to: usize, hit: bool| Piece { text: shown[from..to].iter().collect(), hit };
    let mut pieces = Vec::new();
    let (mut at, mut start) = (0, 0);
    while at + needle.len() <= folded.len() {
        if folded[at..at + needle.len()] == *needle {
            if start < at {
                pieces.push(run(start, at, false));
            }
            pieces.push(run(at, at + needle.len(), true));
            at += needle.len();
            start = at;
        } else {
            at += 1;
        }
    }
    if start < shown.len() {
        pieces.push(run(start, shown.len(), false));
    }
    pieces
}

/// About `SNIPPET_CHARS` of `msg` around the match at character `at`, with "…" where it was cut.
fn snippet(msg: &Msg, at: usize, needle: &[char]) -> Snippet {
    let len = SNIPPET_CHARS.max(needle.len() + 40);
    let start = at.saturating_sub((len - needle.len()) / 2);
    let mut window: Vec<char> = msg.text.chars().skip(start).take(len + 1).collect();
    let more = window.len() > len;
    window.truncate(len);
    let mut pieces = highlight(&window, needle);
    if start > 0 {
        pieces.insert(0, Piece { text: "…".into(), hit: false });
    }
    if more {
        pieces.push(Piece { text: "…".into(), hit: false });
    }
    Snippet { role: if msg.user { "user" } else { "assistant" }, pieces }
}

/// Collects a chat's snippets from its messages, one per message that has the text, up to a limit.
struct Finder<'a> {
    needle: &'a str,
    chars: &'a [char],
    max: usize,
    found: Vec<Snippet>,
}

impl Finder<'_> {
    fn feed(&mut self, msg: &Msg) {
        if self.found.len() >= self.max {
            return;
        }
        if let Some(pos) = msg.folded.find(self.needle) {
            self.found.push(snippet(msg, msg.folded[..pos].chars().count(), self.chars));
        }
    }
}

/// What was said in a record: (is it the user's, its text).
fn message_of(r: &Value) -> Option<(bool, String)> {
    if let Some(text) = prompt_text(r) {
        return Some((true, text));
    }
    if r["type"] != "assistant" || !in_conversation(r) {
        return None;
    }
    let texts: Vec<&str> = r["message"]["content"].as_array()?.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect();
    let text = texts.join("\n");
    let text = text.trim();
    (!text.is_empty()).then(|| (false, text.to_string()))
}

/// A long line that is only a tool's input or output, or thinking, holds nothing to search: it isn't parsed. (A line with a
/// text block, or a long prompt typed as a plain string, has none of these markers and is.)
fn skippable(line: &[u8]) -> bool {
    if line.len() < BIG_LINE {
        return false;
    }
    let Ok(s) = std::str::from_utf8(line) else { return false };
    !s.contains("\"type\":\"text\"") && ["\"type\":\"tool_result\"", "\"type\":\"tool_use\"", "\"type\":\"thinking\""].iter().any(|m| s.contains(m))
}

enum Line {
    End,
    /// Longer than the limit: its rest was passed over.
    TooLong,
    Got,
}

/// The next line into `buf` (without ever holding more than `max` bytes of it).
fn read_line(reader: &mut BufReader<std::fs::File>, buf: &mut Vec<u8>, max: usize) -> std::io::Result<Line> {
    buf.clear();
    let n = reader.by_ref().take(max as u64).read_until(b'\n', buf)?;
    if n == 0 {
        return Ok(Line::End);
    }
    if buf.ends_with(b"\n") || n < max {
        return Ok(Line::Got);
    }
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            return Ok(Line::TooLong);
        }
        match chunk.iter().position(|&b| b == b'\n') {
            Some(i) => {
                reader.consume(i + 1);
                return Ok(Line::TooLong);
            }
            None => {
                let all = chunk.len();
                reader.consume(all);
            }
        }
    }
}

enum Scanned {
    Done(Option<Meta>),
    Unreadable,
    /// `stop` said so.
    Interrupted,
}

/// Reads a transcript line by line, handing each message to `on_message`. Stops at once for one that isn't a user's chat.
fn scan(path: &Path, line_max: usize, stop: &dyn Fn() -> bool, on_message: &mut dyn FnMut(Msg)) -> Scanned {
    let Ok(file) = std::fs::File::open(path) else { return Scanned::Unreadable };
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let (mut folder, mut custom, mut ai, mut first) = (None, None, None, None);
    let mut lines = 0u32;
    loop {
        lines += 1;
        if lines.is_multiple_of(32) && stop() {
            return Scanned::Interrupted;
        }
        match read_line(&mut reader, &mut line, line_max) {
            Err(_) => return Scanned::Unreadable,
            Ok(Line::End) => break,
            Ok(Line::TooLong) => continue,
            Ok(Line::Got) => {}
        }
        if skippable(&line) {
            continue;
        }
        let Ok(r) = serde_json::from_slice::<Value>(&line) else { continue };
        if r.get("entrypoint").and_then(Value::as_str).is_some_and(|ep| !USER_ENTRYPOINTS.contains(&ep)) {
            return Scanned::Done(None);
        }
        if folder.is_none() {
            folder = r.get("cwd").and_then(Value::as_str).map(String::from);
        }
        match title_record(&r) {
            Some((true, t)) => custom = Some(t.trim().to_string()),
            Some((false, t)) => ai = Some(t.trim().to_string()),
            None => {}
        }
        if let Some((user, text)) = message_of(&r) {
            if user && first.is_none() {
                first = Some(text.clone());
            }
            let folded = fold(&text);
            on_message(Msg { user, text, folded });
        }
    }
    Scanned::Done(folder.zip(first).map(|(folder, first)| Meta { folder, custom, ai, first }))
}

/// Every transcript in every project directory, with when it changed and how big it is. Links are left out, as everywhere.
fn transcripts(root: &Path) -> Vec<(PathBuf, u64, u64)> {
    let Ok(dirs) = std::fs::read_dir(root) else { return vec![] };
    let mut files = Vec::new();
    for dir in dirs.filter_map(Result::ok).map(|e| e.path()).filter(|p| is_real_dir(p)) {
        for f in jsonl_files(&dir) {
            let size = std::fs::metadata(&f).map_or(0, |m| m.len());
            files.push((modified_ms(&f), size, f));
        }
    }
    files.sort_by_key(|(ms, _, _)| std::cmp::Reverse(*ms));
    files.into_iter().map(|(ms, size, f)| (f, ms, size)).collect()
}

fn size_of(meta: &Option<Meta>, messages: &[Msg]) -> usize {
    let own = meta.as_ref().map_or(0, |m| m.folder.len() + m.first.len() + m.custom.as_ref().map_or(0, String::len) + m.ai.as_ref().map_or(0, String::len));
    64 + own + messages.iter().map(|m| m.text.len() + m.folded.len() + 32).sum::<usize>()
}

/// The chats whose text has `query`, newest first. `cancelled` is asked as it goes: when it says so, the search stops.
pub fn search(root: &Path, query: &str, scope: &Scope, opts: &Options, index: &Mutex<Index>, cancelled: &dyn Fn() -> bool) -> Results {
    let query: String = query.trim().chars().take(MAX_QUERY_CHARS).collect();
    if query.chars().count() < MIN_QUERY_CHARS {
        return Results::default();
    }
    let needle = fold(&query);
    let chars: Vec<char> = needle.chars().collect();
    let started = Instant::now();
    let stop = || cancelled() || started.elapsed() >= opts.budget;
    let mut results = Results::default();
    let mut seen = HashSet::new();
    let files = transcripts(root);
    for (path, ms, size) in &files {
        if cancelled() {
            return Results { cancelled: true, ..Results::default() };
        }
        if started.elapsed() >= opts.budget || results.chats.len() >= opts.max_chats {
            results.partial = true;
            break;
        }
        let Some(id) = path.file_stem().map(|s| s.to_string_lossy().into_owned()).filter(|id| valid_id(id)) else { continue };
        if seen.contains(&id) {
            continue;
        }
        let mut finder = Finder { needle: &needle, chars: &chars, max: opts.max_snippets, found: Vec::new() };
        let key = (*ms, *size);
        let cached = index.lock().unwrap_or_else(|e| e.into_inner()).get(path, key);
        let meta: Option<Meta> = if let Some(read) = cached {
            read.messages.iter().for_each(|m| finder.feed(m));
            read.meta.clone()
        } else if *size <= opts.cache_file_max {
            let mut messages = Vec::new();
            match scan(path, opts.line_max, &stop, &mut |m| messages.push(m)) {
                Scanned::Done(meta) => {
                    messages.iter().for_each(|m| finder.feed(m));
                    let again = meta.clone();
                    let bytes = size_of(&meta, &messages);
                    index.lock().unwrap_or_else(|e| e.into_inner()).put(path.clone(), key, Arc::new(Indexed { meta, messages, bytes }), opts.cache_bytes);
                    again
                }
                Scanned::Unreadable => continue,
                Scanned::Interrupted => return interrupted(results, cancelled()),
            }
        } else {
            match scan(path, opts.line_max, &stop, &mut |m| finder.feed(&m)) {
                Scanned::Done(meta) => meta,
                Scanned::Unreadable => continue,
                Scanned::Interrupted => return interrupted(results, cancelled()),
            }
        };
        let Some(meta) = meta else { continue };
        seen.insert(id.clone());
        let folder = scope.moved.get(&meta.folder).unwrap_or(&meta.folder).clone();
        if is_temp(&meta.folder) || is_agent_folder(&meta.folder) || (opts.only_existing_folders && !Path::new(&folder).is_dir()) {
            continue;
        }
        let title = scope.renamed.get(&id).cloned().or(meta.custom).or(meta.ai).or_else(|| scope.titles.get(&id).cloned()).unwrap_or_else(|| title_of(&meta.first));
        let title_chars: Vec<char> = title.chars().collect();
        let title_pieces = highlight(&title_chars, &chars);
        if finder.found.is_empty() && !title_pieces.iter().any(|p| p.hit) {
            continue;
        }
        let project = Path::new(&folder).file_name().map_or_else(|| folder.clone(), |n| n.to_string_lossy().into_owned());
        results.chats.push(ChatHit { id, title: title_pieces, folder, project, updated_ms: *ms, snippets: finder.found });
    }
    results
}

/// The search was stopped while reading a transcript: by a newer search, or by the time it had.
fn interrupted(mut results: Results, cancelled: bool) -> Results {
    if cancelled {
        return Results { cancelled: true, ..Results::default() };
    }
    results.partial = true;
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::encode_folder;
    use serde_json::json;
    use std::cell::Cell;

    const FOLDER: &str = "/Users/me/src/acme-api";
    const A: &str = "0e08e6a5-357d-42eb-9b29-1fa38cbe1e5c";
    const B: &str = "1f19f7b6-468e-53fc-8c3a-2fb49cdf2f6d";

    fn user(text: &str) -> String {
        json!({"type": "user", "cwd": FOLDER, "entrypoint": "cli", "message": {"role": "user", "content": text}}).to_string()
    }
    fn assistant(text: &str) -> String {
        json!({"type": "assistant", "cwd": FOLDER, "entrypoint": "cli", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}).to_string()
    }
    fn tool_result(text: &str) -> String {
        json!({"type": "user", "cwd": FOLDER, "entrypoint": "cli", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": text}]}}).to_string()
    }

    /// Transcripts in one project directory, the n-th modified n seconds after the epoch.
    fn setup(files: &[(&str, Vec<String>)]) -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join(encode_folder(Path::new(FOLDER)));
        std::fs::create_dir_all(&dir).unwrap();
        for (i, (name, lines)) in files.iter().enumerate() {
            let p = dir.join(format!("{name}.jsonl"));
            std::fs::write(&p, lines.join("\n")).unwrap();
            let t = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_000 + i as u64);
            std::fs::File::options().write(true).open(&p).unwrap().set_modified(t).unwrap();
        }
        root
    }

    fn opts() -> Options {
        Options { only_existing_folders: false, ..Options::default() }
    }

    fn run(root: &Path, query: &str, opts: &Options, index: &Mutex<Index>) -> Results {
        let none = HashMap::new();
        search(root, query, &Scope { titles: &none, renamed: &none, moved: &none }, opts, index, &|| false)
    }

    fn find(root: &Path, query: &str) -> Results {
        run(root, query, &opts(), &Mutex::new(Index::default()))
    }

    fn text(pieces: &[Piece]) -> String {
        pieces.iter().map(|p| p.text.as_str()).collect()
    }
    fn hits(pieces: &[Piece]) -> Vec<&str> {
        pieces.iter().filter(|p| p.hit).map(|p| p.text.as_str()).collect()
    }

    #[test]
    fn finds_what_the_user_and_claude_said_but_not_tool_results() {
        let root = setup(&[
            (A, vec![user("Please fix the flaky login redirect"), assistant("The redirect loops back to /login."), tool_result("secret-token-in-a-tool-result")]),
            (B, vec![user("Something else entirely"), assistant("Nothing to see")]),
        ]);
        let r = find(root.path(), "redirect");
        assert_eq!(r.chats.len(), 1);
        let chat = &r.chats[0];
        assert_eq!(chat.id, A);
        assert_eq!(chat.folder, FOLDER);
        assert_eq!(chat.project, "acme-api");
        assert_eq!(chat.snippets.iter().map(|s| s.role).collect::<Vec<_>>(), ["user", "assistant"]);
        assert_eq!(hits(&chat.snippets[0].pieces), ["redirect"]);
        assert!(find(root.path(), "secret-token").chats.is_empty());
        assert!(!r.partial && !r.cancelled);
    }

    #[test]
    fn leaves_out_thinking_tool_inputs_and_subagent_turns() {
        let thinking = json!({"type": "assistant", "cwd": FOLDER, "entrypoint": "cli", "message": {"content": [{"type": "thinking", "thinking": "pondering zebra"}, {"type": "tool_use", "id": "t", "name": "Write", "input": {"content": "zebra in a file"}}]}}).to_string();
        let sidechain = json!({"type": "assistant", "cwd": FOLDER, "entrypoint": "cli", "isSidechain": true, "message": {"content": [{"type": "text", "text": "zebra from a subagent"}]}}).to_string();
        let root = setup(&[(A, vec![user("hello"), thinking, sidechain])]);
        assert!(find(root.path(), "zebra").chats.is_empty());
    }

    #[test]
    fn ignores_case_and_handles_unicode() {
        let root = setup(&[(A, vec![user("Straße ÉCOLE naïve"), assistant("ok")])]);
        assert_eq!(find(root.path(), "école").chats.len(), 1);
        assert_eq!(find(root.path(), "ÉCOLE NA").chats.len(), 1);
        let r = find(root.path(), "naïve");
        assert_eq!(hits(&r.chats[0].snippets[0].pieces), ["naïve"]);
        assert_eq!(text(&r.chats[0].snippets[0].pieces), "Straße ÉCOLE naïve");
    }

    #[test]
    fn a_query_is_literal_text_never_a_pattern() {
        let root = setup(&[(A, vec![user("run grep a.*( on it"), assistant("fine")]), (B, vec![user("just abc and abcd"), assistant("fine")])]);
        let r = find(root.path(), "a.*(");
        assert_eq!(r.chats.len(), 1);
        assert_eq!(r.chats[0].id, A);
        assert_eq!(hits(&r.chats[0].snippets[0].pieces), ["a.*("]);
        assert!(find(root.path(), "[").chats.is_empty());
        assert!(find(root.path(), "a|b").chats.is_empty());
        assert!(find(root.path(), "../..").chats.is_empty());
    }

    #[test]
    fn needs_two_characters() {
        let root = setup(&[(A, vec![user("a b c"), assistant("x")])]);
        assert_eq!(find(root.path(), "a"), Results::default());
        assert_eq!(find(root.path(), "  a ").chats.len(), 0);
        assert_eq!(find(root.path(), "a b").chats.len(), 1);
    }

    #[test]
    fn matches_across_a_line_break_and_the_title() {
        let titled = json!({"type": "ai-title", "aiTitle": "Tidy the Billing page"}).to_string();
        let root = setup(&[(A, vec![user("first line\nsecond line"), assistant("ok"), titled])]);
        // A line break is a space to the search.
        assert_eq!(find(root.path(), "line second").chats.len(), 1);
        assert_eq!(find(root.path(), "line sec").chats.len(), 1);
        let r = find(root.path(), "billing");
        assert_eq!(r.chats.len(), 1);
        assert_eq!(hits(&r.chats[0].title), ["Billing"]);
        assert!(r.chats[0].snippets.is_empty());
    }

    #[test]
    fn counts_lantern_notes_as_text_and_shortens_snippets_around_the_match() {
        let long = format!("{} needle {}", "word ".repeat(60), "tail ".repeat(60));
        let root = setup(&[(A, vec![user("[Lantern: the folder moved] please continue"), assistant(&long)])]);
        assert_eq!(find(root.path(), "folder moved").chats.len(), 1);
        let r = find(root.path(), "needle");
        let s = &r.chats[0].snippets[0];
        assert_eq!(s.role, "assistant");
        assert_eq!(hits(&s.pieces), ["needle"]);
        let shown = text(&s.pieces);
        assert!(shown.starts_with('…') && shown.ends_with('…'));
        assert!(shown.chars().count() <= SNIPPET_CHARS + 2);
    }

    #[test]
    fn marks_every_match_in_a_snippet_and_gives_two_snippets_a_chat() {
        let root = setup(&[(A, vec![user("cat and Cat"), assistant("a cat"), assistant("another cat"), user("cat four")])]);
        let r = find(root.path(), "cat");
        assert_eq!(r.chats[0].snippets.len(), 2);
        assert_eq!(hits(&r.chats[0].snippets[0].pieces), ["cat", "Cat"]);
    }

    #[test]
    fn lists_the_newest_chat_first_and_stops_at_the_limit() {
        let root = setup(&[(A, vec![user("shared words"), assistant("x")]), (B, vec![user("shared words too"), assistant("x")])]);
        let r = find(root.path(), "shared");
        assert_eq!(r.chats.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), [B, A]);
        let r = run(root.path(), "shared", &Options { max_chats: 1, ..opts() }, &Mutex::new(Index::default()));
        assert_eq!(r.chats.len(), 1);
        assert_eq!(r.chats[0].id, B);
        assert!(r.partial);
        let r = run(root.path(), "shared", &Options { max_chats: 2, ..opts() }, &Mutex::new(Index::default()));
        assert_eq!((r.chats.len(), r.partial), (2, false));
    }

    #[test]
    fn returns_what_it_has_when_the_time_is_up() {
        let root = setup(&[(A, vec![user("shared words"), assistant("x")])]);
        let r = run(root.path(), "shared", &Options { budget: Duration::ZERO, ..opts() }, &Mutex::new(Index::default()));
        assert!(r.chats.is_empty() && r.partial);
    }

    #[test]
    fn a_newer_search_cancels_an_older_one() {
        let root = setup(&[(A, vec![user("shared words"), assistant("x")]), (B, vec![user("shared words too"), assistant("x")])]);
        let none = HashMap::new();
        let scope = Scope { titles: &none, renamed: &none, moved: &none };
        let asked = Cell::new(0);
        let r = search(root.path(), "shared", &scope, &opts(), &Mutex::new(Index::default()), &|| {
            asked.set(asked.get() + 1);
            asked.get() > 1
        });
        assert!(r.cancelled && r.chats.is_empty());
        let r = search(root.path(), "shared", &scope, &opts(), &Mutex::new(Index::default()), &|| true);
        assert!(r.cancelled);
    }

    #[test]
    fn skips_a_transcript_it_cannot_read_and_keeps_going() {
        use std::os::unix::fs::PermissionsExt;
        let root = setup(&[(A, vec![user("shared words"), assistant("x")]), (B, vec![user("shared words too"), assistant("x")])]);
        let dir = root.path().join(encode_folder(Path::new(FOLDER)));
        std::fs::set_permissions(dir.join(format!("{B}.jsonl")), std::fs::Permissions::from_mode(0o000)).unwrap();
        let r = find(root.path(), "shared");
        // (A user running as root can read it anyway.)
        assert!(r.chats.iter().any(|c| c.id == A));
        assert!(!r.cancelled);
    }

    #[test]
    fn skips_bad_lines_and_other_kinds_of_session() {
        let automation = json!({"type": "user", "cwd": FOLDER, "entrypoint": "sdk-ts", "message": {"role": "user", "content": "automated shared words"}}).to_string();
        let root = setup(&[(A, vec!["not json".into(), user("shared words"), "{".into(), assistant("x")]), (B, vec![automation])]);
        let r = find(root.path(), "shared");
        assert_eq!(r.chats.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), [A]);
    }

    #[test]
    fn leaves_out_scratch_and_agent_folders_and_follows_a_moved_folder() {
        let scratch = json!({"type": "user", "cwd": "/tmp/scratch", "entrypoint": "cli", "message": {"role": "user", "content": "shared words"}}).to_string();
        let root = setup(&[(A, vec![scratch]), (B, vec![user("shared words"), assistant("x")])]);
        let r = find(root.path(), "shared");
        assert_eq!(r.chats.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), [B]);
        let none = HashMap::new();
        let moved = HashMap::from([(FOLDER.to_string(), "/Users/me/src/renamed-api".to_string())]);
        let r = search(root.path(), "shared", &Scope { titles: &none, renamed: &none, moved: &moved }, &opts(), &Mutex::new(Index::default()), &|| false);
        assert_eq!((r.chats[0].folder.as_str(), r.chats[0].project.as_str()), ("/Users/me/src/renamed-api", "renamed-api"));
        // A folder that is gone can't be opened, so its chats aren't listed (the default).
        let r = search(root.path(), "shared", &Scope { titles: &none, renamed: &none, moved: &none }, &Options::default(), &Mutex::new(Index::default()), &|| false);
        assert!(r.chats.is_empty());
    }

    #[test]
    fn titles_come_from_the_user_then_claude_then_lantern_then_the_first_message() {
        let custom = json!({"type": "custom-title", "customTitle": "My name"}).to_string();
        let root = setup(&[(A, vec![user("shared words"), custom]), (B, vec![user("shared words, first message")])]);
        let titles = HashMap::from([(B.to_string(), "Lantern's title".to_string())]);
        let renamed = HashMap::new();
        let none = HashMap::new();
        let r = search(root.path(), "shared", &Scope { titles: &titles, renamed: &renamed, moved: &none }, &opts(), &Mutex::new(Index::default()), &|| false);
        assert_eq!(text(&r.chats[1].title), "My name");
        assert_eq!(text(&r.chats[0].title), "Lantern's title");
    }

    #[test]
    fn a_repeated_search_uses_what_was_kept_until_the_file_changes() {
        let root = setup(&[(A, vec![user("shared words"), assistant("x")])]);
        let index = Mutex::new(Index::default());
        assert_eq!(run(root.path(), "shared", &opts(), &index).chats.len(), 1);
        assert_eq!(index.lock().unwrap().entries.len(), 1);
        let path = root.path().join(encode_folder(Path::new(FOLDER))).join(format!("{A}.jsonl"));
        // The kept text answers the second search: the file's content could be anything now, as long as its time and size hold.
        let before = std::fs::read(&path).unwrap();
        std::fs::write(&path, vec![b' '; before.len()]).unwrap();
        std::fs::File::options().write(true).open(&path).unwrap().set_modified(std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_000)).unwrap();
        assert_eq!(run(root.path(), "shared", &opts(), &index).chats.len(), 1);
        // A different size is a different file.
        std::fs::write(&path, "changed").unwrap();
        assert!(run(root.path(), "shared", &opts(), &index).chats.is_empty());
    }

    #[test]
    fn what_is_kept_stays_under_its_limit_and_drops_the_least_recently_used() {
        let root = setup(&[(A, vec![user("shared words"), assistant("x")]), (B, vec![user("shared words too"), assistant("y")])]);
        let one = Options { cache_bytes: 300, ..opts() };
        let index = Mutex::new(Index::default());
        run(root.path(), "shared", &one, &index);
        let kept = index.lock().unwrap();
        assert!(kept.bytes <= 300);
        assert_eq!(kept.entries.len(), 1);
        assert!(kept.entries.keys().next().unwrap().ends_with(format!("{A}.jsonl")));
        drop(kept);
        let none = Options { cache_bytes: 10, ..opts() };
        let index = Mutex::new(Index::default());
        assert_eq!(run(root.path(), "shared", &none, &index).chats.len(), 2);
        assert!(index.lock().unwrap().entries.is_empty());
    }

    #[test]
    fn a_big_transcript_is_searched_as_it_is_read_and_not_kept() {
        let root = setup(&[(A, vec![user("shared words"), assistant("x")])]);
        let index = Mutex::new(Index::default());
        let r = run(root.path(), "shared", &Options { cache_file_max: 1, ..opts() }, &index);
        assert_eq!(r.chats.len(), 1);
        assert!(index.lock().unwrap().entries.is_empty());
    }

    #[test]
    fn a_huge_line_is_passed_over_and_big_tool_lines_are_not_parsed() {
        let huge = user(&"x".repeat(2000));
        let big_tool = tool_result(&"needle ".repeat(1000));
        let root = setup(&[(A, vec![user("before shared"), huge, big_tool, user("after shared")])]);
        let r = run(root.path(), "shared", &Options { line_max: 1000, ..opts() }, &Mutex::new(Index::default()));
        assert_eq!(r.chats[0].snippets.len(), 2);
        assert!(skippable(tool_result(&"needle ".repeat(1000)).as_bytes()));
        assert!(!skippable(user(&"needle ".repeat(1000)).as_bytes()));
        assert!(find(root.path(), "needle").chats.is_empty());
    }

    #[test]
    fn ignores_files_that_are_not_sessions() {
        let root = setup(&[("notes", vec![user("shared words")]), (A, vec![user("shared words"), assistant("x")])]);
        let dir = root.path().join(encode_folder(Path::new(FOLDER)));
        std::fs::write(dir.join("readme.txt"), user("shared words")).unwrap();
        std::os::unix::fs::symlink(dir.join(format!("{A}.jsonl")), dir.join(format!("{B}.jsonl"))).unwrap();
        let r = find(root.path(), "shared");
        assert_eq!(r.chats.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), [A]);
    }

    /// Against real transcripts: LANTERN_PROJECTS=<~/.claude/projects> cargo test real_chat_search -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_chat_search() {
        let root = PathBuf::from(std::env::var("LANTERN_PROJECTS").expect("LANTERN_PROJECTS"));
        let index = Mutex::new(Index::default());
        for _ in 0..3 {
            let started = Instant::now();
            let r = run(&root, "redirect", &Options { only_existing_folders: false, ..Options::default() }, &index);
            println!("{} chats, partial {}, {:?}, kept {} MB", r.chats.len(), r.partial, started.elapsed(), index.lock().unwrap().bytes >> 20);
        }
    }

    #[test]
    fn a_missing_projects_folder_finds_nothing() {
        assert_eq!(find(Path::new("/nonexistent/lantern/projects"), "shared"), Results::default());
    }
}
