//! Past sessions, read from Claude Code's own transcripts in `~/.claude/projects/<encoded folder>/<id>.jsonl`.
//! The transcript format is internal to Claude Code, so everything here is best-effort: unreadable lines are skipped.

use crate::stream_parser::StreamParser;
use crate::ui_event::UiEvent;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const TITLE_MAX: usize = 80;
/// Terminal sessions ("cli") and sessions started by Lantern ("sdk-cli"). Other SDK entrypoints are plugin automation.
const USER_ENTRYPOINTS: &[&str] = &["cli", "sdk-cli"];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub updated_ms: u64,
    pub prompts: usize,
}

pub struct Replay {
    pub events: Vec<UiEvent>,
    /// (path, content before the edit; None = created), in order
    pub edits: Vec<(String, Option<String>)>,
    /// How many of `edits` came before the transcript's last prompt: the rest are the last turn's.
    pub edits_before_last_turn: usize,
}

/// Claude Code names a project's folder after its path with every non-alphanumeric character replaced by '-'.
pub fn encode_folder(folder: &Path) -> String {
    folder.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// Session ids are UUIDs; anything else could be used for path traversal.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// The transcript directory for `folder`, falling back to scanning every project for a matching `cwd`.
pub fn project_dir(projects_root: &Path, folder: &Path) -> Option<PathBuf> {
    let direct = projects_root.join(encode_folder(folder));
    if direct.is_dir() {
        return Some(direct);
    }
    let want = folder.to_string_lossy();
    std::fs::read_dir(projects_root).ok()?.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.is_dir()).find(|dir| {
        jsonl_files(dir).into_iter().any(|f| records(&f).take(20).any(|r| r.get("cwd").and_then(Value::as_str) == Some(&want)))
    })
}

/// Where a folder's sessions are kept: its own project directory first, then the one of each place it was before (its
/// aliases, see relocate). A directory listed twice is listed once.
pub fn project_dirs(projects_root: &Path, folder: &Path, aliases: &[PathBuf]) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for f in std::iter::once(folder).chain(aliases.iter().map(PathBuf::as_path)) {
        if let Some(dir) = project_dir(projects_root, f) {
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
    }
    dirs
}

/// A file that is itself a file, not a link to one: a link in a project directory can point anywhere (the home folder, a
/// secret), so only real files are sessions.
pub fn is_regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_file())
}

/// A directory that is itself a directory, not a link to one (see is_regular_file).
pub fn is_real_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_dir())
}

fn jsonl_files(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "jsonl") && is_regular_file(p)).collect())
        .unwrap_or_default()
}

/// Every parseable JSON line of a transcript; bad lines are skipped. Bytes are read per line, so a line that isn't UTF-8
/// is just a bad line; a read error doesn't say where the next line starts, so reading stops there.
fn records(path: &Path) -> impl Iterator<Item = Value> {
    let mut reader = std::fs::File::open(path).map(BufReader::new).ok();
    std::iter::from_fn(move || {
        let reader = reader.as_mut()?;
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => return None,
                Ok(_) => {
                    if let Ok(v) = serde_json::from_slice::<Value>(&line) {
                        return Some(v);
                    }
                }
            }
        }
    })
}

/// False for records that aren't part of the visible conversation: injected meta content, subagent turns, and the
/// summary Claude Code writes when it compacts (the turns it summarizes are still earlier in the same file).
fn in_conversation(r: &Value) -> bool {
    let flag = |k: &str| r[k].as_bool() == Some(true);
    !(flag("isMeta") || flag("isSidechain") || flag("isCompactSummary") || flag("isVisibleInTranscriptOnly"))
}

/// The text of a record if it is something the user typed (not injected skill/hook content or a command tag).
fn prompt_text(r: &Value) -> Option<String> {
    if r["type"] != "user" || !in_conversation(r) {
        return None;
    }
    let content = &r["message"]["content"];
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => {
            let texts: Vec<&str> = blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect();
            if texts.is_empty() {
                return None;
            }
            texts.join("\n")
        }
        _ => return None,
    };
    let trimmed = without_lantern_note(text.trim()).trim();
    if trimmed.is_empty() || INJECTED_TAGS.iter().any(|t| trimmed.starts_with(t)) || trimmed.starts_with("[Request interrupted") {
        return None;
    }
    Some(trimmed.to_string())
}

/// The note Lantern puts in front of a message it sends (a revert's, a moved folder's): one block, then a blank line, then
/// what the user typed. It's not part of the prompt, so a replayed chat doesn't show it.
fn without_lantern_note(text: &str) -> &str {
    if !text.starts_with("[Lantern note:") {
        return text;
    }
    text.split_once("\n\n").map_or(text, |(_, rest)| rest)
}

/// Tags Claude Code and Lantern wrap around what they put in a user record (a command the user ran and its output, a
/// hook's or a reminder's text). A prompt the user typed that starts with another "<" is still a prompt.
const INJECTED_TAGS: &[&str] = &[
    "<command-name>",
    "<command-message>",
    "<command-args>",
    "<local-command-stdout>",
    "<local-command-stderr>",
    "<local-command-caveat>",
    "<bash-input>",
    "<bash-stdout>",
    "<bash-stderr>",
    "<system-reminder>",
    "<user-prompt-submit-hook>",
    "<task-notification>",
];

fn title_of(prompt: &str) -> String {
    let line = prompt.lines().next().unwrap_or("").trim();
    if line.chars().count() <= TITLE_MAX {
        line.to_string()
    } else {
        format!("{}…", line.chars().take(TITLE_MAX).collect::<String>().trim_end())
    }
}

/// The title Claude Code gave a record: a /rename (`custom-title`) or its own (`ai-title`).
fn title_record(r: &Value) -> Option<(bool, &str)> {
    let t = match r["type"].as_str()? {
        "custom-title" => (true, r["customTitle"].as_str()?),
        "ai-title" => (false, r["aiTitle"].as_str()?),
        _ => return None,
    };
    (!t.1.trim().is_empty()).then_some(t)
}

/// The session's title from its transcript: the latest /rename, else the latest title Claude Code made.
pub fn transcript_title(path: &Path) -> Option<String> {
    let (mut custom, mut ai) = (None, None);
    for r in records(path) {
        match title_record(&r) {
            Some((true, t)) => custom = Some(t.trim().to_string()),
            Some((false, t)) => ai = Some(t.trim().to_string()),
            None => {}
        }
    }
    custom.or(ai)
}

/// `titles`: the ones Lantern made, for sessions Claude Code didn't title (those run with `-p`). `renamed`: the names the
/// user gave in Lantern, which beat every other title. `folders`: the paths a session may have started in (the folder
/// and the places it was before).
fn summarize(path: &Path, folders: &[String], titles: &HashMap<String, String>, renamed: &HashMap<String, String>) -> Option<SessionSummary> {
    let mut prompts = 0;
    let mut first = None;
    let mut cwd_ok = false;
    let (mut custom, mut ai) = (None, None);
    for r in records(path) {
        match title_record(&r) {
            Some((true, t)) => custom = Some(t.trim().to_string()),
            Some((false, t)) => ai = Some(t.trim().to_string()),
            None => {}
        }
        // The folder it started in decides: a `cd` during the session moves later records' cwd, not the session.
        if let (false, Some(cwd)) = (cwd_ok, r.get("cwd").and_then(Value::as_str)) {
            if !folders.iter().any(|f| f == cwd) {
                return None;
            }
            cwd_ok = true;
        }
        if let Some(ep) = r.get("entrypoint").and_then(Value::as_str) {
            if !USER_ENTRYPOINTS.contains(&ep) {
                return None;
            }
        }
        if let Some(text) = prompt_text(&r) {
            prompts += 1;
            first.get_or_insert(text);
        }
    }
    let first = first?;
    if !cwd_ok {
        return None;
    }
    let updated_ms = std::fs::metadata(path).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
    let id = path.file_stem()?.to_string_lossy().into_owned();
    let title = renamed.get(&id).cloned().or(custom).or(ai).or_else(|| titles.get(&id).cloned()).unwrap_or_else(|| title_of(&first));
    Some(SessionSummary { id, title, updated_ms, prompts })
}

/// Sessions for `folder`, newest first. Sessions with no typed prompt (e.g. plugin automation) are left out.
pub fn list_sessions(projects_root: &Path, folder: &Path, titles: &HashMap<String, String>, renamed: &HashMap<String, String>) -> Vec<SessionSummary> {
    list_sessions_with_aliases(projects_root, folder, &[], titles, renamed)
}

/// Sessions for `folder` and for the places it was before (`aliases`), newest first. A session in more than one of those
/// directories is listed once, from the folder's own directory when it's there.
pub fn list_sessions_with_aliases(projects_root: &Path, folder: &Path, aliases: &[PathBuf], titles: &HashMap<String, String>, renamed: &HashMap<String, String>) -> Vec<SessionSummary> {
    let folders: Vec<String> = std::iter::once(folder).chain(aliases.iter().map(PathBuf::as_path)).map(|p| p.to_string_lossy().into_owned()).collect();
    let mut seen = std::collections::HashSet::new();
    let mut sessions: Vec<SessionSummary> = Vec::new();
    for dir in project_dirs(projects_root, folder, aliases) {
        for f in jsonl_files(&dir) {
            if let Some(s) = summarize(&f, &folders, titles, renamed) {
                if seen.insert(s.id.clone()) {
                    sessions.push(s);
                }
            }
        }
    }
    sessions.sort_by_key(|s| std::cmp::Reverse(s.updated_ms));
    sessions
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RecentFolder {
    pub path: String,
    pub updated_ms: u64,
}

fn modified_ms(path: &Path) -> u64 {
    std::fs::metadata(path).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}

/// The folder a transcript in the project directory `dir_name` belongs to, if the session was the user's own (terminal or
/// Lantern). A session moved from another folder and resumed here keeps the old folder as its first `cwd`, so the cwd
/// that encodes to this directory's name is preferred: it's the folder the directory is for.
fn user_session_cwd(path: &Path, dir_name: &str) -> Option<String> {
    let mut first = None;
    let mut own = None;
    for r in records(path).take(40) {
        if let Some(ep) = r.get("entrypoint").and_then(Value::as_str) {
            if !USER_ENTRYPOINTS.contains(&ep) {
                return None;
            }
        }
        if let Some(cwd) = r.get("cwd").and_then(Value::as_str) {
            if own.is_none() && encode_folder(Path::new(cwd)) == dir_name {
                own = Some(cwd.to_string());
            }
            first.get_or_insert_with(|| cwd.to_string());
        }
    }
    own.or(first)
}

/// Scratch folders (probes, tools' temp dirs) aren't projects anyone wants to reopen.
fn is_temp(path: &str) -> bool {
    ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"].iter().any(|p| path.starts_with(p))
}

/// Of several entries for one folder (transcripts in different project directories can name the same one), keeps the
/// first, which is the newest when sorted newest first.
fn keep_newest_per_folder(found: &mut Vec<RecentFolder>) {
    let mut seen = std::collections::HashSet::new();
    found.retain(|r| seen.insert(r.path.clone()));
}

/// Folders the user has used Claude Code in, most recent first, that still exist. The directory name is a lossy
/// encoding of the path, so the real path comes from the `cwd` recorded in its newest user session.
pub fn recent_folders(projects_root: &Path, limit: usize) -> Vec<RecentFolder> {
    let mut found: Vec<RecentFolder> = recent_user_folders(projects_root).into_iter().filter(|r| Path::new(&r.path).is_dir()).collect();
    found.truncate(limit);
    found
}

/// Every folder the user has used Claude Code in, most recent first, whether or not it still exists: a moved folder is
/// one whose path is gone (see relocate::moved_candidates).
pub fn recent_user_folders(projects_root: &Path) -> Vec<RecentFolder> {
    let Ok(dirs) = std::fs::read_dir(projects_root) else { return vec![] };
    let mut found: Vec<RecentFolder> = dirs
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter_map(|dir| {
            let name = dir.file_name()?.to_string_lossy().into_owned();
            let mut files: Vec<(u64, PathBuf)> = jsonl_files(&dir).into_iter().map(|f| (modified_ms(&f), f)).collect();
            files.sort_by_key(|(ms, _)| std::cmp::Reverse(*ms));
            // Only the newest few: a folder used only by plugin automation lately isn't one the user picks.
            files.into_iter().take(5).find_map(|(updated_ms, f)| user_session_cwd(&f, &name).map(|path| RecentFolder { path, updated_ms }))
        })
        .filter(|r| !is_temp(&r.path))
        .collect();
    found.sort_by_key(|r| std::cmp::Reverse(r.updated_ms));
    keep_newest_per_folder(&mut found);
    found
}

/// The transcript file for a session id, if it exists.
pub fn transcript_path(projects_root: &Path, folder: &Path, id: &str) -> Result<PathBuf, String> {
    transcript_path_with_aliases(projects_root, folder, &[], id)
}

/// The transcript file for a session id: in the folder's directory first, then in the directories of its aliases.
pub fn transcript_path_with_aliases(projects_root: &Path, folder: &Path, aliases: &[PathBuf], id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("That is not a session id.".into());
    }
    let dirs = project_dirs(projects_root, folder, aliases);
    if dirs.is_empty() {
        return Err("No past sessions exist for this folder.".into());
    }
    dirs.iter().map(|dir| dir.join(format!("{id}.jsonl"))).find(|p| is_regular_file(p)).ok_or_else(|| "That session's transcript no longer exists.".into())
}

/// The folder a transcript was started in: the first `cwd` it records (a `cd` later on doesn't change it).
pub fn started_in(path: &Path) -> Option<String> {
    records(path).take(40).find_map(|r| r.get("cwd").and_then(Value::as_str).map(String::from))
}

/// A transcript timestamp ("2026-09-28T18:40:24.309Z") as ms since the epoch.
fn iso_ms(s: &str) -> Option<u64> {
    let (date, time) = s.strip_suffix('Z')?.split_once('T')?;
    let mut d = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let (hms, frac) = time.split_once('.').unwrap_or((time, "0"));
    let mut t = hms.split(':').map(|p| p.parse::<i64>().ok());
    let (h, min, sec) = (t.next()??, t.next()??, t.next()??);
    // Fields out of range (a corrupt line) are no time at all; the bounds keep the arithmetic below far from overflow.
    if !(0..=9999).contains(&y) || !(1..=12).contains(&m) || !(1..=31).contains(&day) || !(0..=23).contains(&h) || !(0..=59).contains(&min) || !(0..=60).contains(&sec) {
        return None;
    }
    // Only digits: anything else would make the slice below cut a character.
    if !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let ms: i64 = format!("{:0<3}", &frac[..frac.len().min(3)]).parse().ok()?;
    // Days from 1970-01-01 (Howard Hinnant's days_from_civil).
    let (y, m) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + day - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    u64::try_from((((days * 24 + h) * 60 + min) * 60 + sec) * 1000 + ms).ok()
}

/// Rebuilds a session's UI events by feeding its transcript through the live stream parser.
pub fn replay(path: &Path) -> Replay {
    let mut parser = StreamParser::default();
    let mut events = Vec::new();
    for r in records(path) {
        if !in_conversation(&r) {
            continue;
        }
        if let Some(text) = prompt_text(&r) {
            events.push(UiEvent::UserText { text, at: r["timestamp"].as_str().and_then(iso_ms) });
            continue;
        }
        let line = match r["type"].as_str() {
            // One transcript record per content block; give each its own message id so text blocks don't merge.
            Some("assistant") => {
                let mut message = r["message"].clone();
                // A record whose message isn't an object (malformed) keeps it as it is.
                if let Some(obj) = message.as_object_mut() {
                    obj.insert("id".into(), r["uuid"].clone());
                }
                json!({"type": "assistant", "message": message, "parent_tool_use_id": null})
            }
            Some("user") => json!({"type": "user", "message": r["message"], "tool_use_result": r["toolUseResult"], "parent_tool_use_id": null}),
            _ => continue,
        };
        for ev in parser.parse_line(&line.to_string()) {
            // Work that ran off the stream (a workflow's agents, a background subagent): read from its transcripts
            // now, all of it, in its place.
            if let UiEvent::Offstream { tool_use_id, dir } = ev {
                let source = match dir {
                    Some(d) => crate::offstream::Source::Workflow { tool_use_id, dir: d.into() },
                    None => crate::offstream::Source::Agent { tool_use_id, subagents: path.with_extension("").join("subagents") },
                };
                events.extend(crate::offstream::read_once(source));
            } else {
                events.push(ev);
            }
        }
    }
    let last_prompt = events.iter().rposition(|e| matches!(e, UiEvent::UserText { .. })).unwrap_or(0);
    let edits_of = |events: &[UiEvent]| -> Vec<(String, Option<String>)> {
        events
            .iter()
            .filter_map(|e| match e {
                UiEvent::EditApplied { path, original, .. } => Some((path.clone(), original.clone())),
                _ => None,
            })
            .collect()
    };
    let before = edits_of(&events[..last_prompt]);
    let edits_before_last_turn = before.len();
    let edits = [before, edits_of(&events[last_prompt..])].concat();
    Replay { events, edits, edits_before_last_turn }
}

#[cfg(test)]
mod tests {
    /// Against a real transcript: LANTERN_TRANSCRIPT=<…/session.jsonl> cargo test real_replay -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_replay() {
        let path = std::path::PathBuf::from(std::env::var("LANTERN_TRANSCRIPT").expect("LANTERN_TRANSCRIPT"));
        let r = replay(&path);
        let offstream = r.events.iter().filter(|e| matches!(e, UiEvent::Offstream { .. })).count();
        let agents: Vec<String> = r.events.iter().filter_map(|e| if let UiEvent::AgentStarted { description, .. } = e { Some(description.clone()) } else { None }).collect();
        println!("events: {}\noffstream left: {offstream}\nagents: {agents:?}", r.events.len());
        assert_eq!(offstream, 0);
    }

    use super::*;

    const FOLDER: &str = "/Users/me/src/acme-api";

    fn rec(v: Value) -> String {
        v.to_string()
    }

    /// A terminal session: string prompts, injected meta content, a command tag, an edit and a text reply.
    fn terminal_session() -> String {
        [
            rec(json!({"type": "queue-operation", "sessionId": "s1"})),
            rec(json!({"type": "user", "cwd": FOLDER, "entrypoint": "cli", "uuid": "u1", "message": {"role": "user", "content": "Add retries to fetchJson\nfor transient errors"}})),
            rec(json!({"type": "user", "cwd": FOLDER, "entrypoint": "cli", "isMeta": true, "uuid": "u2", "message": {"role": "user", "content": [{"type": "text", "text": "Base directory for this skill: …"}]}})),
            rec(json!({"type": "assistant", "cwd": FOLDER, "entrypoint": "cli", "uuid": "a1", "message": {"id": "msg_1", "role": "assistant", "content": [{"type": "text", "text": "I'll add retries."}]}})),
            rec(json!({"type": "assistant", "cwd": FOLDER, "entrypoint": "cli", "uuid": "a2", "message": {"id": "msg_1", "role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Edit", "input": {"file_path": "/Users/me/src/acme-api/retry.ts", "old_string": "a", "new_string": "b"}}]}})),
            rec(json!({"type": "user", "cwd": FOLDER, "entrypoint": "cli", "uuid": "u3", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "updated"}]}, "toolUseResult": {"filePath": "/Users/me/src/acme-api/retry.ts", "originalFile": "a\n", "structuredPatch": [{"oldStart": 1, "oldLines": 1, "newStart": 1, "newLines": 1, "lines": ["-a", "+b"]}]}})),
            "this line is not json".to_string(),
            rec(json!({"type": "user", "cwd": FOLDER, "entrypoint": "cli", "uuid": "u4", "message": {"role": "user", "content": "<command-name>/clear</command-name>"}})),
            rec(json!({"type": "assistant", "cwd": FOLDER, "entrypoint": "cli", "uuid": "a3", "message": {"id": "msg_1", "role": "assistant", "content": [{"type": "text", "text": "Done."}]}})),
            rec(json!({"type": "user", "cwd": FOLDER, "entrypoint": "cli", "uuid": "u5", "isSidechain": true, "message": {"role": "user", "content": "subagent prompt"}})),
            rec(json!({"type": "user", "cwd": FOLDER, "entrypoint": "cli", "uuid": "u6", "message": {"role": "user", "content": [{"type": "text", "text": "Now run the tests"}]}})),
        ]
        .join("\n")
    }

    fn setup(files: &[(&str, String)]) -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join(encode_folder(Path::new(FOLDER)));
        std::fs::create_dir_all(&dir).unwrap();
        for (i, (name, body)) in files.iter().enumerate() {
            let p = dir.join(format!("{name}.jsonl"));
            std::fs::write(&p, body).unwrap();
            let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000 + i as u64);
            std::fs::File::options().write(true).open(&p).unwrap().set_modified(t).unwrap();
        }
        root
    }

    #[test]
    fn encodes_folder_like_claude_code() {
        assert_eq!(encode_folder(Path::new("/Users/me/src/acme-api")), "-Users-me-src-acme-api");
        assert_eq!(encode_folder(Path::new("/tmp/claude-501/-Users-x/my.app")), "-tmp-claude-501--Users-x-my-app");
    }

    #[test]
    fn validates_ids() {
        assert!(valid_id("0e08e6a5-357d-42eb-9b29-1fa38cbe1e5c"));
        assert!(!valid_id("../etc/passwd"));
        assert!(!valid_id(""));
    }

    #[test]
    fn lists_user_sessions_newest_first_with_titles() {
        let app = rec(json!({"type": "user", "cwd": FOLDER, "entrypoint": "sdk-cli", "uuid": "x", "message": {"role": "user", "content": [{"type": "text", "text": "Fix the login redirect"}]}}));
        let plugin = rec(json!({"type": "user", "cwd": FOLDER, "entrypoint": "sdk-py", "uuid": "y", "message": {"role": "user", "content": "Review this change for security vulnerabilities."}}));
        let empty = rec(json!({"type": "queue-operation"}));
        let other_folder = rec(json!({"type": "user", "cwd": "/elsewhere", "entrypoint": "cli", "uuid": "z", "message": {"role": "user", "content": "hi"}}));
        let root = setup(&[("aaaa-1", terminal_session()), ("bbbb-2", app), ("cccc-3", plugin), ("dddd-4", empty), ("eeee-5", other_folder)]);
        let sessions = list_sessions(root.path(), Path::new(FOLDER), &HashMap::new(), &HashMap::new());
        let ids: Vec<&str> = sessions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["bbbb-2", "aaaa-1"]);
        assert_eq!(sessions[0].title, "Fix the login redirect");
        assert_eq!(sessions[1].title, "Add retries to fetchJson");
        assert_eq!(sessions[1].prompts, 2);
        assert_eq!(sessions[0].updated_ms, 1_001_000);
    }

    #[test]
    fn recent_folders_are_real_user_folders_newest_first() {
        let root = tempfile::tempdir().unwrap();
        // Not in the system temp dir: recent_folders leaves those out.
        let work = tempfile::tempdir_in(concat!(env!("CARGO_MANIFEST_DIR"), "/target")).unwrap();
        let scratch = tempfile::tempdir().unwrap();
        let (older, newer, automation) = (work.path().join("older"), work.path().join("my.app"), work.path().join("bot"));
        for f in [&older, &newer, &automation] {
            std::fs::create_dir_all(f).unwrap();
        }
        let session = |cwd: &Path, ep: &str, secs: u64| {
            let dir = root.path().join(encode_folder(cwd));
            std::fs::create_dir_all(&dir).unwrap();
            let p = dir.join(format!("s{secs}.jsonl"));
            std::fs::write(&p, rec(json!({"type": "user", "cwd": cwd.to_str().unwrap(), "entrypoint": ep, "message": {"role": "user", "content": "hi"}}))).unwrap();
            let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(secs);
            std::fs::File::options().write(true).open(&p).unwrap().set_modified(t).unwrap();
        };
        session(&older, "cli", 1_000);
        session(&newer, "sdk-cli", 2_000);
        session(&automation, "sdk-py", 3_000);
        session(Path::new("/gone/folder"), "cli", 4_000);
        session(scratch.path(), "cli", 5_000);
        let recent = recent_folders(root.path(), 10);
        let paths: Vec<&str> = recent.iter().map(|r| r.path.as_str()).collect();
        // The real path comes back even though "my.app" was encoded as "my-app".
        assert_eq!(paths, vec![newer.to_str().unwrap(), older.to_str().unwrap()]);
        assert_eq!(recent[0].updated_ms, 2_000_000);
        assert_eq!(recent_folders(root.path(), 1).len(), 1);
        assert!(recent_folders(&root.path().join("missing"), 10).is_empty());
    }

    #[test]
    fn compaction_summaries_are_not_prompts() {
        let summary = rec(json!({"type": "user", "cwd": FOLDER, "entrypoint": "cli", "uuid": "s", "isCompactSummary": true, "isVisibleInTranscriptOnly": true,
            "message": {"role": "user", "content": "This session is being continued from a previous conversation that ran out of context."}}));
        let after = rec(json!({"type": "user", "cwd": FOLDER, "entrypoint": "cli", "uuid": "u9", "message": {"role": "user", "content": "Carry on"}}));
        let root = setup(&[("aaaa-1", format!("{}\n{summary}\n{after}", terminal_session()))]);
        let path = transcript_path(root.path(), Path::new(FOLDER), "aaaa-1").unwrap();
        let prompts: Vec<String> = replay(&path).events.into_iter().filter_map(|e| if let UiEvent::UserText { text, .. } = e { Some(text) } else { None }).collect();
        assert_eq!(prompts.last().map(String::as_str), Some("Carry on"));
        assert!(!prompts.iter().any(|p| p.contains("being continued")), "{prompts:?}");
        assert_eq!(list_sessions(root.path(), Path::new(FOLDER), &HashMap::new(), &HashMap::new())[0].prompts, 3);

        // A session that starts from a summary (e.g. resumed after compaction) isn't titled by it.
        let root = setup(&[("bbbb-2", format!("{summary}\n{after}"))]);
        assert_eq!(list_sessions(root.path(), Path::new(FOLDER), &HashMap::new(), &HashMap::new())[0].title, "Carry on");
    }

    #[test]
    #[ignore]
    fn real_recent_folders() {
        let root = PathBuf::from(std::env::var("HOME").unwrap()).join(".claude/projects");
        let started = std::time::Instant::now();
        let recent = recent_folders(&root, 8);
        eprintln!("{:?} in {:?}", recent.iter().map(|r| &r.path).collect::<Vec<_>>(), started.elapsed());
        assert!(!recent.is_empty());
    }

    #[test]
    fn a_session_that_cds_into_a_subfolder_is_still_listed() {
        let moved = rec(json!({"type": "user", "cwd": format!("{FOLDER}/src"), "entrypoint": "cli", "uuid": "u7", "message": {"role": "user", "content": "And the docs"}}));
        let root = setup(&[("aaaa-1", format!("{}\n{moved}", terminal_session()))]);
        let sessions = list_sessions(root.path(), Path::new(FOLDER), &HashMap::new(), &HashMap::new());
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].prompts, 3);
    }

    #[test]
    fn titles_come_from_a_rename_then_claude_codes_title_then_lanterns_then_the_prompt() {
        let ai = rec(json!({"type": "ai-title", "aiTitle": "Retry transient errors", "sessionId": "x"}));
        let renamed = rec(json!({"type": "custom-title", "customTitle": "Retries", "sessionId": "x"}));
        let root = setup(&[("aaaa-1", format!("{}\n{ai}", terminal_session())), ("bbbb-2", format!("{}\n{ai}\n{renamed}", terminal_session())), ("cccc-3", terminal_session())]);
        let ours = HashMap::from([("cccc-3".to_string(), "Made by Lantern".to_string()), ("aaaa-1".to_string(), "Not used".to_string())]);
        let by_id = |id: &str| list_sessions(root.path(), Path::new(FOLDER), &ours, &HashMap::new()).into_iter().find(|s| s.id == id).unwrap().title;
        assert_eq!(by_id("aaaa-1"), "Retry transient errors");
        assert_eq!(by_id("bbbb-2"), "Retries");
        assert_eq!(by_id("cccc-3"), "Made by Lantern");
        assert_eq!(list_sessions(root.path(), Path::new(FOLDER), &HashMap::new(), &HashMap::new()).into_iter().find(|s| s.id == "cccc-3").unwrap().title, "Add retries to fetchJson");
        // A name the user gave in Lantern beats Claude Code's own titles, and the one Lantern made.
        let renamed = HashMap::from([("aaaa-1".to_string(), "Our name".to_string()), ("bbbb-2".to_string(), "Our other name".to_string())]);
        let by_renamed = |id: &str| list_sessions(root.path(), Path::new(FOLDER), &ours, &renamed).into_iter().find(|s| s.id == id).unwrap().title;
        assert_eq!(by_renamed("aaaa-1"), "Our name");
        assert_eq!(by_renamed("bbbb-2"), "Our other name");
        assert_eq!(transcript_title(&root.path().join(encode_folder(Path::new(FOLDER))).join("bbbb-2.jsonl")).as_deref(), Some("Retries"));
    }

    #[test]
    fn reads_transcript_timestamps() {
        assert_eq!(iso_ms("1970-01-01T00:00:01.5Z"), Some(1500));
        assert_eq!(iso_ms("2026-09-28T18:40:24.309Z"), Some(1_790_620_824_309));
        assert_eq!(iso_ms("2024-02-29T00:00:00Z"), Some(1_709_164_800_000));
        assert_eq!(iso_ms("yesterday"), None);
    }

    #[test]
    fn long_titles_are_trimmed() {
        let long = "x".repeat(200);
        let body = rec(json!({"type": "user", "cwd": FOLDER, "entrypoint": "cli", "uuid": "u", "message": {"role": "user", "content": long}}));
        let root = setup(&[("aaaa", body)]);
        let title = &list_sessions(root.path(), Path::new(FOLDER), &HashMap::new(), &HashMap::new())[0].title;
        assert_eq!(title.chars().count(), TITLE_MAX + 1);
        assert!(title.ends_with('…'));
    }

    #[test]
    fn falls_back_to_matching_cwd_when_the_folder_name_differs() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("some-other-name");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("abcd.jsonl"), terminal_session()).unwrap();
        assert_eq!(list_sessions(root.path(), Path::new(FOLDER), &HashMap::new(), &HashMap::new()).len(), 1);
        assert!(list_sessions(root.path(), Path::new("/nowhere"), &HashMap::new(), &HashMap::new()).is_empty());
    }

    #[test]
    fn replays_prompts_steps_edits_and_replies() {
        let root = setup(&[("aaaa-1", terminal_session())]);
        let path = transcript_path(root.path(), Path::new(FOLDER), "aaaa-1").unwrap();
        let r = replay(&path);
        let kinds: Vec<String> = r.events.iter().map(|e| serde_json::to_value(e).unwrap()["kind"].as_str().unwrap().to_string()).collect();
        assert_eq!(kinds, vec!["user_text", "assistant_text", "tool_started", "edit_applied", "tool_finished", "assistant_text", "user_text"]);
        assert_eq!(r.events[0], UiEvent::UserText { text: "Add retries to fetchJson\nfor transient errors".into(), at: None });
        let blocks: Vec<&str> = r.events.iter().filter_map(|e| match e {
            UiEvent::AssistantText { block_id, .. } => Some(block_id.as_str()),
            _ => None,
        }).collect();
        assert_eq!(blocks.len(), 2);
        assert_ne!(blocks[0], blocks[1], "text blocks of one message must not share a block id");
        assert_eq!(r.edits, vec![("/Users/me/src/acme-api/retry.ts".to_string(), Some("a\n".to_string()))]);
    }

    /// Opt-in check against the real transcripts on this machine:
    /// `LANTERN_HISTORY_FOLDER=/path/to/repo cargo test --lib real_transcripts -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_transcripts() {
        let folder = std::env::var("LANTERN_HISTORY_FOLDER").expect("set LANTERN_HISTORY_FOLDER");
        let root = PathBuf::from(std::env::var("HOME").unwrap()).join(".claude/projects");
        let sessions = list_sessions(&root, Path::new(&folder), &HashMap::new(), &HashMap::new());
        for s in &sessions {
            let r = replay(&transcript_path(&root, Path::new(&folder), &s.id).unwrap());
            let unknown = r.events.iter().filter(|e| matches!(e, UiEvent::Unknown { .. } | UiEvent::ParseError { .. })).count();
            let last_turn = r.edits.len() - r.edits_before_last_turn;
            if let Some((i, UiEvent::UserText { text, .. })) = r.events.iter().enumerate().rev().find(|(_, e)| matches!(e, UiEvent::UserText { .. })) {
                println!("  last prompt at event {i}/{}: {:?}", r.events.len(), text.chars().take(80).collect::<String>());
            }
            println!("{} | {:>3} prompts | {:>4} events | {:>2} edits ({:>2} in last turn) | {} unknown | {}", &s.id[..8], s.prompts, r.events.len(), r.edits.len(), last_turn, unknown, s.title);
        }
        assert!(!sessions.is_empty());
    }

    #[test]
    fn transcript_path_rejects_bad_or_missing_ids() {
        let root = setup(&[("aaaa-1", terminal_session())]);
        assert!(transcript_path(root.path(), Path::new(FOLDER), "../x").is_err());
        assert!(transcript_path(root.path(), Path::new(FOLDER), "ffff").unwrap_err().contains("no longer exists"));
    }

    #[test]
    fn a_damaged_transcript_loses_only_its_damaged_lines() {
        let prompt = |text: &str| rec(json!({"type": "user", "cwd": FOLDER, "entrypoint": "cli", "message": {"role": "user", "content": text}}));
        let mut body: Vec<u8> = prompt("first").into_bytes();
        // Invalid UTF-8, a truncated record, and a valid JSON value that isn't a record, then a good prompt.
        body.extend(b"\n{\"type\": \"user\", \"message\": \xff\xfe}\n{\"type\": \"user\", \"cwd\": \n\"just a string\"\n");
        body.extend(prompt("second").as_bytes());
        body.push(b'\n');
        // An assistant record whose message isn't an object: replay mustn't panic on it.
        body.extend(rec(json!({"type": "assistant", "uuid": "a1", "message": "oops"})).as_bytes());
        body.push(b'\n');
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("s.jsonl");
        std::fs::write(&path, body).unwrap();
        let texts: Vec<String> = replay(&path).events.into_iter().filter_map(|e| if let UiEvent::UserText { text, .. } = e { Some(text) } else { None }).collect();
        assert_eq!(texts, vec!["first", "second"]);
    }

    #[test]
    fn a_timestamp_that_isnt_one_is_no_time_not_a_panic() {
        assert_eq!(iso_ms("1970-01-01T00:00:01.5Z"), Some(1_500));
        assert_eq!(iso_ms("1970-01-02T00:00:00Z"), Some(86_400_000));
        assert_eq!(iso_ms("2026-09-28T18:40:24.309Z"), Some(1_790_620_824_309));
        assert_eq!(iso_ms("2026-09-28T18:40:24.12é4Z"), None);
        assert_eq!(iso_ms("999999999999999999-01-01T00:00:00Z"), None);
        assert_eq!(iso_ms("2026-13-01T00:00:00Z"), None);
        assert_eq!(iso_ms("2026-09-28T25:00:00Z"), None);
    }

    #[test]
    fn only_tags_claude_code_and_lantern_inject_are_not_prompts() {
        let typed = |text: &str| prompt_text(&json!({"type": "user", "message": {"role": "user", "content": text}}));
        assert_eq!(typed("<div class=\"x\"> why is this blank?"), Some("<div class=\"x\"> why is this blank?".into()));
        assert_eq!(typed("<bash-input>git status</bash-input>"), None);
        assert_eq!(typed("<command-name>/clear</command-name>"), None);
        assert_eq!(typed("<system-reminder>Plan mode is on</system-reminder>"), None);
    }

    #[test]
    fn a_folder_is_listed_once_even_when_its_transcripts_are_in_several_directories() {
        let entry = |path: &str, updated_ms: u64| RecentFolder { path: path.into(), updated_ms };
        // Newest first: a, b, then a again from another project directory, which must not be listed twice.
        let mut found = vec![entry("/w/a", 3), entry("/w/b", 2), entry("/w/a", 1)];
        keep_newest_per_folder(&mut found);
        assert_eq!(found, vec![entry("/w/a", 3), entry("/w/b", 2)]);
    }

    #[test]
    fn a_folder_resumed_after_a_move_is_recent_under_its_new_path() {
        let root = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir_in(concat!(env!("CARGO_MANIFEST_DIR"), "/target")).unwrap();
        let (new, old) = (work.path().join("new-app"), work.path().join("old-app"));
        std::fs::create_dir_all(&new).unwrap();
        let (new_s, old_s) = (new.to_string_lossy().into_owned(), old.to_string_lossy().into_owned());
        // A session copied from the old folder's directory and continued here: its first record is the old folder's.
        let dir = root.path().join(encode_folder(&new));
        std::fs::create_dir_all(&dir).unwrap();
        let body = [
            rec(json!({"type": "user", "cwd": old_s, "entrypoint": "cli", "message": {"role": "user", "content": "old"}})),
            rec(json!({"type": "user", "cwd": new_s, "entrypoint": "cli", "message": {"role": "user", "content": "more"}})),
        ]
        .join("\n");
        let p = dir.join("moved.jsonl");
        std::fs::write(&p, body).unwrap();
        std::fs::File::options().write(true).open(&p).unwrap().set_modified(std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(3_000)).unwrap();
        let recent = recent_folders(root.path(), 10);
        assert_eq!(recent.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(), vec![new_s.as_str()]);
        // The old path is still known (it's gone), for the moved-folder check.
        let all: Vec<String> = recent_user_folders(root.path()).into_iter().map(|r| r.path).collect();
        assert_eq!(all, vec![new_s.clone()]);
    }

    #[test]
    fn a_lantern_note_in_front_of_a_message_is_not_part_of_the_prompt() {
        let typed = |text: &str| prompt_text(&json!({"type": "user", "message": {"role": "user", "content": text}}));
        assert_eq!(typed("[Lantern note: this project moved from /a to /b. Paths in earlier messages are the old ones.]\n\nwhy?"), Some("why?".into()));
        assert_eq!(typed("[Lantern note: since your last message the user reverted these files.]\n- /p/a.ts: put back.\n\nwhy?"), Some("why?".into()));
        assert_eq!(typed("[Lantern note: only a note]"), Some("[Lantern note: only a note]".into()));
    }
}
