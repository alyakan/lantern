//! A chat's running agent, whichever provider it is: the config it is started from, and the handle the rest of the app
//! drives it with. What a session does on the wire is its provider's own (see provider/).

use crate::args::{HelperConfig, Mode};
use crate::provider::claude_session::ClaudeSession;
use crate::provider::ProviderId;
use crate::ui_event::Sink;
use std::path::PathBuf;
use std::sync::Arc;

/// Called for every successful edit with (path, content before the edit).
pub type EditHook = Arc<dyn Fn(&str, Option<String>) + Send + Sync>;

#[derive(Debug, Clone)]
pub struct SessionConfig {
    /// Whose CLI `binary` is, and so which provider starts it.
    pub provider: ProviderId,
    /// The provider's CLI executable.
    pub binary: PathBuf,
    pub folder: PathBuf,
    pub mode: Mode,
    /// In Step by step: Claude Code's auto mode instead of the in-app prompts (see build_args).
    pub auto_approve: bool,
    pub resume: Option<String>,
    /// `--model`; None uses Claude Code's default.
    pub model: Option<String>,
    /// `--effort`; None uses Claude Code's default.
    pub effort: Option<String>,
    /// `--advisor`: the model Claude consults at decision points; None leaves Claude Code's own setting.
    pub advisor: Option<String>,
    /// The model subagents run on (CLAUDE_CODE_SUBAGENT_MODEL); None leaves it to each subagent.
    pub subagent_model: Option<String>,
    pub helper: HelperConfig,
    /// PATH for the child (the user's login-shell PATH); None inherits ours.
    pub path_env: Option<String>,
}

/// One running agent process. An enum rather than a trait object: a session's calls are async, and each provider's has
/// its own state.
pub enum Session {
    Claude(ClaudeSession),
}

impl Session {
    /// Starts the agent `cfg.provider` names.
    pub fn spawn(cfg: &SessionConfig, sink: Sink, on_edit: EditHook) -> Result<Session, String> {
        cfg.provider.provider().spawn(cfg, sink, on_edit)
    }

    pub fn session_id(&self) -> Option<String> {
        match self {
            Session::Claude(s) => s.session_id(),
        }
    }

    /// The process id of the agent.
    pub fn pid(&self) -> u32 {
        match self {
            Session::Claude(s) => s.pid(),
        }
    }

    pub fn is_running(&self) -> bool {
        match self {
            Session::Claude(s) => s.is_running(),
        }
    }

    pub async fn send(&mut self, text: &str) -> Result<(), String> {
        match self {
            Session::Claude(s) => s.send(text).await,
        }
    }

    /// Says `text` to the agent, with `images` (the provider's own blocks for pictures) before it.
    pub async fn send_with(&mut self, text: &str, images: Vec<serde_json::Value>) -> Result<(), String> {
        match self {
            Session::Claude(s) => s.send_with(text, images).await,
        }
    }

    /// Ends the current turn; the agent keeps running.
    pub async fn interrupt(&mut self) {
        match self {
            Session::Claude(s) => s.interrupt().await,
        }
    }

    /// Switches the model from the next turn on; None goes back to the provider's default.
    pub async fn set_model(&mut self, model: Option<&str>) -> Result<(), String> {
        match self {
            Session::Claude(s) => s.set_model(model).await,
        }
    }

    /// What the agent is told right after it starts, which the provider's protocol may need before the first message.
    pub async fn initialize(&mut self) {
        match self {
            Session::Claude(s) => s.initialize().await,
        }
    }

    /// Shuts the process down on purpose; no SessionEnded event follows.
    pub async fn stop(self) {
        match self {
            Session::Claude(s) => s.stop().await,
        }
    }

    // Claude Code's own control protocol, which Settings and the Agents tab speak to it. They are on Claude's session
    // only: another provider answers these in its own way, or not at all.

    /// Stops one background task by its id.
    pub async fn stop_task(&mut self, task_id: &str) -> Result<(), String> {
        match self {
            Session::Claude(s) => s.stop_task(task_id).await,
        }
    }

    /// Sends a control request whose reply the caller wants (MCP status, reloading skills…); see ClaudeSession::request.
    pub async fn request(&mut self, request: serde_json::Value) -> Result<tokio::sync::oneshot::Receiver<Result<serde_json::Value, String>>, String> {
        match self {
            Session::Claude(s) => s.request(request).await,
        }
    }
}
