//! A chat as web Claude reads it (read_chat): everything Lantern kept of it, in order, as numbered entries. The user's
//! and web Claude's messages, Claude's words, each step with what it printed, each edit with its diff, and where turns
//! ended. Streamed text, thinking and what the user's own `!` commands printed are never kept (see conversations.rs).

use super::store::SENT_BY;
use crate::ui_event::UiEvent;
use serde_json::{json, Value};
use std::collections::HashMap;

/// The most of one step's output, and of one edit's diff, an entry carries.
pub const OUTPUT_MAX: usize = 4_000;
pub const DIFF_MAX: usize = 6_000;
/// A page of entries: no more than this many, and no more than this many characters of JSON.
pub const PAGE_ENTRIES: usize = 150;
pub const PAGE_CHARS: usize = 60_000;

fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        format!("{}… [cut: {} characters more]", text.chars().take(max).collect::<String>(), text.chars().count() - max)
    }
}

/// Marks an entry that a helper (a subagent) made, not the chat's Claude itself.
fn by(mut v: Value, parent: &Option<String>) -> Value {
    if let Some(p) = parent {
        v["helper"] = json!(p);
    }
    v
}

/// Every entry of the chat, oldest first, numbered from 1.
pub fn entries(events: &[UiEvent]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut steps: HashMap<String, usize> = HashMap::new();
    for event in events {
        let entry = match event {
            UiEvent::UserText { text, sent_by, images, .. } => {
                let web = sent_by.as_deref() == Some(SENT_BY);
                let text = if web { text.trim() } else { crate::remote::hub::without_notes(text).trim() };
                if text.is_empty() && *images == 0 {
                    continue;
                }
                let mut v = json!({"from": if web { "web_claude" } else { "user" }, "text": text});
                if *images > 0 {
                    v["pictures"] = json!(images);
                }
                v
            }
            UiEvent::AssistantText { parent, text, .. } => by(json!({"from": "claude", "text": text}), parent),
            UiEvent::ToolStarted { parent, tool_use_id, name, summary } => {
                steps.insert(tool_use_id.clone(), out.len());
                by(json!({"step": name, "what": summary}), parent)
            }
            UiEvent::ToolFinished { tool_use_id, is_error, output, .. } => {
                if let Some(at) = steps.get(tool_use_id).copied() {
                    if !output.trim().is_empty() {
                        out[at]["output"] = json!(cut(output, OUTPUT_MAX));
                    }
                    if *is_error {
                        out[at]["failed"] = json!(true);
                    }
                }
                continue;
            }
            UiEvent::EditApplied { parent, path, created, hunks, .. } => {
                let diff = hunks.iter().map(|h| format!("@@ -{},{} +{},{} @@\n{}", h.old_start, h.old_lines, h.new_start, h.new_lines, h.lines.join("\n"))).collect::<Vec<_>>().join("\n");
                let mut v = by(json!({"edited": path, "diff": cut(&diff, DIFF_MAX)}), parent);
                if *created {
                    v["created"] = json!(true);
                }
                v
            }
            UiEvent::AgentStarted { subagent_type, description, .. } => json!({"helper_started": description, "kind": subagent_type}),
            UiEvent::AgentMessage { from, text } => json!({"from": from, "text": text}),
            UiEvent::PermissionRequested { tool_name, .. } => json!({"asked_permission": tool_name}),
            UiEvent::PermissionResolved { allow, .. } => json!({"permission": if *allow { "allowed" } else { "denied" }}),
            UiEvent::ShellStarted { command, .. } => json!({"user_ran": command}),
            UiEvent::TurnStopping => json!({"turn": "stopped by the user"}),
            UiEvent::TurnDone { is_error, result, .. } => {
                let mut v = json!({"turn": if *is_error { "ended with an error" } else { "done" }});
                if let Some(r) = result.as_ref().filter(|r| *is_error && !r.trim().is_empty()) {
                    v["error"] = json!(cut(r, 500));
                }
                v
            }
            UiEvent::Compacted => json!({"note": "The chat was compacted: Claude kept a summary of what came before."}),
            UiEvent::ConversationReset => json!({"note": "The chat was cleared: Claude starts afresh from here."}),
            UiEvent::SessionEnded { .. } => json!({"note": "The chat's Claude stopped."}),
            _ => continue,
        };
        out.push(entry);
    }
    for (i, v) in out.iter_mut().enumerate() {
        v["n"] = json!(i + 1);
    }
    out
}

/// One page of `entries`: those after entry `after` (reading forward), else those before entry `before` (reading back),
/// else the newest. Returns the page and whether there are entries before and after it.
pub fn page(entries: &[Value], before: Option<usize>, after: Option<usize>) -> (Vec<Value>, bool, bool) {
    let size = |v: &Value| v.to_string().len();
    let mut taken: Vec<Value> = Vec::new();
    let mut chars = 0;
    match after {
        Some(after) => {
            for v in entries.iter().skip(after.min(entries.len())) {
                if taken.len() == PAGE_ENTRIES || (chars + size(v) > PAGE_CHARS && !taken.is_empty()) {
                    break;
                }
                chars += size(v);
                taken.push(v.clone());
            }
            let first = after.min(entries.len());
            (taken.clone(), first > 0, first + taken.len() < entries.len())
        }
        None => {
            let end = before.map_or(entries.len(), |b| b.saturating_sub(1).min(entries.len()));
            for v in entries[..end].iter().rev() {
                if taken.len() == PAGE_ENTRIES || (chars + size(v) > PAGE_CHARS && !taken.is_empty()) {
                    break;
                }
                chars += size(v);
                taken.push(v.clone());
            }
            taken.reverse();
            (taken.clone(), end > taken.len(), end < entries.len())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui_event::Hunk;

    fn user(t: &str, by: Option<&str>) -> UiEvent {
        UiEvent::UserText { text: t.into(), at: None, sent_by: by.map(String::from), images: 0 }
    }

    fn done() -> UiEvent {
        UiEvent::TurnDone { is_error: false, result: None, cost_usd: None, tokens: None, session_cost_usd: None, session_tokens: 0, duration_ms: None, auth_hint: false, denied: 0, context_window: None }
    }

    #[test]
    fn a_chat_reads_as_its_messages_steps_with_their_output_edits_with_their_diffs_and_turn_ends() {
        let events = vec![
            user("[Web Claude sent this about the design canvas…]\n\nBuild the header", Some(SENT_BY)),
            UiEvent::ToolStarted { parent: None, tool_use_id: "t1".into(), name: "Bash".into(), summary: "npm test".into() },
            UiEvent::ToolFinished { parent: None, tool_use_id: "t1".into(), is_error: true, output: "1 failed".into() },
            UiEvent::EditApplied { parent: None, tool_use_id: "t2".into(), path: "src/Header.tsx".into(), created: true, hunks: vec![Hunk { old_start: 0, old_lines: 0, new_start: 1, new_lines: 1, lines: vec!["+export const Header = 1;".into()] }], original: None },
            UiEvent::AssistantText { parent: Some("agent-1".into()), block_id: "b0".into(), text: "helper words".into() },
            UiEvent::AssistantText { parent: None, block_id: "b1".into(), text: "Built it.".into() },
            done(),
            user("Make it blue too", Some("desktop")),
            UiEvent::Thinking { parent: None },
        ];
        let e = entries(&events);
        assert_eq!(e[0]["from"], "web_claude");
        assert_eq!((e[1]["step"].as_str(), e[1]["output"].as_str(), e[1]["failed"].as_bool()), (Some("Bash"), Some("1 failed"), Some(true)));
        assert_eq!((e[2]["edited"].as_str(), e[2]["created"].as_bool()), (Some("src/Header.tsx"), Some(true)));
        assert!(e[2]["diff"].as_str().unwrap().contains("+export const Header"));
        assert_eq!((e[3]["text"].as_str(), e[3]["helper"].as_str()), (Some("helper words"), Some("agent-1")));
        assert_eq!(e[4]["text"], "Built it.");
        assert_eq!(e[5]["turn"], "done");
        assert_eq!((e[6]["from"].as_str(), e[6]["text"].as_str()), (Some("user"), Some("Make it blue too")));
        assert_eq!(e.len(), 7);
        assert_eq!(e.iter().map(|v| v["n"].as_u64().unwrap()).collect::<Vec<_>>(), (1..=7).collect::<Vec<_>>());
    }

    #[test]
    fn long_output_is_cut_and_says_how_much() {
        let events = vec![
            UiEvent::ToolStarted { parent: None, tool_use_id: "t1".into(), name: "Read".into(), summary: "a.txt".into() },
            UiEvent::ToolFinished { parent: None, tool_use_id: "t1".into(), is_error: false, output: "x".repeat(OUTPUT_MAX + 10) },
        ];
        assert!(entries(&events)[0]["output"].as_str().unwrap().ends_with("[cut: 10 characters more]"));
    }

    #[test]
    fn pages_go_back_from_the_newest_and_forward_from_an_entry() {
        let all: Vec<Value> = (1..=400).map(|n| json!({"n": n, "text": "x"})).collect();
        let (newest, earlier, later) = page(&all, None, None);
        assert_eq!((newest.len(), newest[0]["n"].as_u64(), earlier, later), (PAGE_ENTRIES, Some(251), true, false));
        let (back, earlier, later) = page(&all, Some(251), None);
        assert_eq!((back.last().unwrap()["n"].as_u64(), earlier, later), (Some(250), true, true));
        let (start, earlier, _) = page(&all, Some(10), None);
        assert_eq!((start.len(), earlier), (9, false));
        let (fwd, earlier, later) = page(&all, None, Some(390));
        assert_eq!((fwd[0]["n"].as_u64(), fwd.len(), earlier, later), (Some(391), 10, true, false));
        let big: Vec<Value> = (1..=5).map(|n| json!({"n": n, "text": "y".repeat(PAGE_CHARS / 2)})).collect();
        assert_eq!(page(&big, None, None).0.len(), 1);
    }
}
