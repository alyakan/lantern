//! Gemini CLI's Agent Client Protocol messages as `UiEvent`s (the language every provider speaks to the UI): its
//! `session/update` notifications, the reply that ends a prompt, and its `session/request_permission` requests. Pure of any
//! process: the session feeds it one message at a time, so a conversation can be replayed in a test.
//!
//! Shapes are read from Gemini CLI 0.65.0's own ACP agent (its `acpSession` and the `@agentclientprotocol/sdk` it uses), not
//! from a description of it; fields are looked up leniently, since the protocol adds some with every release and a missing
//! one must not end a chat.

use super::codex_events::{str_of, visible, whole_file, Lookalikes, Mapped};
use super::gemini::AcpAgent;
use crate::stream_parser::{summarize, truncate, OUTPUT_LIMIT};
use crate::ui_event::{Hunk, ModelOption, UiEvent};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// What Gemini writes into the message stream when the approval mode changes: not part of the conversation.
const MODE_NOTE: &str = "[MODE_UPDATE] ";


/// An approval Gemini asks the user for, as a card, and the two answers it offers for it (only ever the ones for this one
/// action: an "allow for this session" option is never chosen).
#[derive(Debug, Clone, PartialEq)]
pub struct Approval {
    pub tool_name: String,
    /// What the card shows, every text already written out so that nothing in it can read as something else (see `visible`).
    pub input: Value,
    /// The option that allows this one action.
    pub allow: String,
    /// The option that refuses it, when Gemini offers one (it does: "Reject").
    pub reject: Option<String>,
}

/// An approval request that was read: a card to ask with, or why it can't be shown as it is. Gemini waits for an answer to
/// every request, so the second is declined at once (and said) and is never asked: what the user can't see can't be allowed.
pub type Request = Result<Approval, String>;

pub struct GeminiMapper {
    cwd: PathBuf,
    /// Tools announced and not yet finished, so a finish without a start still shows a step.
    open: HashSet<String>,
    /// The Lantern tool name each open tool call was shown as, and a command's text for test-run detection.
    names: HashMap<String, String>,
    commands: HashMap<String, String>,
    /// The message being streamed (Gemini sends it in pieces without an id), settled as a whole when something else begins.
    message: String,
    messages: u64,
    thinking: bool,
    declined: usize,
    session_tokens: u64,
    context_window: Option<u64>,
    /// The user's message being replayed (a loaded conversation's history), in the pieces Gemini sends it in.
    user: String,
    /// Which agent it reads (Gemini CLI or Antigravity): their names, and how each says a step was denied.
    agent: AcpAgent,
}

impl GeminiMapper {
    pub fn new(cwd: &Path) -> Self {
        Self::for_agent(cwd, AcpAgent::Gemini)
    }

    pub fn for_agent(cwd: &Path, agent: AcpAgent) -> Self {
        GeminiMapper { cwd: cwd.to_path_buf(), open: HashSet::new(), names: HashMap::new(), commands: HashMap::new(), message: String::new(), messages: 0, thinking: false, declined: 0, session_tokens: 0, context_window: None, user: String::new(), agent }
    }

    /// The `update` of a `session/update` notification.
    pub fn update(&mut self, u: &Value) -> Mapped {
        let mut m = Mapped::default();
        match u["sessionUpdate"].as_str().unwrap_or("") {
            "agent_message_chunk" => {
                if u["content"]["type"] == "text" {
                    let text = u["content"]["text"].as_str().unwrap_or("");
                    if !text.is_empty() && !text.starts_with(MODE_NOTE) {
                        self.message.push_str(text);
                        m.events.push(UiEvent::TextDelta { parent: None, block_id: self.block(), text: text.to_string() });
                    }
                }
            }
            "agent_thought_chunk" => {
                if !self.thinking {
                    self.thinking = true;
                    m.events.push(UiEvent::Thinking { parent: None });
                }
            }
            "tool_call" => {
                self.settle_message(&mut m);
                self.tool_started(u, &mut m);
            }
            "tool_call_update" => self.tool_update(u, &mut m),
            "usage_update" => {
                if let Some(tokens) = u["used"].as_u64().filter(|t| *t > 0) {
                    m.events.push(UiEvent::ContextUsed { tokens });
                }
                if let Some(size) = u["size"].as_u64().filter(|s| *s > 0) {
                    self.context_window = Some(size);
                }
            }
            // The plan, the commands on offer, the mode, the session's title, and the history Gemini replays on a loaded session
            // (said by the chat already): none of it is shown.
            _ => {}
        }
        m
    }

    /// An update of the history Gemini replays to a loaded conversation, as the chat keeps it: the user's messages, whole
    /// replies and the steps, but nothing that only matters while a turn streams.
    pub fn replay(&mut self, u: &Value) -> Vec<UiEvent> {
        if u["sessionUpdate"] == "user_message_chunk" {
            let mut m = Mapped::default();
            self.settle_message(&mut m);
            if u["content"]["type"] == "text" {
                self.user.push_str(u["content"]["text"].as_str().unwrap_or(""));
            }
            return m.events;
        }
        let mut out = self.flush_user();
        out.extend(self.update(u).events.into_iter().filter(|e| !matches!(e, UiEvent::TextDelta { .. } | UiEvent::Thinking { .. } | UiEvent::ContextUsed { .. })));
        out
    }

    /// The end of a replayed history: what was still being said is said whole.
    pub fn end_replay(&mut self) -> Vec<UiEvent> {
        let mut out = self.flush_user();
        let mut m = Mapped::default();
        self.settle_message(&mut m);
        out.extend(m.events);
        out
    }

    fn flush_user(&mut self) -> Vec<UiEvent> {
        let text = std::mem::take(&mut self.user);
        if text.trim().is_empty() {
            return vec![];
        }
        vec![UiEvent::UserText { text, at: None, sent_by: None, images: 0 }]
    }

    fn block(&self) -> String {
        format!("{}-message-{}", self.agent.slug(), self.messages)
    }

    /// The message so far is whole: it is said once, as the text it is.
    fn settle_message(&mut self, m: &mut Mapped) {
        if self.message.trim().is_empty() {
            self.message.clear();
            return;
        }
        m.events.push(UiEvent::AssistantText { parent: None, block_id: self.block(), text: std::mem::take(&mut self.message) });
        self.messages += 1;
    }

    fn tool_started(&mut self, u: &Value, m: &mut Mapped) {
        let id = str_of(u, "toolCallId");
        if id.is_empty() || !self.open.insert(id.clone()) {
            return;
        }
        let title = str_of(u, "title");
        let kind = str_of(u, "kind");
        let diffs = diffs_of(&u["content"]);
        let (name, summary) = match kind.as_str() {
            "execute" => {
                self.commands.insert(id.clone(), title.clone());
                ("Bash".to_string(), summarize("Bash", &json!({"command": visible(&title, true)})))
            }
            "read" => ("Read".to_string(), self.where_of(u, &title)),
            "edit" | "delete" | "move" => {
                let name = if !diffs.is_empty() && diffs.iter().all(|d| d.kind == "add") { "Write" } else { "Edit" };
                (name.to_string(), self.where_of(u, &title))
            }
            "search" => ("Grep".to_string(), truncate(&visible(&title, false), 200)),
            "fetch" => ("WebFetch".to_string(), truncate(&visible(&title, false), 200)),
            // Named as its own, so a tool of the agent's is never mistaken for one of Claude's.
            other => (visible(&format!("{}__{}", self.agent.slug(), if other.is_empty() { "tool" } else { other }), false), truncate(&visible(&title, false), 200)),
        };
        self.names.insert(id.clone(), name.clone());
        m.events.push(UiEvent::ToolStarted { parent: None, tool_use_id: id, name, summary });
    }

    /// The file or place a step is about: its first location, else its title.
    fn where_of(&self, u: &Value, title: &str) -> String {
        let at = u["locations"].as_array().and_then(|l| l.first()).and_then(|l| l["path"].as_str()).filter(|p| !p.is_empty());
        truncate(&visible(&at.map(|p| self.rel(p)).unwrap_or_else(|| title.to_string()), false), 200)
    }

    fn tool_update(&mut self, u: &Value, m: &mut Mapped) {
        let id = str_of(u, "toolCallId");
        if id.is_empty() {
            return;
        }
        let status = u["status"].as_str().unwrap_or("");
        // A step Gemini first mentions in its update is shown as it is told.
        if !self.open.contains(&id) {
            self.settle_message(m);
            self.tool_started(u, m);
        }
        if !matches!(status, "completed" | "failed") {
            return;
        }
        let diffs = diffs_of(&u["content"]);
        let text = text_of(&u["content"]);
        let done = status == "completed";
        let raw = u["rawOutput"].as_str().unwrap_or("");
        let denied = !done && (text.contains(self.agent.denied_note()) || raw.contains(self.agent.denied_note()));
        if denied {
            self.declined += 1;
        }
        if done {
            for d in &diffs {
                self.file_edit(&id, d, m);
            }
        }
        let output = if denied {
            "Declined.".to_string()
        } else if !text.is_empty() {
            text
        } else if done && !diffs.is_empty() {
            diffs.iter().map(|d| format!("{} {}", verb(&d.kind), self.rel(&d.path))).collect::<Vec<_>>().join("\n")
        } else {
            String::new()
        };
        let command = self.commands.remove(&id);
        self.names.remove(&id);
        self.open.remove(&id);
        m.events.push(UiEvent::ToolFinished { parent: None, tool_use_id: id.clone(), is_error: !done, output: truncate(&output, OUTPUT_LIMIT) });
        if let Some(command) = command {
            if let Some(mut run) = crate::test_runs::detect(&command, &output) {
                if !done {
                    run.outcome = crate::test_runs::Outcome::Failed;
                }
                m.events.push(UiEvent::TestRun { parent: None, tool_use_id: id, command, run });
            }
        }
    }

    /// One file of a finished edit: its hunks for the UI, and what it was before for the Changes pane. Gemini says both sides
    /// of the change itself, so the "before" is exact; it is recorded for Revert only for a file inside the chat's folder, since
    /// a path Revert would write back to is only trusted that far.
    fn file_edit(&mut self, id: &str, d: &Diff, m: &mut Mapped) {
        let at = self.abs(&d.path);
        let path = at.display().to_string();
        let created = d.kind == "add";
        let hunks = match d.kind.as_str() {
            "add" => whole_file(&d.new, '+'),
            "delete" => whole_file(&d.old, '-'),
            _ => diff_hunks(&d.old, &d.new),
        };
        let original = if created { None } else { Some(d.old.clone()) };
        m.events.push(UiEvent::EditApplied { parent: None, tool_use_id: id.to_string(), path: path.clone(), created, hunks, original: original.clone() });
        if self.inside(&d.path) {
            m.edits.push((path, original));
        }
    }

    /// The reply that ends a prompt (`session/prompt`): the turn is over, with what it used, or why it failed.
    pub fn turn_done(&mut self, reply: Result<&Value, (i64, &str)>, duration_ms: Option<u64>) -> Mapped {
        let mut m = Mapped::default();
        self.settle_message(&mut m);
        let name = self.agent.name();
        let (is_error, result, tokens, auth_hint) = match reply {
            Ok(v) => {
                let tokens = v["usage"]["totalTokens"].as_u64();
                let (is_error, result) = match v["stopReason"].as_str().unwrap_or("") {
                    "end_turn" => (false, None),
                    "cancelled" => (true, Some("interrupted".to_string())),
                    "max_tokens" => (true, Some(format!("{name}'s reply was cut off: the conversation reached the model's limit."))),
                    "max_turn_requests" => (true, Some(format!("{name} stopped: it reached its limit of steps for this conversation, or began to loop."))),
                    "refusal" => (true, Some(format!("{name} declined to answer."))),
                    other => (true, Some(format!("{name} stopped ({other})."))),
                };
                (is_error, result, tokens, false)
            }
            Err((code, message)) => {
                let auth = signed_out(code, message);
                let text = if auth { sign_in_text(self.agent, message) } else if message.is_empty() { "The turn failed.".to_string() } else { message.to_string() };
                (true, Some(text), None, auth)
            }
        };
        self.session_tokens += tokens.unwrap_or(0);
        m.events.push(UiEvent::TurnDone {
            is_error,
            result,
            // Gemini reports tokens, not dollars: nothing is made up.
            cost_usd: None,
            tokens,
            session_cost_usd: None,
            session_tokens: self.session_tokens,
            duration_ms,
            auth_hint,
            denied: self.declined,
            context_window: self.context_window,
        });
        self.open.clear();
        self.names.clear();
        self.commands.clear();
        self.thinking = false;
        self.declined = 0;
        m
    }

    /// A `session/request_permission` request: the card to show, or why there can't be one. The card says what Gemini will do
    /// from the request's own fields: a shell command is the tool call's `rawInput` (`command`, and `dir_path` for where it
    /// runs) when Gemini sends it, else its title, which for Gemini's shell tool is the command itself; the model's own
    /// description comes apart, as "Gemini says". "Runs in" is stated only when a structured field says where: Gemini's shell
    /// tool can run a command outside the chat's folder, and a folder named only in its words is not a fact Lantern checked.
    /// A file change lists every file with what happens to it. Anything that can't be shown that way is not asked.
    pub fn approval(&self, p: &Value) -> Request {
        let call = &p["toolCall"];
        let kind = call["kind"].as_str().unwrap_or("other");
        let title = call["title"].as_str().filter(|t| !t.trim().is_empty()).ok_or("it doesn't say what it would do")?;
        let option = |wanted: &str| p["options"].as_array().into_iter().flatten().find(|o| o["kind"] == wanted).and_then(|o| o["optionId"].as_str()).map(String::from);
        let allow = option("allow_once").ok_or("it offers no way to allow just this one action")?;
        let reject = option("reject_once");
        let mut seen = Lookalikes::default();
        let explanation = text_of(&call["content"]);
        let name = self.agent.name();
        let mut input = json!({"provider": self.agent.slug()});
        let mut extra: Vec<String> = Vec::new();
        let tool_name = match kind {
            "execute" => {
                let raw = &call["rawInput"];
                // Each agent's own field names only (Gemini CLI's shell tool: `command`, `dir_path`; Antigravity's
                // `run_command`: `CommandLine`, `Cwd`), so another field can never be what the card shows instead of what runs.
                let (command_key, dir_key) = match self.agent {
                    AcpAgent::Gemini => ("command", "dir_path"),
                    AcpAgent::Antigravity => ("commandline", "cwd"),
                };
                let command = one_of(raw, command_key, COMMAND_KEYS)?;
                let command = match command {
                    Some(c) if !c.trim().is_empty() => c,
                    // Gemini CLI may send no input at all; its shell tool's title is then the command itself.
                    None if !raw.is_object() && self.agent == AcpAgent::Gemini => title,
                    _ => return Err("it doesn't say exactly what it would run".into()),
                };
                input["command"] = seen.shown(command, true).into();
                let dir = one_of(raw, dir_key, DIR_KEYS)?.map(str::trim);
                match dir {
                    // No folder given: the agent's shell tool runs in the folder it was started in, which is the chat's.
                    _ if raw.is_object() && dir.is_none_or(str::is_empty) => input["cwd"] = seen.shown(&self.cwd.display().to_string(), false).into(),
                    Some(d) if !d.is_empty() => {
                        input["cwd"] = seen.shown(&self.abs(d).display().to_string(), false).into();
                        if !self.inside(d) {
                            extra.push("Runs outside this chat's folder.".into());
                        }
                    }
                    _ => extra.push(format!("{name} didn't say which folder this runs in: it may not be this chat's. Read its own words below.")),
                }
                "Bash"
            }
            "edit" | "delete" | "move" => {
                let diffs = diffs_of(&call["content"]);
                if diffs.is_empty() {
                    return Err("it doesn't say which files it changes".into());
                }
                let mut lines = Vec::new();
                let mut outside = Vec::new();
                for d in &diffs {
                    if d.path.is_empty() {
                        return Err("one of its files has no name".into());
                    }
                    let shown = seen.shown(&self.abs(&d.path).display().to_string(), false);
                    lines.push(match d.kind.as_str() {
                        "add" => format!("Create {shown}"),
                        "delete" => format!("Delete {shown}"),
                        _ => format!("Edit {shown}"),
                    });
                    if !self.inside(&d.path) {
                        outside.push(format!("Outside this chat's folder: {shown}"));
                    }
                }
                input["file_path"] = lines.join("\n").into();
                if !outside.is_empty() {
                    outside.dedup();
                    input["warnings"] = outside.into();
                }
                if diffs.iter().all(|d| d.kind == "add") { "Write" } else { "Edit" }
            }
            "fetch" => {
                input["action"] = seen.shown(title, false).into();
                "WebFetch"
            }
            // The agent's other tools (an MCP server's, a skill, a search): said by name as it gave it, which is all Lantern knows.
            _ => {
                input["action"] = format!("{name} wants to use a tool: {}", seen.shown(title, false)).into();
                if self.agent == AcpAgent::Gemini { "Gemini tool" } else { "Antigravity tool" }
            }
        };
        if !explanation.trim().is_empty() {
            input["description"] = seen.shown(&explanation, true).into();
        }
        if !extra.is_empty() {
            match input["warnings"].as_array_mut() {
                Some(list) => list.extend(extra.into_iter().map(Value::from)),
                None => input["warnings"] = extra.into(),
            }
        }
        if let Some(w) = seen.warning() {
            match input["warnings"].as_array_mut() {
                Some(list) => list.push(w.into()),
                None => input["warnings"] = json!([w]),
            }
        }
        Ok(Approval { tool_name: tool_name.into(), input, allow, reject })
    }

    /// Whether `path` is in the folder the chat is in, read as written (`..` taken at its word, no links followed).
    fn inside(&self, path: &str) -> bool {
        let mut parts: Vec<std::ffi::OsString> = Vec::new();
        for c in self.abs(path).components() {
            match c {
                std::path::Component::ParentDir => {
                    parts.pop();
                }
                std::path::Component::CurDir => {}
                other => parts.push(other.as_os_str().to_owned()),
            }
        }
        let root: PathBuf = self.cwd.components().filter(|c| !matches!(c, std::path::Component::CurDir)).collect();
        parts.iter().collect::<PathBuf>().starts_with(root)
    }

    fn abs(&self, path: &str) -> PathBuf {
        let p = Path::new(path);
        if p.is_absolute() { p.to_path_buf() } else { self.cwd.join(p) }
    }

    /// `path` as the folder the chat shows it.
    fn rel(&self, path: &str) -> String {
        self.abs(path).strip_prefix(&self.cwd).map(|p| p.display().to_string()).unwrap_or_else(|_| path.to_string())
    }
}

/// A file change inside a tool call's content: the path, whether it adds, deletes or modifies, and both sides of it.
#[derive(Debug, Clone)]
struct Diff {
    path: String,
    /// "add", "delete" or "modify" (Gemini's `_meta.kind`); one it doesn't say is a modification.
    kind: String,
    old: String,
    new: String,
}

fn diffs_of(content: &Value) -> Vec<Diff> {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["type"] == "diff")
        .map(|c| Diff {
            path: str_of(c, "path"),
            kind: match c["_meta"]["kind"].as_str() {
                Some(k @ ("add" | "delete")) => k.to_string(),
                _ => "modify".to_string(),
            },
            old: str_of(c, "oldText"),
            new: str_of(c, "newText"),
        })
        .collect()
}

/// The text a tool call's content says (a result, or the explanation of a request), one piece to a line.
fn text_of(content: &Value) -> String {
    content.as_array().into_iter().flatten().filter(|c| c["type"] == "content" && c["content"]["type"] == "text").filter_map(|c| c["content"]["text"].as_str()).collect::<Vec<_>>().join("\n")
}

fn verb(kind: &str) -> &'static str {
    match kind {
        "add" => "Created",
        "delete" => "Deleted",
        _ => "Edited",
    }
}

/// The hunks that turn `old` into `new`: three lines of context around each change, each line keeping its ` `, `+` or `-`.
fn diff_hunks(old: &str, new: &str) -> Vec<Hunk> {
    let diff = similar::TextDiff::from_lines(old, new);
    diff.grouped_ops(3)
        .iter()
        .filter_map(|group| {
            let (first, last) = (group.first()?, group.last()?);
            let (old_from, old_to) = (first.old_range().start, last.old_range().end);
            let (new_from, new_to) = (first.new_range().start, last.new_range().end);
            let lines = group
                .iter()
                .flat_map(|op| diff.iter_changes(op))
                .map(|c| {
                    let sign = match c.tag() {
                        similar::ChangeTag::Insert => '+',
                        similar::ChangeTag::Delete => '-',
                        similar::ChangeTag::Equal => ' ',
                    };
                    format!("{sign}{}", c.value().trim_end_matches(['\n', '\r']))
                })
                .collect();
            let (old_lines, new_lines) = ((old_to - old_from) as u64, (new_to - new_from) as u64);
            // A range with no lines starts after the line before it, as a unified diff says it.
            Some(Hunk { old_start: if old_lines == 0 { old_from as u64 } else { old_from as u64 + 1 }, old_lines, new_start: if new_lines == 0 { new_from as u64 } else { new_from as u64 + 1 }, new_lines, lines })
        })
        .collect()
}

/// Whether a failed request says Gemini has no sign-in to use.
pub fn signed_out(code: i64, message: &str) -> bool {
    let m = message.to_lowercase();
    code == 401 || code == 403 || m.contains("authentication required") || m.contains("not authenticated") || m.contains("unauthenticated") || m.contains("api key is missing") || m.contains("please set an auth method") || m.contains("log in") || m.contains("sign in")
}

/// Every name, in lower case, a shell tool's command or folder might go by.
const COMMAND_KEYS: &[&str] = &["command", "commandline", "cmd"];
const DIR_KEYS: &[&str] = &["dir_path", "directory", "cwd", "workdir", "dir"];

/// The value of `raw`'s field `own` (its name in lower case). Names are matched without regard to case, because an agent may
/// read them that way (Go's JSON does, and takes the last of two); so a request carrying more than one of `family`, or one
/// that isn't text, or one that isn't the agent's own, is not shown: what the card says might not be what runs.
fn one_of<'a>(raw: &'a Value, own: &str, family: &[&str]) -> Result<Option<&'a str>, String> {
    let Some(fields) = raw.as_object() else { return Ok(None) };
    // A name outside ASCII could fold to one of these under a reader's own case rules (Go's folds U+212A to k and U+017F
    // to s): none is expected, so none is read past.
    if fields.keys().any(|k| !k.is_ascii()) {
        return Err("its input has a field name outside plain ASCII, which could stand for another".into());
    }
    let found: Vec<(&String, &Value)> = fields.iter().filter(|(k, _)| family.contains(&k.to_lowercase().as_str())).collect();
    match found.as_slice() {
        [] => Ok(None),
        [(k, v)] if k.to_lowercase() == own => v.as_str().map(Some).ok_or_else(|| "it names what it would run, or where, as something other than text".to_string()),
        [_] => Err("it names what it would run, or where, under a name this agent doesn't use".into()),
        _ => Err("it names what it would run, or where, more than once".into()),
    }
}

/// What a turn that failed to sign in says, with how to fix it.
pub fn sign_in_text(agent: AcpAgent, message: &str) -> String {
    let said = if message.trim().is_empty() { String::new() } else { format!(" ({})", truncate(message.trim(), 200)) };
    format!("{} isn't signed in, or its sign-in expired{said}. {}, then send your message again.", agent.name(), agent.sign_in_hint())
}

/// Antigravity's models from a session's `configOptions`: each `model` option, with every `thought_level` as its effort
/// levels (the model ids themselves carry no level), and the model the session is on.
pub fn config_model_options(config: &Value) -> (Vec<ModelOption>, Option<String>) {
    let option = |id: &str| config.as_array().into_iter().flatten().find(|o| o["id"] == id).cloned().unwrap_or(Value::Null);
    let (model, level) = (option("model"), option("thought_level"));
    let levels: Vec<String> = level["options"].as_array().into_iter().flatten().filter_map(|o| o["value"].as_str()).filter(|v| crate::args::valid_model(v)).map(String::from).collect();
    let models = model["options"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|o| {
            let id = o["value"].as_str().filter(|i| crate::args::valid_model(i))?.to_string();
            Some(ModelOption { display_name: o["name"].as_str().filter(|n| !n.is_empty()).unwrap_or(&id).to_string(), description: str_of(o, "description"), resolved_model: id.clone(), effort_levels: levels.clone(), value: id })
        })
        .collect();
    (models, model["currentValue"].as_str().map(String::from))
}

/// The models Gemini offers (`models.availableModels` of a new session) as the picker lists them. Gemini has no effort
/// levels, so none are offered.
pub fn model_options(available: &Value) -> Vec<ModelOption> {
    available
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let id = m["modelId"].as_str().filter(|i| crate::args::valid_model(i))?.to_string();
            Some(ModelOption { display_name: m["name"].as_str().filter(|n| !n.is_empty()).unwrap_or(&id).to_string(), description: str_of(m, "description"), resolved_model: id.clone(), effort_levels: vec![], value: id })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mapper() -> GeminiMapper {
        GeminiMapper::new(Path::new("/work/proj"))
    }

    #[test]
    fn a_replayed_history_reads_back_as_the_users_messages_and_whole_replies() {
        let mut m = GeminiMapper::new(Path::new("/p"));
        let mut out = vec![];
        for u in [
            json!({"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "Fix "}}),
            json!({"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "the bug"}}),
            json!({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "hm"}}),
            json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Do"}}),
            json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "ne"}}),
            json!({"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "Thanks"}}),
            json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Welcome"}}),
        ] {
            out.extend(m.replay(&u));
        }
        out.extend(m.end_replay());
        let said: Vec<(String, String)> = out
            .iter()
            .map(|e| match e {
                UiEvent::UserText { text, .. } => ("user".into(), text.clone()),
                UiEvent::AssistantText { text, .. } => ("gemini".into(), text.clone()),
                other => ("other".into(), format!("{other:?}")),
            })
            .collect();
        assert_eq!(said, vec![("user".into(), "Fix the bug".into()), ("gemini".into(), "Done".into()), ("user".into(), "Thanks".into()), ("gemini".into(), "Welcome".into())]);
        assert!(m.end_replay().is_empty());
    }

    fn update(m: &mut GeminiMapper, u: Value) -> Mapped {
        m.update(&u)
    }

    fn request(kind: &str, title: &str, content: Value) -> Value {
        json!({
            "sessionId": "s1",
            "options": [{"optionId": "proceed_always", "name": "Allow for this session", "kind": "allow_always"}, {"optionId": "proceed_once", "name": "Allow", "kind": "allow_once"}, {"optionId": "cancel", "name": "Reject", "kind": "reject_once"}],
            "toolCall": {"toolCallId": "t1", "status": "pending", "title": title, "kind": kind, "content": content, "locations": []},
        })
    }

    #[test]
    fn a_message_streams_by_block_and_settles_as_the_whole_text_when_a_tool_begins() {
        let mut m = mapper();
        let a = update(&mut m, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Hel"}}));
        let b = update(&mut m, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "lo"}}));
        assert!(matches!(&a.events[0], UiEvent::TextDelta { block_id, text, .. } if block_id == "gemini-message-0" && text == "Hel"));
        assert!(matches!(&b.events[0], UiEvent::TextDelta { block_id, text, .. } if block_id == "gemini-message-0" && text == "lo"));
        let c = update(&mut m, json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "status": "in_progress", "title": "ls", "kind": "execute"}));
        assert!(matches!(&c.events[0], UiEvent::AssistantText { block_id, text, .. } if block_id == "gemini-message-0" && text == "Hello"));
        assert!(matches!(&c.events[1], UiEvent::ToolStarted { name, summary, .. } if name == "Bash" && summary == "ls"));
        // The next message is a block of its own.
        let d = update(&mut m, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Done"}}));
        assert!(matches!(&d.events[0], UiEvent::TextDelta { block_id, .. } if block_id == "gemini-message-1"));
    }

    #[test]
    fn a_mode_note_in_the_message_stream_is_not_conversation() {
        let mut m = mapper();
        let a = update(&mut m, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "[MODE_UPDATE] autoEdit"}}));
        assert!(a.events.is_empty());
        let t = m.turn_done(Ok(&json!({"stopReason": "end_turn"})), None);
        assert_eq!(t.events.len(), 1, "no empty message is settled");
    }

    #[test]
    fn thoughts_show_one_thinking_marker_for_the_turn() {
        let mut m = mapper();
        let t = json!({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "**Plan**\nx"}});
        assert_eq!(update(&mut m, t.clone()).events.len(), 1);
        assert!(update(&mut m, t.clone()).events.is_empty());
        m.turn_done(Ok(&json!({"stopReason": "end_turn"})), None);
        assert_eq!(update(&mut m, t).events.len(), 1, "a new turn thinks again");
    }

    #[test]
    fn a_shell_command_is_a_bash_step_with_its_output_and_an_error_when_it_fails() {
        let mut m = mapper();
        update(&mut m, json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "status": "in_progress", "title": "cargo test", "kind": "execute", "content": []}));
        let done = update(&mut m, json!({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed", "kind": "execute", "content": [{"type": "content", "content": {"type": "text", "text": "ok"}}]}));
        assert!(matches!(&done.events[0], UiEvent::ToolFinished { is_error: false, output, .. } if output == "ok"));
        update(&mut m, json!({"sessionUpdate": "tool_call", "toolCallId": "t2", "status": "in_progress", "title": "false", "kind": "execute"}));
        let failed = update(&mut m, json!({"sessionUpdate": "tool_call_update", "toolCallId": "t2", "status": "failed", "content": [{"type": "content", "content": {"type": "text", "text": "exit 1"}}]}));
        assert!(matches!(&failed.events[0], UiEvent::ToolFinished { is_error: true, output, .. } if output == "exit 1"));
    }

    #[test]
    fn a_tool_denied_by_the_user_is_an_error_step_and_counts_as_denied() {
        let mut m = mapper();
        update(&mut m, json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "status": "pending", "title": "rm -rf x", "kind": "execute"}));
        let f = update(&mut m, json!({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "failed", "content": [{"type": "content", "content": {"type": "text", "text": "Tool \"run_shell_command\" was canceled by the user."}}]}));
        assert!(matches!(&f.events[0], UiEvent::ToolFinished { is_error: true, output, .. } if output == "Declined."));
        let t = m.turn_done(Ok(&json!({"stopReason": "end_turn"})), None);
        assert!(matches!(&t.events[0], UiEvent::TurnDone { denied: 1, .. }));
    }

    #[test]
    fn an_edit_is_shown_with_its_hunks_and_its_exact_before_is_recorded() {
        let mut m = mapper();
        update(&mut m, json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "status": "in_progress", "title": "Edit a.txt", "kind": "edit", "locations": [{"path": "/work/proj/a.txt"}]}));
        let d = update(&mut m, json!({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed", "kind": "edit", "content": [{"type": "diff", "path": "/work/proj/a.txt", "oldText": "one\ntwo\nthree\n", "newText": "one\n2\nthree\n", "_meta": {"kind": "modify"}}]}));
        match &d.events[0] {
            UiEvent::EditApplied { path, created, hunks, original, .. } => {
                assert_eq!(path, "/work/proj/a.txt");
                assert!(!created);
                assert_eq!(original.as_deref(), Some("one\ntwo\nthree\n"));
                assert_eq!(hunks.len(), 1);
                assert_eq!(hunks[0].lines, vec![" one", "-two", "+2", " three"]);
                assert_eq!((hunks[0].old_start, hunks[0].old_lines, hunks[0].new_start, hunks[0].new_lines), (1, 3, 1, 3));
            }
            other => panic!("not an edit: {other:?}"),
        }
        assert_eq!(d.edits, vec![("/work/proj/a.txt".to_string(), Some("one\ntwo\nthree\n".to_string()))]);
        assert!(matches!(&d.events[1], UiEvent::ToolFinished { is_error: false, output, .. } if output == "Edited a.txt"));
    }

    #[test]
    fn a_created_file_has_no_before_and_a_deleted_one_has_its_text() {
        let mut m = mapper();
        update(&mut m, json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "status": "in_progress", "title": "Write", "kind": "edit"}));
        let c = update(&mut m, json!({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed", "content": [{"type": "diff", "path": "/work/proj/new.txt", "oldText": null, "newText": "hi\n", "_meta": {"kind": "add"}}]}));
        assert!(matches!(&c.events[0], UiEvent::EditApplied { created: true, original: None, hunks, .. } if hunks[0].lines == vec!["+hi"]));
        assert_eq!(c.edits, vec![("/work/proj/new.txt".to_string(), None)]);
        update(&mut m, json!({"sessionUpdate": "tool_call", "toolCallId": "t2", "status": "in_progress", "title": "Delete", "kind": "edit"}));
        let d = update(&mut m, json!({"sessionUpdate": "tool_call_update", "toolCallId": "t2", "status": "completed", "content": [{"type": "diff", "path": "/work/proj/old.txt", "oldText": "bye\n", "newText": "", "_meta": {"kind": "delete"}}]}));
        assert!(matches!(&d.events[0], UiEvent::EditApplied { created: false, original: Some(o), hunks, .. } if o == "bye\n" && hunks[0].lines == vec!["-bye"]));
    }

    #[test]
    fn an_edit_outside_the_folder_is_shown_but_never_recorded_for_revert() {
        let mut m = mapper();
        update(&mut m, json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "status": "in_progress", "title": "Edit", "kind": "edit"}));
        let d = update(&mut m, json!({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed", "content": [{"type": "diff", "path": "/work/proj/../elsewhere/x", "oldText": "a", "newText": "b", "_meta": {"kind": "modify"}}]}));
        assert!(matches!(&d.events[0], UiEvent::EditApplied { .. }));
        assert!(d.edits.is_empty());
    }

    #[test]
    fn a_turn_reports_tokens_and_no_dollars_and_a_second_turn_adds_to_the_session() {
        let mut m = mapper();
        update(&mut m, json!({"sessionUpdate": "usage_update", "used": 1200, "size": 1_000_000}));
        let t = m.turn_done(Ok(&json!({"stopReason": "end_turn", "usage": {"inputTokens": 90, "outputTokens": 10, "totalTokens": 100}})), Some(5));
        assert!(matches!(&t.events[0], UiEvent::TurnDone { is_error: false, cost_usd: None, tokens: Some(100), session_cost_usd: None, session_tokens: 100, duration_ms: Some(5), context_window: Some(1_000_000), auth_hint: false, .. }));
        let t = m.turn_done(Ok(&json!({"stopReason": "end_turn", "usage": {"totalTokens": 50}})), None);
        assert!(matches!(&t.events[0], UiEvent::TurnDone { tokens: Some(50), session_tokens: 150, .. }));
    }

    #[test]
    fn a_cancelled_or_cut_off_turn_ends_as_an_error_and_a_sign_in_failure_says_how_to_fix_it() {
        let mut m = mapper();
        let t = m.turn_done(Ok(&json!({"stopReason": "cancelled"})), None);
        assert!(matches!(&t.events[0], UiEvent::TurnDone { is_error: true, result: Some(r), .. } if r == "interrupted"));
        let t = m.turn_done(Ok(&json!({"stopReason": "max_tokens"})), None);
        assert!(matches!(&t.events[0], UiEvent::TurnDone { is_error: true, result: Some(r), .. } if r.contains("cut off")));
        let t = m.turn_done(Err((-32000, "Authentication required.")), None);
        assert!(matches!(&t.events[0], UiEvent::TurnDone { is_error: true, auth_hint: true, result: Some(r), .. } if r.contains("Run `gemini`")));
        let t = m.turn_done(Err((429, "Rate limit exceeded. Try again later.")), None);
        assert!(matches!(&t.events[0], UiEvent::TurnDone { is_error: true, auth_hint: false, result: Some(r), .. } if r == "Rate limit exceeded. Try again later."));
    }

    #[test]
    fn a_shell_card_is_the_command_as_gemini_will_run_it_with_where_and_its_own_words_apart() {
        let m = mapper();
        let mut req = request("execute", "cargo test --all", json!([{"type": "content", "content": {"type": "text", "text": "(run the tests)"}}]));
        req["toolCall"]["rawInput"] = json!({"command": "cargo test --all", "description": "run the tests"});
        let a = m.approval(&req).unwrap();
        assert_eq!(a.tool_name, "Bash");
        assert_eq!(a.input["provider"], "gemini");
        assert_eq!(a.input["command"], "cargo test --all");
        assert_eq!(a.input["cwd"], "/work/proj");
        assert!(a.input.get("warnings").is_none());
        assert_eq!(a.input["description"], "(run the tests)");
        // Only the options for this one action: never "allow for this session".
        assert_eq!(a.allow, "proceed_once");
        assert_eq!(a.reject.as_deref(), Some("cancel"));
    }

    #[test]
    fn a_shell_card_says_where_from_the_tool_input_and_never_claims_a_folder_it_was_not_told() {
        let m = mapper();
        // The structured input wins over the title, and its folder is the one shown.
        let mut req = request("execute", "ls", json!([{"type": "content", "content": {"type": "text", "text": "ls [in /work/proj] (list)"}}]));
        req["toolCall"]["rawInput"] = json!({"command": "rm -rf build", "dir_path": "/tmp/elsewhere"});
        let a = m.approval(&req).unwrap();
        assert_eq!(a.input["command"], "rm -rf build");
        assert_eq!(a.input["cwd"], "/tmp/elsewhere");
        assert_eq!(a.input["warnings"][0], "Runs outside this chat's folder.");
        // A folder relative to the chat's is read from there.
        req["toolCall"]["rawInput"] = json!({"command": "make", "dir_path": "sub"});
        let a = m.approval(&req).unwrap();
        assert_eq!(a.input["cwd"], "/work/proj/sub");
        assert!(a.input.get("warnings").is_none());
        // No structured input: the title is the command, no folder is stated, and the card says so.
        let a = m.approval(&request("execute", "ls", json!([{"type": "content", "content": {"type": "text", "text": "ls [in /tmp/elsewhere] (list)"}}]))).unwrap();
        assert_eq!(a.input["command"], "ls");
        assert!(a.input.get("cwd").is_none());
        assert!(a.input["warnings"][0].as_str().unwrap().contains("didn't say which folder"));
    }

    #[test]
    fn each_agent_s_command_is_read_from_its_own_field_and_a_second_differing_one_is_declined() {
        let agy = GeminiMapper::for_agent(Path::new("/work/proj"), AcpAgent::Antigravity);
        let mut req = request("execute", "ls", json!([]));
        let refused = |m: &GeminiMapper, r: &Value| m.approval(r).unwrap_err();
        req["toolCall"]["rawInput"] = json!({"CommandLine": "rm -rf ~", "command": "ls"});
        assert!(refused(&agy, &req).contains("more than once"));
        // A second spelling of its own name: a reader that ignores case (and takes the last) could run the other one.
        req["toolCall"]["rawInput"] = json!({"CommandLine": "ls", "commandline": "rm -rf ~"});
        assert!(refused(&agy, &req).contains("more than once"));
        req["toolCall"]["rawInput"] = json!({"CommandLine": "make", "Cwd": "/tmp/x", "dir_path": "/work/proj"});
        assert!(refused(&agy, &req).contains("more than once"));
        req["toolCall"]["rawInput"] = json!({"CommandLine": "ls", "Commandline\u{212A}": "x"});
        assert!(refused(&agy, &req).contains("outside plain ASCII"));
        req["toolCall"]["rawInput"] = json!({"CommandLine": ["rm", "-rf", "~"]});
        assert!(refused(&agy, &req).contains("other than text"));
        // No command of its own: the title is not taken for it.
        req["toolCall"]["rawInput"] = json!({"toolSummary": "clean"});
        assert!(refused(&agy, &req).contains("exactly what it would run"));
        req["toolCall"]["rawInput"] = json!({"command": "ls"});
        assert!(refused(&agy, &req).contains("doesn't use"));
        // Its own field, alone, in any case: what is shown, and its folder.
        req["toolCall"]["rawInput"] = json!({"commandLine": "make", "Cwd": "sub", "toolSummary": "build"});
        let a = agy.approval(&req).unwrap();
        assert_eq!((a.input["command"].as_str(), a.input["cwd"].as_str(), a.input["provider"].as_str()), (Some("make"), Some("/work/proj/sub"), Some("antigravity")));
        // Gemini CLI doesn't read Antigravity's names, but with no input at all its title is the command.
        let gemini = mapper();
        req["toolCall"]["rawInput"] = json!({"CommandLine": "rm -rf ~"});
        assert!(refused(&gemini, &req).contains("doesn't use"));
        req["toolCall"]["rawInput"] = json!({"command": "ls", "CommandLine": "ls"});
        assert!(refused(&gemini, &req).contains("more than once"));
        req["toolCall"].as_object_mut().unwrap().remove("rawInput");
        assert_eq!(gemini.approval(&req).unwrap().input["command"], "ls");
        assert!(refused(&agy, &req).contains("exactly what it would run"));
    }

    #[test]
    fn what_hides_in_a_command_is_written_out_and_lookalikes_are_said() {
        let m = mapper();
        let a = m.approval(&request("execute", "echo a\u{202e}b \u{0430}", json!([]))).unwrap();
        assert_eq!(a.input["command"], "echo a\\u{202e}b \u{0430}");
        assert!(a.input["warnings"].as_array().unwrap().iter().any(|w| w.as_str().unwrap().contains("U+0430")));
    }

    #[test]
    fn a_file_card_lists_every_file_with_what_happens_to_it_and_says_what_is_outside_the_folder() {
        let m = mapper();
        let content = json!([
            {"type": "diff", "path": "/work/proj/a.rs", "oldText": "x", "newText": "y", "_meta": {"kind": "modify"}},
            {"type": "diff", "path": "/work/proj/b.rs", "oldText": null, "newText": "z", "_meta": {"kind": "add"}},
            {"type": "diff", "path": "/etc/hosts", "oldText": "q", "newText": "", "_meta": {"kind": "delete"}},
        ]);
        let a = m.approval(&request("edit", "Edit", content)).unwrap();
        assert_eq!(a.tool_name, "Edit");
        assert_eq!(a.input["file_path"], "Edit /work/proj/a.rs\nCreate /work/proj/b.rs\nDelete /etc/hosts");
        assert_eq!(a.input["warnings"][0], "Outside this chat's folder: /etc/hosts");
        let only_new = m.approval(&request("edit", "Write", json!([{"type": "diff", "path": "/work/proj/n", "oldText": null, "newText": "z", "_meta": {"kind": "add"}}]))).unwrap();
        assert_eq!(only_new.tool_name, "Write");
    }

    #[test]
    fn a_file_name_cannot_add_a_line_to_the_card() {
        let m = mapper();
        let a = m.approval(&request("edit", "Edit", json!([{"type": "diff", "path": "/work/proj/a\nDelete /etc/passwd", "oldText": "x", "newText": "y", "_meta": {"kind": "modify"}}]))).unwrap();
        assert_eq!(a.input["file_path"], "Edit /work/proj/a\\u{a}Delete /etc/passwd");
    }

    #[test]
    fn a_request_that_cannot_be_shown_is_declined_not_asked() {
        let m = mapper();
        assert!(m.approval(&request("execute", "  ", json!([]))).unwrap_err().contains("doesn't say"));
        assert!(m.approval(&request("edit", "Edit", json!([]))).unwrap_err().contains("which files"));
        assert!(m.approval(&request("edit", "Edit", json!([{"type": "diff", "path": "", "oldText": "a", "newText": "b"}]))).unwrap_err().contains("no name"));
        let mut only_session = request("execute", "ls", json!([]));
        only_session["options"] = json!([{"optionId": "proceed_always", "name": "Allow for this session", "kind": "allow_always"}]);
        assert!(m.approval(&only_session).unwrap_err().contains("just this one"));
    }

    #[test]
    fn other_tools_are_asked_for_by_the_name_gemini_gave_and_a_fetch_is_a_web_fetch() {
        let m = mapper();
        let a = m.approval(&request("other", "mcp_server_tool", json!([]))).unwrap();
        assert_eq!(a.tool_name, "Gemini tool");
        assert!(a.input["action"].as_str().unwrap().contains("mcp_server_tool"));
        assert_eq!(m.approval(&request("fetch", "Fetch https://example.com", json!([]))).unwrap().tool_name, "WebFetch");
    }

    #[test]
    fn a_tool_named_like_a_built_in_is_not_taken_for_it() {
        let mut m = mapper();
        let e = update(&mut m, json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "status": "in_progress", "title": "Bash", "kind": "other"}));
        assert!(matches!(&e.events[0], UiEvent::ToolStarted { name, .. } if name == "gemini__other"));
    }

    #[test]
    fn the_models_it_offers_are_listed_by_the_names_it_takes() {
        let list = model_options(&json!([{"modelId": "auto", "name": "Auto", "description": "Let Gemini choose"}, {"modelId": "gemini-2.5-pro", "name": "Gemini 2.5 Pro"}, {"modelId": "bad model!", "name": "x"}]));
        assert_eq!(list.iter().map(|m| m.value.as_str()).collect::<Vec<_>>(), vec!["auto", "gemini-2.5-pro"]);
        assert!(list.iter().all(|m| m.effort_levels.is_empty()));
    }
}
