//! The agent CLI behind a chat. Claude Code is the only one so far; a provider is what a chat needs from one: finding and
//! versioning its binary, and starting a session on it. Everything downstream of a session speaks `UiEvent`, so a provider
//! is whatever turns its CLI's protocol into those.
//!
//! The trait stops at what can be said without assuming the protocol: Claude Code takes stream-json lines on stdin and
//! needs an MCP tool to ask permission, but another CLI may speak JSON-RPC and ask in the protocol itself. So the parser
//! and the approval path belong to each provider's session, not to this trait.

pub mod claude;
pub mod claude_session;
pub mod codex;
pub mod codex_events;
pub mod codex_prompt;
pub mod codex_session;
pub mod gateway;

use crate::session::{EditHook, Session, SessionConfig};
use crate::ui_event::Sink;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Which agent CLI runs a chat. Chats saved before there was a choice have none, and are Claude's.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    #[default]
    Claude,
    /// OpenAI's Codex CLI, driven through `codex app-server`.
    Codex,
    /// Claude Code sent to an endpoint of the user's (see endpoints.rs). Not a CLI of its own, so not in `all()`: its choices
    /// are the endpoints, which the window is told from the saved list.
    Gateway,
    /// A stand-in with the capabilities of a CLI that has no auto mode, so tests can tell a provider's limits from Claude's.
    #[cfg(test)]
    Fake,
}

impl ProviderId {
    pub fn provider(self) -> &'static dyn Provider {
        match self {
            ProviderId::Claude => &claude::ClaudeProvider,
            ProviderId::Codex => &codex::CodexProvider,
            ProviderId::Gateway => &gateway::GatewayProvider,
            #[cfg(test)]
            ProviderId::Fake => &FakeProvider,
        }
    }

    /// Every provider this build knows, whether or not its CLI is installed.
    pub fn all() -> Vec<ProviderId> {
        #[allow(unused_mut)]
        let mut all = vec![ProviderId::Claude, ProviderId::Codex];
        #[cfg(test)]
        all.push(ProviderId::Fake);
        all
    }

    /// The name a user or the main agent calls it by (what the JSON form is).
    pub fn name(self) -> &'static str {
        match self {
            ProviderId::Claude => "claude",
            ProviderId::Codex => "codex",
            ProviderId::Gateway => "gateway",
            #[cfg(test)]
            ProviderId::Fake => "fake",
        }
    }

    pub fn info(self) -> ProviderInfo {
        ProviderInfo { id: self, capabilities: self.provider().capabilities() }
    }
}

/// What a provider can do, which the rest of the app asks instead of assuming it is Claude. Claude Code does all of it;
/// a CLI that lacks one says so here, and what depends on it falls back (see args::worker_mode) or is hidden.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Capabilities {
    /// It has an auto mode where the CLI itself decides what runs. Without one, a chat on it is never freer than Ask.
    pub supports_auto_mode: bool,
    /// It can consult an advisor model.
    pub supports_advisor: bool,
    /// Its turns report what they cost in dollars; otherwise only tokens are known.
    pub reports_cost_usd: bool,
    /// It has Claude Code's skills and slash commands.
    pub supports_skills: bool,
    /// It takes a thinking-effort level.
    pub supports_effort: bool,
    /// The model can be switched while the session runs; otherwise a change waits for the next start.
    pub model_switchable: bool,
    /// Lantern's own tools reach it (its MCP server: the Network tab's requests, the orchestra's): a provider without them is
    /// not asked to use them, and the window offers nothing that relies on them.
    pub supports_lantern_tools: bool,
    /// It can be the Lead of a team (start agents with Lantern's tools). For now only Claude Code can: a team is built on its Lead.
    pub can_lead_team: bool,
}

/// A provider and what it can do, as the window is told.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ProviderInfo {
    pub id: ProviderId,
    pub capabilities: Capabilities,
}

pub trait Provider: Send + Sync {
    fn id(&self) -> ProviderId;

    fn capabilities(&self) -> Capabilities;

    /// The models it offers by the names the CLI takes, for telling the main agent what to pick from. Other names that are
    /// the right shape are still accepted (a full model id, say).
    fn models(&self) -> &'static [&'static str];

    /// The CLI's executable: `override_path` when the user gave one, else where it is usually installed or on their
    /// login-shell PATH.
    fn locate(&self, override_path: Option<&str>) -> Result<PathBuf, String>;

    /// The version the CLI at `binary` reports; None when it won't say. `path_env` is the PATH a login shell gives, which
    /// a launcher script may need.
    fn version(&self, binary: &str, path_env: Option<&str>) -> Option<String>;

    /// Starts the CLI at `cfg.binary` on `cfg` and drives it from then on: its events go to `sink`, and every successful
    /// edit to `on_edit`.
    fn spawn(&self, cfg: &SessionConfig, sink: Sink, on_edit: EditHook) -> Result<Session, String>;
}

/// A CLI that is installed nowhere and does only what a Codex-like one would: no auto mode, advisor, dollar cost or skills.
#[cfg(test)]
pub struct FakeProvider;

#[cfg(test)]
impl Provider for FakeProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Fake
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities { supports_auto_mode: false, supports_advisor: false, reports_cost_usd: false, supports_skills: false, supports_effort: true, model_switchable: true, supports_lantern_tools: false, can_lead_team: false }
    }

    fn models(&self) -> &'static [&'static str] {
        &["fake-small", "fake-large"]
    }

    fn locate(&self, _: Option<&str>) -> Result<PathBuf, String> {
        Err("the fake CLI is not installed".into())
    }

    fn version(&self, _: &str, _: Option<&str>) -> Option<String> {
        None
    }

    fn spawn(&self, _: &SessionConfig, _: Sink, _: EditHook) -> Result<Session, String> {
        Err("the fake CLI cannot start".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chat_saved_before_there_was_a_choice_is_claudes() {
        assert_eq!(ProviderId::default(), ProviderId::Claude);
        assert_eq!(serde_json::from_str::<ProviderId>("\"claude\"").unwrap(), ProviderId::Claude);
        assert_eq!(serde_json::to_string(&ProviderId::Claude).unwrap(), "\"claude\"");
        assert_eq!(ProviderId::default().provider().id(), ProviderId::Claude);
    }

    #[test]
    fn a_provider_is_named_the_way_it_is_saved() {
        for id in ProviderId::all() {
            assert_eq!(serde_json::to_string(&id).unwrap(), format!("\"{}\"", id.name()));
            assert_eq!(id.provider().id(), id);
            assert_eq!(id.info().capabilities, id.provider().capabilities());
        }
    }

    /// A gateway is Claude Code sent elsewhere, so it is saved by its own name, but it is no CLI of its own to look for.
    #[test]
    fn a_gateway_is_saved_as_itself_and_is_not_a_cli_to_find() {
        assert_eq!(serde_json::to_string(&ProviderId::Gateway).unwrap(), "\"gateway\"");
        assert_eq!(serde_json::from_str::<ProviderId>("\"gateway\"").unwrap(), ProviderId::Gateway);
        assert_eq!(ProviderId::Gateway.provider().id(), ProviderId::Gateway);
        assert!(!ProviderId::all().contains(&ProviderId::Gateway));
    }

    #[test]
    fn what_a_provider_says_it_cannot_do_reaches_the_window_by_name() {
        let v = serde_json::to_value(ProviderId::Fake.info()).unwrap();
        assert_eq!(v["id"], "fake");
        assert_eq!(v["capabilities"]["supports_auto_mode"], false);
        assert_eq!(v["capabilities"]["supports_effort"], true);
    }
}
