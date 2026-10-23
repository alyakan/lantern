//! OpenAI's Codex CLI, driven through `codex app-server`: JSON-RPC over stdio (see codex_session.rs). The user signs in
//! to it themselves (`codex login` in a terminal); Lantern only starts their own `codex` and never touches a credential.

use super::codex_session::CodexSession;
use super::{Capabilities, Provider, ProviderId};
use crate::session::{EditHook, Session, SessionConfig};
use crate::ui_event::Sink;
use std::path::PathBuf;

pub struct CodexProvider;

/// The oldest `codex` whose app-server this provider was run against (0.150.0: initialize, account/read, model/list and
/// thread/start|resume all behaved as on the 0.162.1 the protocol schema was generated from). Older ones weren't tried.
pub const MIN_VERSION: (u64, u64, u64) = (0, 150, 0);

/// What Codex's `model/list` offered on 2026-10-14, headline models only, the default first. The live list (asked of the
/// session's own app-server) is what pickers show; this is for telling the main agent what to choose from, and Codex
/// rotates its models faster than this file does, so a model left out of a spawn_agent call means the CLI's own default.
const MODELS: &[&str] = &["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"];

impl Provider for CodexProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Codex
    }

    /// Codex has no auto mode (its `auto_review` reviewer is an approval reviewer, not a mode Lantern can hand a chat to),
    /// no advisor, no skills or slash commands of Claude's, and reports tokens but not dollars. Its effort and model are
    /// given with each turn.
    fn capabilities(&self) -> Capabilities {
        Capabilities { supports_auto_mode: false, supports_advisor: false, reports_cost_usd: false, supports_skills: false, supports_effort: true, model_switchable: true, supports_lantern_tools: false }
    }

    fn models(&self) -> &'static [&'static str] {
        MODELS
    }

    fn locate(&self, override_path: Option<&str>) -> Result<PathBuf, String> {
        crate::cli_locator::locate_codex(override_path)
    }

    fn version(&self, binary: &str, path_env: Option<&str>) -> Option<String> {
        crate::diagnostics::cli_version(binary, path_env)
    }

    fn spawn(&self, cfg: &SessionConfig, sink: Sink, on_edit: EditHook) -> Result<Session, String> {
        CodexSession::spawn(cfg, sink, on_edit).map(Session::Codex)
    }
}

/// The (major, minor, patch) in a version string like "codex-cli 0.162.1" or "0.163.0-alpha.2"; None if there isn't one.
pub fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let word = text.split_whitespace().find(|w| w.starts_with(|c: char| c.is_ascii_digit()))?;
    let core = word.split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

/// Whether a Codex that reports `version` speaks the protocol this provider does.
pub fn version_supported(version: (u64, u64, u64)) -> bool {
    version >= MIN_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_has_no_auto_mode_advisor_skills_or_dollar_cost_but_takes_effort_and_a_model_per_turn() {
        let c = CodexProvider.capabilities();
        assert!(!c.supports_auto_mode && !c.supports_advisor && !c.supports_skills && !c.reports_cost_usd && !c.supports_lantern_tools);
        assert!(c.supports_effort && c.model_switchable);
    }

    #[test]
    fn its_models_are_names_the_cli_takes_and_the_default_comes_first() {
        assert!(CodexProvider.models().iter().all(|m| crate::args::valid_model(m)));
        assert_eq!(CodexProvider.models()[0], "gpt-6.1-sol");
    }

    #[test]
    fn a_provider_saved_as_codex_reads_back_and_old_state_is_unaffected() {
        assert_eq!(serde_json::to_string(&ProviderId::Codex).unwrap(), "\"codex\"");
        assert_eq!(serde_json::from_str::<ProviderId>("\"codex\"").unwrap(), ProviderId::Codex);
        assert_eq!(serde_json::from_str::<ProviderId>("\"claude\"").unwrap(), ProviderId::Claude);
        assert_eq!(ProviderId::default(), ProviderId::Claude);
    }

    #[test]
    fn versions_are_read_from_what_codex_prints() {
        assert_eq!(parse_version("codex-cli 0.162.1"), Some((0, 162, 1)));
        assert_eq!(parse_version("0.163.0-alpha.2"), Some((0, 163, 0)));
        assert_eq!(parse_version("codex-cli"), None);
        assert_eq!(parse_version("1.2"), None);
    }

    #[test]
    fn only_a_codex_at_or_past_the_verified_protocol_is_supported() {
        assert!(version_supported(MIN_VERSION));
        assert!(version_supported((0, 162, 1)));
        assert!(version_supported((1, 0, 0)));
        assert!(!version_supported((0, 149, 9)));
    }
}
