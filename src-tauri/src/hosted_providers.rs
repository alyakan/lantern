//! Hosted providers: companies that serve models over an Anthropic-compatible API, so Claude Code can be pointed at them with
//! nothing but an address and a key (DeepSeek today). A provider here is not a new agent CLI: connecting one makes an ordinary
//! endpoint (endpoints.rs) with its key in the Keychain (provider_keys.rs), so a chat on it, its key handling and its address
//! checks are the ones every endpoint already has.
//!
//! To add a provider, add one entry to `HOSTED`. The test below runs every entry through the same checks a user's endpoint gets.

use crate::endpoints::{Endpoint, EndpointStore};
use serde::Serialize;

pub struct HostedProvider {
    /// Never changed once shipped.
    pub id: &'static str,
    pub name: &'static str,
    /// Where `/v1/messages` is, as the provider documents it for Anthropic's API format.
    pub url: &'static str,
    /// The model ids it serves, as it names them; the first is a new chat's.
    pub models: &'static [&'static str],
    /// What a key looks like, for the field's hint.
    pub key_hint: &'static str,
    /// Where the user makes a key.
    pub key_page: &'static str,
}

pub const HOSTED: &[HostedProvider] = &[HostedProvider {
    id: "deepseek",
    name: "DeepSeek",
    url: "https://api.deepseek.com/anthropic",
    models: &["deepseek-v4-pro", "deepseek-flash"],
    key_hint: "sk-…",
    key_page: "https://platform.deepseek.com/api_keys",
}];

pub fn find(id: &str) -> Option<&'static HostedProvider> {
    HOSTED.iter().find(|p| p.id == id)
}

impl HostedProvider {
    fn endpoint(&self) -> Endpoint {
        Endpoint { id: String::new(), name: self.name.into(), url: self.url.into(), key_env: None, models: self.models.iter().map(|m| m.to_string()).collect(), auto_mode: false }
    }

    /// The endpoint the user already has for this provider: the one at its address.
    pub fn existing(&self, store: &EndpointStore) -> Option<Endpoint> {
        store.list().into_iter().find(|e| e.url.eq_ignore_ascii_case(self.url))
    }

    /// The endpoint for this provider, added (with its models) if the user has none yet. Others are left as they are.
    pub fn ensure_endpoint(&self, store: &EndpointStore) -> Result<Endpoint, String> {
        store.ensure(self.endpoint())
    }
}

/// What Settings shows of a provider. Never a key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HostedStatus {
    pub id: &'static str,
    pub name: &'static str,
    pub url: &'static str,
    pub models: Vec<&'static str>,
    pub key_hint: &'static str,
    pub key_page: &'static str,
    /// The endpoint made for it, once it has been connected (None until then).
    pub endpoint_id: Option<String>,
    /// A key is saved for that endpoint.
    pub connected: bool,
}

/// Every provider, with whether it is connected: `keyed` is the ids of the endpoints that have a saved key.
pub fn statuses(store: &EndpointStore, keyed: &[String]) -> Vec<HostedStatus> {
    HOSTED
        .iter()
        .map(|p| {
            let endpoint_id = p.existing(store).map(|e| e.id);
            let connected = endpoint_id.as_ref().is_some_and(|id| keyed.contains(id));
            HostedStatus { id: p.id, name: p.name, url: p.url, models: p.models.to_vec(), key_hint: p.key_hint, key_page: p.key_page, endpoint_id, connected }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::endpoints;

    #[test]
    fn every_provider_passes_what_a_users_endpoint_must() {
        let mut ids: Vec<&str> = Vec::new();
        for p in HOSTED {
            assert!(!ids.contains(&p.id), "{} is listed twice", p.id);
            ids.push(p.id);
            let cleaned = endpoints::clean(p.endpoint()).unwrap_or_else(|e| panic!("{}: {e}", p.id));
            assert_eq!(cleaned.url, p.url, "{}: the address must be as `clean` keeps it", p.id);
            assert!(endpoints::key_allowed_for(p.url).is_ok(), "{}: a key must be allowed to go there", p.id);
            assert!(p.url.starts_with("https://"), "{}: a hosted provider is over https", p.id);
            assert!(!p.models.is_empty() && p.models.iter().all(|m| endpoints::valid_endpoint_model(m)), "{}: models", p.id);
            assert!(p.key_page.starts_with("https://"), "{}: key page", p.id);
            assert!(p.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'), "{}: id", p.id);
        }
    }

    #[test]
    fn connecting_adds_the_endpoint_once_and_leaves_the_others() {
        let store = EndpointStore::load(None);
        store.replace(vec![Endpoint { id: String::new(), name: "Ollama".into(), url: "http://localhost:11434".into(), key_env: None, models: vec!["qwen3".into()], auto_mode: false }]).unwrap();
        let p = find("deepseek").unwrap();
        let first = p.ensure_endpoint(&store).unwrap();
        let again = p.ensure_endpoint(&store).unwrap();
        assert_eq!(first.id, again.id);
        assert_eq!(store.list().len(), 2);
        assert!(store.list().iter().any(|e| e.name == "Ollama"));
        assert_eq!(first.models, vec!["deepseek-v4-pro", "deepseek-flash"]);
    }

    #[test]
    fn connecting_cant_go_past_the_endpoint_limit() {
        let store = EndpointStore::load(None);
        let many = (0..endpoints::MAX_ENDPOINTS).map(|i| Endpoint { id: String::new(), name: format!("Local {i}"), url: format!("http://localhost:{}", 2000 + i), key_env: None, models: vec![], auto_mode: false }).collect();
        store.replace(many).unwrap();
        assert!(find("deepseek").unwrap().ensure_endpoint(&store).unwrap_err().contains("Up to"));
        assert_eq!(store.list().len(), endpoints::MAX_ENDPOINTS);
    }

    #[test]
    fn a_provider_is_connected_only_with_a_saved_key() {
        let store = EndpointStore::load(None);
        assert!(!statuses(&store, &[])[0].connected);
        let e = find("deepseek").unwrap().ensure_endpoint(&store).unwrap();
        assert!(!statuses(&store, &[])[0].connected);
        let s = &statuses(&store, std::slice::from_ref(&e.id))[0];
        assert!(s.connected);
        assert_eq!(s.endpoint_id.as_deref(), Some(e.id.as_str()));
    }
}
