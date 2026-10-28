//! Claude Code: `claude -p` with stream-json in and out (see args::build_args).

use super::claude_session::ClaudeSession;
use super::{Capabilities, Provider, ProviderId};
use crate::session::{EditHook, Session, SessionConfig};
use crate::ui_event::Sink;
use std::path::PathBuf;

pub struct ClaudeProvider;

impl Provider for ClaudeProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Claude
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities { supports_auto_mode: true, supports_advisor: true, reports_cost_usd: true, supports_skills: true, supports_effort: true, model_switchable: true, supports_lantern_tools: true, can_lead_team: true, phone_approvals: true }
    }

    fn models(&self) -> &'static [&'static str] {
        &["opus", "sonnet", "haiku"]
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Claude Code does all of it: what every chat does today stays as it is.
    #[test]
    fn claude_can_do_everything_and_offers_its_three_aliases() {
        let c = ClaudeProvider.capabilities();
        assert!(c.supports_auto_mode && c.supports_advisor && c.reports_cost_usd && c.supports_skills && c.supports_effort && c.model_switchable && c.supports_lantern_tools && c.can_lead_team && c.phone_approvals);
        assert_eq!(ClaudeProvider.models(), ["opus", "sonnet", "haiku"]);
        assert!(ClaudeProvider.models().iter().all(|m| crate::args::valid_model(m)));
    }
}
