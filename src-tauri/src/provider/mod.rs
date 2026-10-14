//! The agent CLI behind a chat. Claude Code is the only one so far; a provider is what a chat needs from one: finding and
//! versioning its binary, and starting a session on it. Everything downstream of a session speaks `UiEvent`, so a provider
//! is whatever turns its CLI's protocol into those.
//!
//! The trait stops at what can be said without assuming the protocol: Claude Code takes stream-json lines on stdin and
//! needs an MCP tool to ask permission, but another CLI may speak JSON-RPC and ask in the protocol itself. So the parser
//! and the approval path belong to each provider's session, not to this trait.

pub mod claude;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Which agent CLI runs a chat. Chats saved before there was a choice have none, and are Claude's.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    #[default]
    Claude,
}

impl ProviderId {
    pub fn provider(self) -> &'static dyn Provider {
        match self {
            ProviderId::Claude => &claude::ClaudeProvider,
        }
    }
}

pub trait Provider: Send + Sync {
    fn id(&self) -> ProviderId;

    /// The CLI's executable: `override_path` when the user gave one, else where it is usually installed or on their
    /// login-shell PATH.
    fn locate(&self, override_path: Option<&str>) -> Result<PathBuf, String>;

    /// The version the CLI at `binary` reports; None when it won't say. `path_env` is the PATH a login shell gives, which
    /// a launcher script may need.
    fn version(&self, binary: &str, path_env: Option<&str>) -> Option<String>;
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
}
