//! Google's Gemini CLI, driven as an Agent Client Protocol agent (`gemini --acp`): JSON-RPC over stdio (see gemini_session.rs).
//! The user signs in to it themselves (`gemini` in a terminal, or an API key in their own environment); Lantern only starts
//! their own `gemini` and never touches a credential, and never calls its `authenticate`.

use super::codex::parse_version;
use super::gemini_session::GeminiSession;
use super::{Capabilities, Provider, ProviderId};
use crate::session::{EditHook, Session, SessionConfig};
use crate::ui_event::Sink;
use std::path::PathBuf;

pub struct GeminiProvider;

/// The oldest `gemini` whose ACP agent this provider was run against (0.65.0: initialize, session/new, session/load,
/// session/prompt, session/set_mode, session/set_model and session/request_permission all as read from its source). Older
/// ones weren't tried.
pub const MIN_VERSION: (u64, u64, u64) = (0, 65, 0);

/// What Gemini CLI 0.65.0 offered by its own names, the automatic choice first. The live list (asked of the session itself)
/// is what pickers show; this is for telling the main agent what to choose from.
const MODELS: &[&str] = &["auto", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-3-pro-preview", "gemini-3-flash-preview"];

impl Provider for GeminiProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Gemini
    }

    /// Gemini has no auto mode (its `yolo` approves everything, which Lantern never hands a chat), no advisor, no Claude Code
    /// skills or slash commands, no thinking-effort level, and reports tokens but not dollars. Its model can be changed while
    /// the session runs. Pictures (ACP image blocks) and compacting aren't wired yet; Clear starts a fresh conversation.
    fn capabilities(&self) -> Capabilities {
        Capabilities { supports_auto_mode: false, supports_advisor: false, reports_cost_usd: false, supports_skills: false, supports_effort: false, model_switchable: true, supports_lantern_tools: false, can_lead_team: false, phone_approvals: true, supports_images: false, supports_compact: false, supports_clear: true, publishes_artifacts: false, supports_recap: false }
    }

    fn models(&self) -> &'static [&'static str] {
        MODELS
    }

    fn locate(&self, override_path: Option<&str>) -> Result<PathBuf, String> {
        crate::cli_locator::locate_gemini(override_path)
    }

    fn version(&self, binary: &str, path_env: Option<&str>) -> Option<String> {
        crate::diagnostics::cli_version(binary, path_env)
    }

    fn spawn(&self, cfg: &SessionConfig, sink: Sink, on_edit: EditHook) -> Result<Session, String> {
        GeminiSession::spawn(cfg, sink, on_edit).map(Session::Gemini)
    }
}

/// Whether a Gemini that reports `version` speaks the protocol this provider does.
pub fn version_supported(version: (u64, u64, u64)) -> bool {
    version >= MIN_VERSION
}

/// The (major, minor, patch) in what `gemini --version` or the ACP `initialize` reply says ("0.65.0").
pub fn version_of(text: &str) -> Option<(u64, u64, u64)> {
    parse_version(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gemini_has_no_auto_mode_advisor_skills_effort_or_dollar_cost_but_switches_its_model() {
        let c = GeminiProvider.capabilities();
        assert!(!c.supports_auto_mode && !c.supports_advisor && !c.supports_skills && !c.reports_cost_usd && !c.supports_effort && !c.supports_lantern_tools);
        assert!(c.model_switchable);
        // A team's Lead is Claude's; a phone answers Gemini's cards as it does Codex's (see GeminiSession::pending_permissions).
        assert!(!c.can_lead_team && c.phone_approvals);
        assert!(!c.supports_images && !c.supports_compact && c.supports_clear && !c.publishes_artifacts && !c.supports_recap);
    }

    #[test]
    fn its_models_are_names_the_cli_takes_and_the_automatic_choice_comes_first() {
        assert!(GeminiProvider.models().iter().all(|m| crate::args::valid_model(m)));
        assert_eq!(GeminiProvider.models()[0], "auto");
    }

    #[test]
    fn a_provider_saved_as_gemini_reads_back_and_old_state_is_unaffected() {
        assert_eq!(serde_json::to_string(&ProviderId::Gemini).unwrap(), "\"gemini\"");
        assert_eq!(serde_json::from_str::<ProviderId>("\"gemini\"").unwrap(), ProviderId::Gemini);
        assert_eq!(serde_json::from_str::<ProviderId>("\"codex\"").unwrap(), ProviderId::Codex);
        assert_eq!(serde_json::from_str::<ProviderId>("\"claude\"").unwrap(), ProviderId::Claude);
        assert_eq!(ProviderId::Gemini.provider().id(), ProviderId::Gemini);
    }

    #[test]
    fn versions_are_read_from_what_gemini_prints_and_only_one_at_or_past_the_verified_protocol_is_supported() {
        assert_eq!(version_of("0.65.0"), Some((0, 65, 0)));
        assert_eq!(version_of("0.66.1-preview.2"), Some((0, 66, 1)));
        assert_eq!(version_of("gemini"), None);
        assert!(version_supported(MIN_VERSION));
        assert!(version_supported((0, 70, 2)));
        assert!(version_supported((1, 0, 0)));
        assert!(!version_supported((0, 64, 9)));
    }
}
