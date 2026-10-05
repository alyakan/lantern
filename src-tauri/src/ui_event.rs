use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;

/// Receives every event destined for the UI.
pub type Sink = Arc<dyn Fn(UiEvent) + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
    pub argument_hint: String,
}

/// A model claude offers. `value` is what `--model` takes ("default" means no flag).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModelOption {
    pub value: String,
    pub display_name: String,
    pub description: String,
    pub resolved_model: String,
    /// The thinking-effort levels it takes; empty when it has no effort setting (e.g. Haiku).
    pub effort_levels: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Hunk {
    pub old_start: u64,
    pub old_lines: u64,
    pub new_start: u64,
    pub new_lines: u64,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BackgroundTask {
    pub id: String,
    /// claude's task type: "local_bash", "local_agent", …
    pub task_type: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UiEvent {
    SessionStarted { session_id: String, model: String, cwd: String, permission_mode: String, claude_version: String },
    /// Something the user typed, and when (ms since the epoch, from the transcript). Live turns add these locally;
    /// only history replay emits them.
    UserText {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        at: Option<u64>,
    },
    Thinking { parent: Option<String> },
    TextDelta { parent: Option<String>, block_id: String, text: String },
    AssistantText { parent: Option<String>, block_id: String, text: String },
    ToolStarted { parent: Option<String>, tool_use_id: String, name: String, summary: String },
    EditApplied {
        parent: Option<String>,
        tool_use_id: String,
        path: String,
        created: bool,
        hunks: Vec<Hunk>,
        /// Content before this edit (None = file was created). Kept in Rust only.
        #[serde(skip_serializing)]
        original: Option<String>,
    },
    ToolFinished { parent: Option<String>, tool_use_id: String, is_error: bool, output: String },
    /// A Bash step that ran tests, read from its full output (sent right after its ToolFinished).
    TestRun { parent: Option<String>, tool_use_id: String, command: String, run: crate::test_runs::TestRun },
    Retrying { attempt: u64, max_retries: u64, error: String },
    /// `context_window`: the model's context size in tokens, from the result's per-model usage.
    TurnDone { is_error: bool, result: Option<String>, cost_usd: Option<f64>, duration_ms: Option<u64>, auth_hint: bool, denied: usize, context_window: Option<u64> },
    /// How many tokens the conversation takes up as of the latest main-thread API call.
    ContextUsed { tokens: u64 },
    /// What claude is running in the background now (a Bash command with run_in_background, a background agent…):
    /// the whole list each time it changes. They can outlive the turn; when one ends claude may reply on its own.
    BackgroundTasks { tasks: Vec<BackgroundTask> },
    /// A background task began, and the tool call that started it (a Bash step with run_in_background).
    TaskStarted { task_id: String, tool_use_id: String },
    /// A background task ended: "completed", "failed", "killed"…, and claude's one-line summary of it.
    TaskEnded { task_id: String, tool_use_id: String, status: String, summary: String },
    /// The slash commands this claude offers (reply to `initialize`).
    Commands { commands: Vec<SlashCommand> },
    /// The models it offers, in its own order: the recommended picks first, then older versions.
    Models { models: Vec<ModelOption> },
    /// `/clear` ran: the conversation starts over in the same process.
    ConversationReset,
    PermissionRequested { request_id: String, tool_name: String, input: Value },
    SessionEnded { code: Option<i32>, stderr_tail: String },
    Unknown { raw: Value },
    ParseError { line: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_with_kind_tag_and_without_original() {
        let ev = UiEvent::EditApplied {
            parent: None,
            tool_use_id: "t".into(),
            path: "/a".into(),
            created: false,
            hunks: vec![],
            original: Some("secret".into()),
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["kind"], "edit_applied");
        assert!(v.get("original").is_none());
    }
}
