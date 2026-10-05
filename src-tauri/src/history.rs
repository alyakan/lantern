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

fn jsonl_files(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "jsonl")).collect())
        .unwrap_or_default()
}

/// Every parseable JSON line of a transcript; bad lines are skipped.
fn records(path: &Path) -> impl Iterator<Item = Value> {
    let lines = std::fs::File::open(path).map(|f| BufReader::new(f).lines()).ok();
    lines.into_iter().flatten().map_while(Result::ok).filter_map(|l| serde_json::from_str::<Value>(&l).ok())
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
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.starts_with('<') || trimmed.starts_with("[Request interrupted") {
        return None;
    }
    Some(trimmed.to_string())
}

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

/// `titles`: the ones Lantern made, for sessions Claude Code didn't title (those run with `-p`).
fn summarize(path: &Path, folder: &str, titles: &HashMap<String, String>) -> Option<SessionSummary> {
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
            if cwd != folder {
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
    let title = custom.or(ai).or_else(|| titles.get(&id).cloned()).unwrap_or_else(|| title_of(&first));
    Some(SessionSummary { id, title, updated_ms, prompts })
}

/// Sessions for `folder`, newest first. Sessions with no typed prompt (e.g. plugin automation) are left out.
pub fn list_sessions(projects_root: &Path, folder: &Path, titles: &HashMap<String, String>) -> Vec<SessionSummary> {
    let Some(dir) = project_dir(projects_root, folder) else { return vec![] };
    let want = folder.to_string_lossy();
    let mut sessions: Vec<SessionSummary> = jsonl_files(&dir).iter().filter_map(|f| summarize(f, &want, titles)).collect();
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

/// The folder a transcript was recorded in, if the session was the user's own (terminal or Lantern).
fn user_session_cwd(path: &Path) -> Option<String> {
    let mut cwd = None;
    for r in records(path).take(40) {
        if let Some(ep) = r.get("entrypoint").and_then(Value::as_str) {
            if !USER_ENTRYPOINTS.contains(&ep) {
                return None;
            }
        }
        if cwd.is_none() {
            cwd = r.get("cwd").and_then(Value::as_str).map(String::from);
        }
    }
    cwd
}

/// Scratch folders (probes, tools' temp dirs) aren't projects anyone wants to reopen.
fn is_temp(path: &str) -> bool {
    ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"].iter().any(|p| path.starts_with(p))
}

/// Folders the user has used Claude Code in, most recent first, that still exist. The directory name is a lossy
/// encoding of the path, so the real path comes from the `cwd` recorded in its newest user session.
pub fn recent_folders(projects_root: &Path, limit: usize) -> Vec<RecentFolder> {
    let Ok(dirs) = std::fs::read_dir(projects_root) else { return vec![] };
    let mut found: Vec<RecentFolder> = dirs
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter_map(|dir| {
            let mut files: Vec<(u64, PathBuf)> = jsonl_files(&dir).into_iter().map(|f| (modified_ms(&f), f)).collect();
            files.sort_by_key(|(ms, _)| std::cmp::Reverse(*ms));
            // Only the newest few: a folder used only by plugin automation lately isn't one the user picks.
            files.into_iter().take(5).find_map(|(updated_ms, f)| user_session_cwd(&f).map(|path| RecentFolder { path, updated_ms }))
        })
        .filter(|r| !is_temp(&r.path) && Path::new(&r.path).is_dir())
        .collect();
    found.sort_by_key(|r| std::cmp::Reverse(r.updated_ms));
    found.dedup_by(|a, b| a.path == b.path);
    found.truncate(limit);
    found
}

/// The transcript file for a session id, if it exists.
pub fn transcript_path(projects_root: &Path, folder: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("That is not a session id.".into());
    }
    let dir = project_dir(projects_root, folder).ok_or("No past sessions exist for this folder.")?;
    let path = dir.join(format!("{id}.jsonl"));
    if path.is_file() {
        Ok(path)
    } else {
        Err("That session's transcript no longer exists.".into())
    }
}

/// A transcript timestamp ("2026-09-28T18:40:24.309Z") as ms since the epoch.
fn iso_ms(s: &str) -> Option<u64> {
    let (date, time) = s.strip_suffix('Z')?.split_once('T')?;
    let mut d = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let (hms, frac) = time.split_once('.').unwrap_or((time, "0"));
    let mut t = hms.split(':').map(|p| p.parse::<i64>().ok());
    let (h, min, sec) = (t.next()??, t.next()??, t.next()??);
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
                message["id"] = r["uuid"].clone();
                json!({"type": "assistant", "message": message, "parent_tool_use_id": null})
            }
            Some("user") => json!({"type": "user", "message": r["message"], "tool_use_result": r["toolUseResult"], "parent_tool_use_id": null}),
            _ => continue,
        };
        events.extend(parser.parse_line(&line.to_string()));
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
        let sessions = list_sessions(root.path(), Path::new(FOLDER), &HashMap::new());
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
        assert_eq!(list_sessions(root.path(), Path::new(FOLDER), &HashMap::new())[0].prompts, 3);

        // A session that starts from a summary (e.g. resumed after compaction) isn't titled by it.
        let root = setup(&[("bbbb-2", format!("{summary}\n{after}"))]);
        assert_eq!(list_sessions(root.path(), Path::new(FOLDER), &HashMap::new())[0].title, "Carry on");
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
        let sessions = list_sessions(root.path(), Path::new(FOLDER), &HashMap::new());
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].prompts, 3);
    }

    #[test]
    fn titles_come_from_a_rename_then_claude_codes_title_then_lanterns_then_the_prompt() {
        let ai = rec(json!({"type": "ai-title", "aiTitle": "Retry transient errors", "sessionId": "x"}));
        let renamed = rec(json!({"type": "custom-title", "customTitle": "Retries", "sessionId": "x"}));
        let root = setup(&[("aaaa-1", format!("{}\n{ai}", terminal_session())), ("bbbb-2", format!("{}\n{ai}\n{renamed}", terminal_session())), ("cccc-3", terminal_session())]);
        let ours = HashMap::from([("cccc-3".to_string(), "Made by Lantern".to_string()), ("aaaa-1".to_string(), "Not used".to_string())]);
        let by_id = |id: &str| list_sessions(root.path(), Path::new(FOLDER), &ours).into_iter().find(|s| s.id == id).unwrap().title;
        assert_eq!(by_id("aaaa-1"), "Retry transient errors");
        assert_eq!(by_id("bbbb-2"), "Retries");
        assert_eq!(by_id("cccc-3"), "Made by Lantern");
        assert_eq!(list_sessions(root.path(), Path::new(FOLDER), &HashMap::new()).into_iter().find(|s| s.id == "cccc-3").unwrap().title, "Add retries to fetchJson");
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
        let title = &list_sessions(root.path(), Path::new(FOLDER), &HashMap::new())[0].title;
        assert_eq!(title.chars().count(), TITLE_MAX + 1);
        assert!(title.ends_with('…'));
    }

    #[test]
    fn falls_back_to_matching_cwd_when_the_folder_name_differs() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("some-other-name");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("abcd.jsonl"), terminal_session()).unwrap();
        assert_eq!(list_sessions(root.path(), Path::new(FOLDER), &HashMap::new()).len(), 1);
        assert!(list_sessions(root.path(), Path::new("/nowhere"), &HashMap::new()).is_empty());
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
        let sessions = list_sessions(&root, Path::new(&folder), &HashMap::new());
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
}
