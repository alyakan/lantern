use crate::ui_event::{Hunk, UiEvent};
use serde_json::Value;
use std::collections::HashMap;

pub const OUTPUT_LIMIT: usize = 4000;
const IGNORED_TYPES: &[&str] = &["rate_limit_event"];
const EDIT_TOOLS: &[&str] = &["Edit", "Write", "MultiEdit"];

/// Turns claude's stream-json output, one line at a time, into UI events.
#[derive(Default)]
pub struct StreamParser {
    /// parent_tool_use_id → (current message id, index of the latest content block)
    current_message: HashMap<Option<String>, (String, u64)>,
    /// tool_use_id → tool name
    tools: HashMap<String, String>,
    /// tool_use_id → a Bash step's whole command (the summary is cut short)
    commands: HashMap<String, String>,
    /// Each agent's model as last reported ("" = the main thread), to say only when it changes.
    models: HashMap<String, String>,
    /// Advisor calls and results already reported (they arrive while streaming and again in the message).
    advisor_seen: std::collections::HashSet<String>,
}

impl StreamParser {
    pub fn parse_line(&mut self, line: &str) -> Vec<UiEvent> {
        let line = line.trim();
        if line.is_empty() {
            return vec![];
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return vec![UiEvent::ParseError { line: truncate(line, 500) }],
        };
        let parent = v.get("parent_tool_use_id").and_then(Value::as_str).map(String::from);
        let kind = str_of(&v, "type");
        match kind.as_str() {
            "system" => self.system(&v),
            "stream_event" => self.stream_event(&v, parent),
            "assistant" => self.assistant(&v, parent),
            "user" => self.user(&v, parent),
            "result" => vec![model_usage(&v), result_event(&v)],
            // Replies to our control requests; only `initialize`'s (the slash commands) carries anything to show.
            "control_response" => initialize_events(&v),
            // `/clear` started a fresh conversation in the same process.
            "conversation_reset" => vec![UiEvent::ConversationReset],
            t if IGNORED_TYPES.contains(&t) => vec![],
            _ => vec![UiEvent::Unknown { raw: v }],
        }
    }

    fn system(&mut self, v: &Value) -> Vec<UiEvent> {
        let sub = str_of(v, "subtype");
        match sub.as_str() {
            "init" => {
                let started = UiEvent::SessionStarted {
                    session_id: str_of(v, "session_id"),
                    model: str_of(v, "model"),
                    cwd: str_of(v, "cwd"),
                    permission_mode: str_of(v, "permissionMode"),
                    claude_version: str_of(v, "claude_code_version"),
                };
                // The MCP servers' tools it can use, for Settings ("mcp__server__tool").
                let tools: Vec<String> = v["tools"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|t| t.starts_with("mcp__")).map(String::from).collect();
                if v["tools"].is_array() { vec![started, UiEvent::McpTools { tools }] } else { vec![started] }
            }
            "api_retry" => vec![UiEvent::Retrying {
                attempt: v["attempt"].as_u64().unwrap_or(0),
                max_retries: v["max_retries"].as_u64().unwrap_or(0),
                error: str_of(v, "error"),
            }],
            "background_tasks_changed" => vec![UiEvent::BackgroundTasks {
                tasks: v["tasks"]
                    .as_array()
                    .map(|ts| {
                        ts.iter()
                            .map(|t| crate::ui_event::BackgroundTask { id: str_of(t, "task_id"), task_type: str_of(t, "task_type"), description: str_of(t, "description") })
                            .collect()
                    })
                    .unwrap_or_default(),
            }],
            "task_progress" => vec![UiEvent::AgentProgress {
                tool_use_id: str_of(v, "tool_use_id"),
                description: str_of(v, "description"),
                tokens: v["usage"]["total_tokens"].as_u64().unwrap_or(0),
                tool_uses: v["usage"]["tool_uses"].as_u64().unwrap_or(0),
                duration_ms: v["usage"]["duration_ms"].as_u64().unwrap_or(0),
            }],
            "task_started" => vec![UiEvent::TaskStarted { task_id: str_of(v, "task_id"), tool_use_id: str_of(v, "tool_use_id") }],
            "task_notification" => vec![UiEvent::TaskEnded { task_id: str_of(v, "task_id"), tool_use_id: str_of(v, "tool_use_id"), status: str_of(v, "status"), summary: str_of(v, "summary") }],
            // hooks, task updates, status, …: session bookkeeping, never conversation content
            _ => vec![],
        }
    }

    fn stream_event(&mut self, v: &Value, parent: Option<String>) -> Vec<UiEvent> {
        let ev = &v["event"];
        match ev["type"].as_str().unwrap_or("") {
            "message_start" => {
                let id = ev["message"]["id"].as_str().unwrap_or("").to_string();
                self.current_message.insert(parent, (id, 0));
                vec![]
            }
            "content_block_start" => {
                let idx = ev["index"].as_u64().unwrap_or(0);
                if let Some(entry) = self.current_message.get_mut(&parent) {
                    entry.1 = idx;
                }
                match ev["content_block"]["type"].as_str() {
                    Some("thinking") => vec![UiEvent::Thinking { parent }],
                    // The advisor shows while it's consulted, before the message is complete.
                    Some("server_tool_use" | "advisor_tool_result") => self.advisor_block(&ev["content_block"], parent),
                    _ => vec![],
                }
            }
            "content_block_delta" if ev["delta"]["type"] == "text_delta" => {
                let idx = ev["index"].as_u64().unwrap_or(0);
                let msg = self.current_message.get(&parent).map(|m| m.0.clone()).unwrap_or_default();
                vec![UiEvent::TextDelta {
                    parent,
                    block_id: format!("{msg}:{idx}"),
                    text: ev["delta"]["text"].as_str().unwrap_or("").to_string(),
                }]
            }
            _ => vec![],
        }
    }

    /// An advisor call or its result, once each (they come while streaming and again in the complete message).
    fn advisor_block(&mut self, block: &Value, parent: Option<String>) -> Vec<UiEvent> {
        match block["type"].as_str().unwrap_or("") {
            "server_tool_use" if block["name"] == "advisor" => {
                let id = str_of(block, "id");
                if !self.advisor_seen.insert(format!("start:{id}")) {
                    return vec![];
                }
                vec![UiEvent::AdvisorStarted { parent, id }]
            }
            "advisor_tool_result" => {
                let id = str_of(block, "tool_use_id");
                if !self.advisor_seen.insert(format!("done:{id}")) {
                    return vec![];
                }
                let content = &block["content"];
                let kind = content["type"].as_str().unwrap_or("");
                let (outcome, error_code) = if kind.contains("error") {
                    ("unavailable", content["error_code"].as_str().map(String::from))
                } else if kind.contains("declin") || content["stop_reason"] == "refusal" {
                    ("declined", None)
                } else {
                    ("reviewed", None)
                };
                vec![UiEvent::AdvisorDone { parent, id, outcome: outcome.into(), error_code }]
            }
            _ => vec![],
        }
    }

    fn assistant(&mut self, v: &Value, parent: Option<String>) -> Vec<UiEvent> {
        let msg_id = v["message"]["id"].as_str().unwrap_or("").to_string();
        let mut out = vec![];
        // Which model this agent (the main thread or a subagent) runs on, when it's new or changed.
        if let Some(model) = v["message"]["model"].as_str().filter(|m| !m.is_empty() && !m.starts_with('<')) {
            let key = parent.clone().unwrap_or_default();
            if self.models.get(&key).map(String::as_str) != Some(model) {
                self.models.insert(key, model.to_string());
                out.push(UiEvent::AgentModel { parent: parent.clone(), model: model.to_string() });
            }
        }
        // Subagents have their own context; only the main thread's usage says how full the conversation is.
        if parent.is_none() {
            if let Some(tokens) = context_tokens(&v["message"]["usage"]) {
                out.push(UiEvent::ContextUsed { tokens });
            }
        }
        for block in v["message"]["content"].as_array().into_iter().flatten() {
            match block["type"].as_str().unwrap_or("") {
                "text" => {
                    let idx = self.block_index_for(&parent, &msg_id);
                    out.push(UiEvent::AssistantText {
                        parent: parent.clone(),
                        block_id: format!("{msg_id}:{idx}"),
                        text: block["text"].as_str().unwrap_or("").to_string(),
                    });
                }
                "tool_use" => {
                    let id = block["id"].as_str().unwrap_or("").to_string();
                    let name = block["name"].as_str().unwrap_or("").to_string();
                    self.tools.insert(id.clone(), name.clone());
                    if let Some(cmd) = block["input"]["command"].as_str().filter(|_| name == "Bash") {
                        self.commands.insert(id.clone(), cmd.to_string());
                    }
                    let input = &block["input"];
                    let agent = (name == "Agent" || name == "Task").then(|| UiEvent::AgentStarted {
                        tool_use_id: id.clone(),
                        subagent_type: input["subagent_type"].as_str().unwrap_or("general-purpose").to_string(),
                        description: str_of(input, "description"),
                        model: input["model"].as_str().map(String::from),
                    });
                    out.push(UiEvent::ToolStarted {
                        parent: parent.clone(),
                        tool_use_id: id,
                        summary: summarize(&name, input),
                        name,
                    });
                    out.extend(agent);
                }
                "server_tool_use" | "advisor_tool_result" => out.extend(self.advisor_block(block, parent.clone())),
                _ => {}
            }
        }
        out
    }

    fn user(&mut self, v: &Value, parent: Option<String>) -> Vec<UiEvent> {
        let mut out = vec![];
        for block in v["message"]["content"].as_array().into_iter().flatten() {
            if block["type"] != "tool_result" {
                continue;
            }
            let id = block["tool_use_id"].as_str().unwrap_or("").to_string();
            let is_error = block["is_error"].as_bool().unwrap_or(false);
            let name = self.tools.get(&id).cloned().unwrap_or_default();
            if !is_error && EDIT_TOOLS.contains(&name.as_str()) {
                if let Some(ev) = edit_applied(&v["tool_use_result"], parent.clone(), &id) {
                    out.push(ev);
                }
            }
            let test_run = self.commands.remove(&id).and_then(|command| {
                let mut run = crate::test_runs::detect(&command, &full_output(&v["tool_use_result"], &block["content"]))?;
                // The command exited non-zero: the run failed even if its output didn't say so.
                if is_error {
                    run.outcome = crate::test_runs::Outcome::Failed;
                }
                Some(UiEvent::TestRun { parent: parent.clone(), tool_use_id: id.clone(), command, run })
            });
            out.push(UiEvent::ToolFinished {
                parent: parent.clone(),
                tool_use_id: id,
                is_error,
                output: truncate(&result_text(&block["content"]), OUTPUT_LIMIT),
            });
            out.extend(test_run);
        }
        out
    }

    fn block_index_for(&self, parent: &Option<String>, message_id: &str) -> u64 {
        match self.current_message.get(parent) {
            Some((id, idx)) if id == message_id => *idx,
            _ => 0,
        }
    }
}

fn edit_applied(r: &Value, parent: Option<String>, id: &str) -> Option<UiEvent> {
    let patch = r.get("structuredPatch")?.as_array()?;
    let path = r.get("filePath")?.as_str()?.to_string();
    let original = r.get("originalFile").and_then(Value::as_str).map(String::from);
    let created = original.is_none();
    let mut hunks: Vec<Hunk> = patch
        .iter()
        .map(|h| Hunk {
            old_start: h["oldStart"].as_u64().unwrap_or(0),
            old_lines: h["oldLines"].as_u64().unwrap_or(0),
            new_start: h["newStart"].as_u64().unwrap_or(0),
            new_lines: h["newLines"].as_u64().unwrap_or(0),
            lines: h["lines"].as_array().into_iter().flatten().filter_map(|l| l.as_str().map(String::from)).collect(),
        })
        .collect();
    if created && hunks.is_empty() {
        let lines: Vec<String> = r.get("content").and_then(Value::as_str).unwrap_or("").lines().map(|l| format!("+{l}")).collect();
        hunks.push(Hunk { old_start: 0, old_lines: 0, new_start: 1, new_lines: lines.len() as u64, lines });
    }
    Some(UiEvent::EditApplied { parent, tool_use_id: id.to_string(), path, created, hunks, original })
}

/// What the turn cost per model, from the result's modelUsage (the advisor's model shows up here too).
fn model_usage(v: &Value) -> UiEvent {
    let models = v["modelUsage"]
        .as_object()
        .map(|m| {
            m.iter()
                .map(|(model, u)| crate::ui_event::ModelCost {
                    model: model.clone(),
                    cost_usd: u["costUSD"].as_f64().unwrap_or(0.0),
                    input_tokens: u["inputTokens"].as_u64().unwrap_or(0) + u["cacheReadInputTokens"].as_u64().unwrap_or(0) + u["cacheCreationInputTokens"].as_u64().unwrap_or(0),
                    output_tokens: u["outputTokens"].as_u64().unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default();
    UiEvent::ModelUsage { models }
}

fn result_event(v: &Value) -> UiEvent {
    let is_error = v["is_error"].as_bool().unwrap_or(false);
    let result = v["result"].as_str().map(String::from);
    let lower = result.as_deref().unwrap_or("").to_lowercase();
    let auth_status = matches!(v["api_error_status"].as_u64(), Some(401) | Some(403));
    UiEvent::TurnDone {
        is_error,
        auth_hint: is_error && (auth_status || lower.contains("/login") || lower.contains("authentication")),
        result,
        cost_usd: v["total_cost_usd"].as_f64(),
        duration_ms: v["duration_ms"].as_u64(),
        denied: v["permission_denials"].as_array().map(|a| a.len()).unwrap_or(0),
        // Subagents may run on other models; the largest window is the main conversation's.
        context_window: v["modelUsage"].as_object().and_then(|m| m.values().filter_map(|u| u["contextWindow"].as_u64()).max()),
    }
}

/// What an `initialize` reply offers: the slash commands (built-ins, custom commands, skills) and the models.
/// Other control replies carry nothing to show.
fn initialize_events(v: &Value) -> Vec<UiEvent> {
    let reply = &v["response"]["response"];
    let s = |x: &Value, k: &str| x[k].as_str().unwrap_or("").to_string();
    let mut out = vec![];
    if let Some(list) = reply["commands"].as_array() {
        let commands = list
            .iter()
            .filter_map(|c| {
                Some(crate::ui_event::SlashCommand { name: c["name"].as_str()?.to_string(), description: s(c, "description"), argument_hint: s(c, "argumentHint") })
            })
            .collect();
        out.push(UiEvent::Commands { commands });
    }
    if let Some(list) = reply["models"].as_array() {
        let models = list
            .iter()
            .filter_map(|m| {
                Some(crate::ui_event::ModelOption {
                    value: m["value"].as_str()?.to_string(),
                    display_name: s(m, "displayName"),
                    description: s(m, "description"),
                    resolved_model: s(m, "resolvedModel"),
                    effort_levels: if m["supportsEffort"].as_bool() == Some(true) {
                        m["supportedEffortLevels"].as_array().into_iter().flatten().filter_map(|l| l.as_str().map(String::from)).collect()
                    } else {
                        vec![]
                    },
                })
            })
            .collect();
        out.push(UiEvent::Models { models });
    }
    out
}

/// Everything the API call read or wrote counts toward the context: fresh input, cached input, and the reply.
fn context_tokens(usage: &Value) -> Option<u64> {
    let fields = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"];
    let total: u64 = fields.iter().filter_map(|f| usage[f].as_u64()).sum();
    (total > 0).then_some(total)
}

/// One-line description of a tool call for its card header.
pub fn summarize(name: &str, input: &Value) -> String {
    let s = |k: &str| input.get(k).and_then(Value::as_str).map(String::from);
    let text = match name {
        "Bash" => s("command"),
        "Read" | "Edit" | "Write" | "MultiEdit" => s("file_path"),
        "NotebookEdit" => s("notebook_path"),
        "Grep" | "Glob" => s("pattern"),
        "WebFetch" => s("url"),
        "WebSearch" => s("query"),
        "Task" | "Agent" => s("description"),
        _ => None,
    };
    truncate(&text.unwrap_or_default(), 200)
}

/// A Bash step's whole output. Claude Code keeps only the first 30,000 characters inline; when there was more it saves
/// all of it to a file under the session's tool-results and records the path. Test summaries come last, so read that.
fn full_output(r: &Value, content: &Value) -> String {
    const MAX_READ: u64 = 32 << 20;
    if let Some(path) = r["persistedOutputPath"].as_str().filter(|p| p.contains("/tool-results/")) {
        if std::fs::metadata(path).is_ok_and(|m| m.len() <= MAX_READ) {
            if let Ok(bytes) = std::fs::read(path) {
                return String::from_utf8_lossy(&bytes).into_owned();
            }
        }
    }
    let streams: Vec<&str> = ["stdout", "stderr"].iter().filter_map(|k| r[*k].as_str()).filter(|s| !s.is_empty()).collect();
    if streams.is_empty() {
        result_text(content)
    } else {
        streams.join("\n")
    }
}

fn result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items.iter().filter_map(|i| i["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

fn str_of(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// Cuts `s` to `max` characters, appending `…` when anything was removed.
pub fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut t: String = s.chars().take(max).collect();
    t.push('…');
    t
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui_event::{Hunk, UiEvent};

    const WRITE_FIXTURE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/stream/write_create_and_error.jsonl"));
    const MISC_FIXTURE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/stream/edit_subagent_misc.jsonl"));

    fn parse_all(text: &str) -> Vec<UiEvent> {
        let mut p = StreamParser::default();
        text.lines().flat_map(|l| p.parse_line(l)).collect()
    }

    /// Shapes from a real CLI 2.1.293 run with --advisor and an Explore subagent (trimmed, paths changed).
    const ADVISOR_FIXTURE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/stream/advisor_subagents.jsonl"));

    #[test]
    fn says_who_runs_on_which_model_and_when_the_advisor_is_consulted() {
        let evs = parse_all(ADVISOR_FIXTURE);
        let picked: Vec<&UiEvent> = evs
            .iter()
            .filter(|e| matches!(e, UiEvent::AgentModel { .. } | UiEvent::AgentStarted { .. } | UiEvent::AgentProgress { .. } | UiEvent::AdvisorStarted { .. } | UiEvent::AdvisorDone { .. }))
            .collect();
        assert_eq!(
            picked,
            vec![
                // Streamed first, then again in the message: each once.
                &UiEvent::AdvisorStarted { parent: None, id: "srvtoolu_adv1".into() },
                &UiEvent::AdvisorDone { parent: None, id: "srvtoolu_adv1".into(), outcome: "reviewed".into(), error_code: None },
                &UiEvent::AgentModel { parent: None, model: "claude-haiku-5-5".into() },
                &UiEvent::AgentStarted { tool_use_id: "toolu_agent".into(), subagent_type: "Explore".into(), description: "List .ts files in src/lib".into(), model: None },
                &UiEvent::AgentProgress { tool_use_id: "toolu_agent".into(), description: "Finding **/*.ts".into(), tokens: 27572, tool_uses: 2, duration_ms: 5461 },
                &UiEvent::AgentModel { parent: Some("toolu_agent".into()), model: "claude-sonnet-5-5".into() },
                &UiEvent::AdvisorStarted { parent: None, id: "srvtoolu_adv2".into() },
                &UiEvent::AdvisorDone { parent: None, id: "srvtoolu_adv2".into(), outcome: "unavailable".into(), error_code: Some("overloaded".into()) },
            ]
        );
        let usage = evs.iter().find_map(|e| if let UiEvent::ModelUsage { models } = e { Some(models.clone()) } else { None }).unwrap();
        assert_eq!(usage.iter().map(|m| (m.model.as_str(), m.output_tokens)).collect::<Vec<_>>(), vec![("claude-haiku-5-5", 4491), ("claude-sonnet-5-5", 1708)]);
        assert!(matches!(evs.last().unwrap(), UiEvent::TurnDone { .. }));
    }

    #[test]
    fn init_lists_the_mcp_tools() {
        let mut p = StreamParser::default();
        let evs = p.parse_line(r#"{"type":"system","subtype":"init","session_id":"s","model":"m","cwd":"/p","tools":["Read","mcp__claude_ai_Linear__create_issue","mcp__lantern__reproduce"]}"#);
        assert_eq!(evs[1], UiEvent::McpTools { tools: vec!["mcp__claude_ai_Linear__create_issue".into(), "mcp__lantern__reproduce".into()] });
    }

    #[test]
    fn session_started_comes_first() {
        let evs = parse_all(WRITE_FIXTURE);
        assert_eq!(
            evs[0],
            UiEvent::SessionStarted {
                session_id: "fbc46b98-a81a-4d3c-b78e-f98203416065".into(),
                model: "claude-haiku-4-5-20251001".into(),
                cwd: "/tmp/proj".into(),
                permission_mode: "acceptEdits".into(),
                claude_version: "2.1.284".into(),
            }
        );
    }

    #[test]
    fn tools_start_in_order_with_summaries() {
        let started: Vec<(String, String)> = parse_all(WRITE_FIXTURE)
            .into_iter()
            .filter_map(|e| match e {
                UiEvent::ToolStarted { name, summary, .. } => Some((name, summary)),
                _ => None,
            })
            .collect();
        assert_eq!(
            started,
            vec![
                ("Write".into(), "/tmp/proj/hello.txt".into()),
                ("Write".into(), "/tmp/proj/new.txt".into()),
                ("Bash".into(), "python3 -c \"print(42)\"".into()),
                ("Read".into(), "/tmp/proj/hello.txt".into()),
                ("Write".into(), "/tmp/proj/hello.txt".into()),
            ]
        );
    }

    #[test]
    fn failed_write_has_no_edit_event() {
        let evs = parse_all(WRITE_FIXTURE);
        let id = "toolu_016uYgd8VB5iYX5EFbtPNaiB";
        assert!(!evs.iter().any(|e| matches!(e, UiEvent::EditApplied { tool_use_id, .. } if tool_use_id == id)));
        assert!(evs.iter().any(|e| matches!(e,
            UiEvent::ToolFinished { tool_use_id, is_error: true, output, .. }
                if tool_use_id == id && output.contains("File has not been read yet"))));
    }

    #[test]
    fn write_create_and_update_produce_edit_events() {
        let edits: Vec<UiEvent> = parse_all(WRITE_FIXTURE)
            .into_iter()
            .filter(|e| matches!(e, UiEvent::EditApplied { .. }))
            .collect();
        assert_eq!(
            edits,
            vec![
                UiEvent::EditApplied {
                    parent: None,
                    tool_use_id: "toolu_01Q4LMo7BQFk4xQNogTADq5G".into(),
                    path: "/tmp/proj/new.txt".into(),
                    created: true,
                    hunks: vec![Hunk { old_start: 0, old_lines: 0, new_start: 1, new_lines: 1, lines: vec!["+fresh".into()] }],
                    original: None,
                },
                UiEvent::EditApplied {
                    parent: None,
                    tool_use_id: "toolu_01P7Ho4kGd2iRYcCtpGTDrkm".into(),
                    path: "/tmp/proj/hello.txt".into(),
                    created: false,
                    hunks: vec![Hunk {
                        old_start: 1,
                        old_lines: 1,
                        new_start: 1,
                        new_lines: 1,
                        lines: vec!["-hi".into(), "+written".into(), "\\ No newline at end of file".into()],
                    }],
                    original: Some("hi\n".into()),
                },
            ]
        );
    }

    #[test]
    fn text_deltas_and_final_text_share_block_id() {
        let evs = parse_all(WRITE_FIXTURE);
        let block = "msg_011CfWXgJo8axo1rpW3N4dW9:1";
        let streamed: String = evs
            .iter()
            .filter_map(|e| match e {
                UiEvent::TextDelta { block_id, text, .. } if block_id == block => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(streamed, "I need to read hello.txt first before overwriting it.");
        assert!(evs.contains(&UiEvent::AssistantText {
            parent: None,
            block_id: block.into(),
            text: "I need to read hello.txt first before overwriting it.".into(),
        }));
    }

    /// Shapes from a real CLI 2.1.284 run.
    #[test]
    fn lists_slash_commands_and_models_from_initialize_and_reports_a_reset() {
        let mut p = StreamParser::default();
        let reply = r#"{"type":"control_response","response":{"subtype":"success","request_id":"lantern-1","response":{"commands":[{"name":"compact","description":"Clear conversation history but keep a summary","argumentHint":"<optional custom summarization instructions>"},{"name":"grill-me","description":"Interview the user (user)","argumentHint":""},{"description":"no name"}],"models":[{"value":"default","resolvedModel":"claude-opus-5-5","displayName":"Default (recommended)","description":"Opus 5.5 · Best for everyday, complex tasks"},{"value":"claude-fable-5-1","resolvedModel":"claude-fable-5-1","displayName":"Fable 5.1","description":"For your toughest challenges","supportsEffort":true,"supportedEffortLevels":["low","high","max"]}]}}}"#;
        let evs = p.parse_line(reply);
        let UiEvent::Models { models } = &evs[1] else { panic!("{evs:?}") };
        assert_eq!(models.iter().map(|m| (m.value.as_str(), m.display_name.as_str())).collect::<Vec<_>>(), vec![("default", "Default (recommended)"), ("claude-fable-5-1", "Fable 5.1")]);
        assert_eq!(models[0].resolved_model, "claude-opus-5-5");
        assert_eq!(models[1].effort_levels, vec!["low", "high", "max"]);
        assert!(models[0].effort_levels.is_empty(), "no supportsEffort, no levels");
        let UiEvent::Commands { commands } = &evs[0] else { panic!("{evs:?}") };
        assert_eq!(commands.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["compact", "grill-me"]);
        assert_eq!(commands[0].argument_hint, "<optional custom summarization instructions>");
        // Other control replies (interrupt, set_model) carry nothing to show.
        assert!(p.parse_line(r#"{"type":"control_response","response":{"subtype":"success","request_id":"lantern-2"}}"#).is_empty());
        assert_eq!(p.parse_line(r#"{"type":"conversation_reset"}"#), vec![UiEvent::ConversationReset]);
    }

    #[test]
    fn turn_done_is_last_and_stream_is_clean() {
        let evs = parse_all(WRITE_FIXTURE);
        assert_eq!(
            evs.last().unwrap(),
            &UiEvent::TurnDone {
                is_error: false,
                result: Some("Done: hello.txt overwritten, new.txt created, and Python printed 42.".into()),
                cost_usd: Some(0.0655884),
                duration_ms: Some(13908),
                auth_hint: false,
                denied: 0,
                context_window: None,
            }
        );
        assert!(!evs.iter().any(|e| matches!(e, UiEvent::Unknown { .. } | UiEvent::ParseError { .. })));
        assert_eq!(evs.iter().filter(|e| matches!(e, UiEvent::Thinking { .. })).count(), 4);
    }

    /// Shapes from a real CLI 2.1.284 run (trimmed).
    #[test]
    fn reports_context_use_from_main_thread_messages_and_the_window_from_the_result() {
        let usage = r#"{"input_tokens":10,"cache_creation_input_tokens":23120,"cache_read_input_tokens":14053,"output_tokens":4}"#;
        let mut p = StreamParser::default();
        let main = p.parse_line(&format!(r#"{{"type":"assistant","parent_tool_use_id":null,"message":{{"id":"m1","content":[{{"type":"text","text":"ok"}}],"usage":{usage}}}}}"#));
        assert_eq!(main[0], UiEvent::ContextUsed { tokens: 37_187 });
        let sub = p.parse_line(&format!(r#"{{"type":"assistant","parent_tool_use_id":"task1","message":{{"id":"m2","content":[],"usage":{usage}}}}}"#));
        assert!(sub.is_empty(), "a subagent's usage is its own context");
        let done = p.parse_line(r#"{"type":"result","is_error":false,"duration_ms":2000,"modelUsage":{"claude-opus-5-5[1m]":{"contextWindow":1000000},"claude-haiku-4-5-20251001":{"contextWindow":200000}}}"#);
        assert!(matches!(done.last().unwrap(), UiEvent::TurnDone { context_window: Some(1_000_000), .. }));
    }

    #[test]
    fn noise_is_ignored_and_edit_parsed() {
        let evs = parse_all(MISC_FIXTURE);
        assert!(matches!(evs[0], UiEvent::SessionStarted { .. }));
        assert_eq!(evs[1], UiEvent::Thinking { parent: None });
        assert!(evs.contains(&UiEvent::ToolStarted {
            parent: None,
            tool_use_id: "toolu_edit".into(),
            name: "Edit".into(),
            summary: "/tmp/proj/hello.txt".into(),
        }));
        assert!(evs.contains(&UiEvent::EditApplied {
            parent: None,
            tool_use_id: "toolu_edit".into(),
            path: "/tmp/proj/hello.txt".into(),
            created: false,
            hunks: vec![Hunk { old_start: 1, old_lines: 1, new_start: 1, new_lines: 1, lines: vec!["-hi".into(), "+hello".into()] }],
            original: Some("hi\n".into()),
        }));
    }

    #[test]
    fn subagent_events_carry_parent() {
        let evs = parse_all(MISC_FIXTURE);
        assert!(evs.contains(&UiEvent::ToolStarted {
            parent: None,
            tool_use_id: "toolu_task".into(),
            name: "Task".into(),
            summary: "Look around".into(),
        }));
        assert!(evs.contains(&UiEvent::ToolStarted {
            parent: Some("toolu_task".into()),
            tool_use_id: "toolu_sub_bash".into(),
            name: "Bash".into(),
            summary: "ls".into(),
        }));
        assert!(evs.contains(&UiEvent::ToolFinished {
            parent: Some("toolu_task".into()),
            tool_use_id: "toolu_sub_bash".into(),
            is_error: false,
            output: "hello.txt".into(),
        }));
        assert!(evs.contains(&UiEvent::ToolFinished {
            parent: None,
            tool_use_id: "toolu_task".into(),
            is_error: false,
            output: "Found hello.txt".into(),
        }));
    }

    #[test]
    fn retry_unknown_malformed_and_auth_error() {
        let evs = parse_all(MISC_FIXTURE);
        assert!(evs.contains(&UiEvent::Retrying { attempt: 1, max_retries: 10, error: "overloaded".into() }));
        assert!(evs.iter().any(|e| matches!(e, UiEvent::Unknown { raw } if raw["type"] == "brand_new_event_type")));
        assert!(evs.contains(&UiEvent::ParseError { line: "this line is not json".into() }));
        assert!(matches!(evs.last().unwrap(), UiEvent::TurnDone { is_error: true, auth_hint: true, denied: 1, .. }));
    }

    #[test]
    fn truncates_huge_tool_output() {
        let mut p = StreamParser::default();
        p.parse_line(r#"{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"cat big"}}]},"parent_tool_use_id":null}"#);
        let line = serde_json::json!({
            "type": "user",
            "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "x".repeat(10_000)}]},
            "parent_tool_use_id": null
        })
        .to_string();
        match &p.parse_line(&line)[0] {
            UiEvent::ToolFinished { output, .. } => {
                assert_eq!(output.chars().count(), OUTPUT_LIMIT + 1);
                assert!(output.ends_with('…'));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn unused_system_subtypes_are_ignored() {
        let mut p = StreamParser::default();
        for sub in ["task_updated", "some_future_subtype"] {
            let line = serde_json::json!({"type": "system", "subtype": sub, "session_id": "s", "tasks": []}).to_string();
            assert!(p.parse_line(&line).is_empty(), "{sub} should be ignored");
        }
    }

    #[test]
    fn background_tasks_come_as_the_whole_list() {
        let mut p = StreamParser::default();
        // As claude 2.1.284 sends it when a run_in_background command starts, and when it ends.
        let started = r#"{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"b2qyaawj0","task_type":"local_bash","description":"npm run dev"}],"session_id":"s"}"#;
        assert_eq!(
            p.parse_line(started),
            [UiEvent::BackgroundTasks { tasks: vec![crate::ui_event::BackgroundTask { id: "b2qyaawj0".into(), task_type: "local_bash".into(), description: "npm run dev".into() }] }]
        );
        let ended = r#"{"type":"system","subtype":"background_tasks_changed","tasks":[],"session_id":"s"}"#;
        assert_eq!(p.parse_line(ended), [UiEvent::BackgroundTasks { tasks: vec![] }]);
        // Which tool call started it, and how it ended (as claude 2.1.285 sends them).
        let started = r#"{"type":"system","subtype":"task_started","task_id":"b2qyaawj0","tool_use_id":"toolu_1","description":"npm run dev","is_backgrounded":true,"task_type":"local_bash"}"#;
        assert_eq!(p.parse_line(started), [UiEvent::TaskStarted { task_id: "b2qyaawj0".into(), tool_use_id: "toolu_1".into() }]);
        let note = r#"{"type":"system","subtype":"task_notification","task_id":"b2qyaawj0","tool_use_id":"toolu_1","status":"completed","summary":"Background command \"npm run dev\" completed (exit code 0)"}"#;
        assert_eq!(
            p.parse_line(note),
            [UiEvent::TaskEnded { task_id: "b2qyaawj0".into(), tool_use_id: "toolu_1".into(), status: "completed".into(), summary: "Background command \"npm run dev\" completed (exit code 0)".into() }]
        );
    }

    #[test]
    fn blank_lines_produce_nothing() {
        assert!(StreamParser::default().parse_line("   ").is_empty());
    }

    #[test]
    fn a_bash_step_that_ran_tests_reports_the_run_from_its_full_output() {
        let dir = tempfile::tempdir().unwrap();
        let saved = dir.path().join("tool-results");
        std::fs::create_dir(&saved).unwrap();
        let file = saved.join("b1.txt");
        // Claude Code kept only the start inline; the summary is at the end of the saved file.
        std::fs::write(&file, "test a ... ok\n(lots more)\ntest result: ok. 42 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 1.50s\n").unwrap();
        let mut p = StreamParser::default();
        let started = serde_json::json!({"type": "assistant", "message": {"id": "m", "content": [{"type": "tool_use", "id": "b1", "name": "Bash", "input": {"command": "cargo test"}}]}});
        p.parse_line(&started.to_string());
        let finished = serde_json::json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "b1", "content": "test a ... ok"}]}, "tool_use_result": {"stdout": "test a ... ok", "persistedOutputPath": file.to_str().unwrap()}});
        let events = p.parse_line(&finished.to_string());
        assert!(matches!(events[0], UiEvent::ToolFinished { .. }));
        match &events[1] {
            UiEvent::TestRun { tool_use_id, command, run, .. } => {
                assert_eq!((tool_use_id.as_str(), command.as_str()), ("b1", "cargo test"));
                assert_eq!((run.passed, run.skipped), (42, 1));
            }
            other => panic!("expected a test run, got {other:?}"),
        }
        // Not a test command: no run.
        let other = serde_json::json!({"type": "assistant", "message": {"id": "m2", "content": [{"type": "tool_use", "id": "b2", "name": "Bash", "input": {"command": "ls"}}]}});
        p.parse_line(&other.to_string());
        let done = serde_json::json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "b2", "content": "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.1s"}]}});
        assert_eq!(p.parse_line(&done.to_string()).len(), 1);
    }
}
