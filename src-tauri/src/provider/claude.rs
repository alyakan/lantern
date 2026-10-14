//! Claude Code: `claude -p` with stream-json in and out (see args::build_args).

use super::claude_session::ClaudeSession;
use super::{Provider, ProviderId};
use crate::session::{EditHook, Session, SessionConfig};
use crate::ui_event::Sink;
use std::path::PathBuf;

pub struct ClaudeProvider;

impl Provider for ClaudeProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Claude
    }

    fn locate(&self, override_path: Option<&str>) -> Result<PathBuf, String> {
        crate::cli_locator::locate(override_path)
    }

    fn version(&self, binary: &str, path_env: Option<&str>) -> Option<String> {
        crate::diagnostics::claude_version(binary, path_env)
    }

    fn spawn(&self, cfg: &SessionConfig, sink: Sink, on_edit: EditHook) -> Result<Session, String> {
        ClaudeSession::spawn(cfg, sink, on_edit).map(Session::Claude)
    }
}
