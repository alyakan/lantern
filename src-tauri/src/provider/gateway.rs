//! A gateway chat: Claude Code, sent to an endpoint of the user's (see endpoints.rs) so it runs on a model that isn't Anthropic's.
//! It is the same `claude` process and the same stream-json, so everything downstream is Claude's; what differs is where it
//! goes (set in `ClaudeSession`'s command from `cfg.endpoint`) and what it can do, which is less.

use super::claude_session::ClaudeSession;
use super::{Capabilities, Provider, ProviderId};
use crate::session::{EditHook, Session, SessionConfig};
use crate::ui_event::Sink;
use std::path::PathBuf;

pub struct GatewayProvider;

impl Provider for GatewayProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Gateway
    }

    /// What it keeps of Claude Code (skills, Lantern's tools: they are Claude Code's own) and what it loses: Auto's classifier,
    /// the advisor and effort are Anthropic's models, and the dollars Claude Code reports are priced for Claude's. A Lead is
    /// Claude's for now: a team's Lead starting agents on any model comes with mixed presets.
    fn capabilities(&self) -> Capabilities {
        Capabilities { supports_auto_mode: false, supports_advisor: false, reports_cost_usd: false, supports_skills: true, supports_effort: false, model_switchable: true, supports_lantern_tools: true, can_lead_team: false, phone_approvals: true, supports_images: true, supports_compact: true, supports_clear: true }
    }

    /// An endpoint's models are the user's, on the endpoint (see endpoints.rs), not this provider's.
    fn models(&self) -> &'static [&'static str] {
        &[]
    }

    fn locate(&self, override_path: Option<&str>) -> Result<PathBuf, String> {
        crate::cli_locator::locate(override_path)
    }

    fn version(&self, binary: &str, path_env: Option<&str>) -> Option<String> {
        crate::diagnostics::claude_version(binary, path_env)
    }

    /// Never without an endpoint: started bare it would be Claude Code on the user's own Anthropic login, which is what a
    /// chat that chose another model must never silently be.
    fn spawn(&self, cfg: &SessionConfig, sink: Sink, on_edit: EditHook) -> Result<Session, String> {
        if cfg.endpoint.is_none() || cfg.model.is_none() {
            return Err("This chat runs on an endpoint that isn't set up any more, so it won't start on Claude instead.".into());
        }
        let forward: Sink = std::sync::Arc::new(move |event| {
            if !matches!(event, crate::ui_event::UiEvent::PlanUsage { .. } | crate::ui_event::UiEvent::WeekUsage { .. }) { sink(event); }
        });
        ClaudeSession::spawn(cfg, forward, on_edit).map(Session::Claude)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gateway_keeps_skills_and_lanterns_tools_and_loses_what_is_anthropics() {
        let c = GatewayProvider.capabilities();
        assert!(c.supports_skills && c.supports_lantern_tools && c.model_switchable && c.phone_approvals);
        assert!(!c.supports_auto_mode && !c.supports_advisor && !c.reports_cost_usd && !c.supports_effort && !c.can_lead_team);
        assert!(GatewayProvider.models().is_empty());
    }
}
