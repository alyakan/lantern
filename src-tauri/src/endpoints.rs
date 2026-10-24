//! Endpoints: where a gateway chat's Claude Code sends its requests (a LiteLLM or OpenRouter URL, a local Ollama or LM Studio
//! server), so a chat can run on a model that isn't Anthropic's. An endpoint is a name, a URL, the NAME of an environment
//! variable that holds its key (never the key: Lantern keeps no secrets) and the model ids it serves.
//!
//! Claude Code is told to use it through its own environment, and three things about that were checked against a real
//! `claude` and a listener that logs what arrives (see `gateway_env`):
//!   - with only a base URL set, Claude Code sends the user's own Anthropic login to the endpoint, so every gateway launch
//!     sets an explicit token (the endpoint's key, or a placeholder for a local server), which outranks the login;
//!   - a settings file's `env` block outranks the process environment, so the URL and models go in the command line's own
//!     `--settings`, which outranks the files (the token can't: a command line is readable by any process of the user);
//!   - background calls name Claude's small model, which a gateway doesn't have, so every model slot is the chosen model.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const MAX_ENDPOINTS: usize = 20;
pub const MAX_MODELS: usize = 50;

/// What a no-key endpoint (a local server) is sent as its token. Non-empty, so the user's own Anthropic login is never used.
const PLACEHOLDER_TOKEN: &str = "lantern-no-key";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Endpoint {
    /// Made once from the first name and never changed: chats and settings saved against it survive a rename.
    #[serde(default)]
    pub id: String,
    pub name: String,
    /// Where `/v1/messages` is: http or https, with no login, query or fragment, and no trailing slash.
    pub url: String,
    /// The environment variable that holds its key, read from the user's login shell when a chat starts.
    #[serde(default)]
    pub key_env: Option<String>,
    /// The model ids it serves, as it names them (the first is a new chat's); a chat on it never starts with none.
    #[serde(default)]
    pub models: Vec<String>,
}

/// A secret that never prints: `SessionConfig` is Debug, and a key in a log or a panic message is a leak.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: String) -> Secret {
        Secret(value)
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(..)")
    }
}

/// What a gateway chat starts with: its endpoint, and its key as it is now (looked up when the chat starts).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayLaunch {
    pub id: String,
    pub url: String,
    pub key: Option<Secret>,
}

/// A model id as an endpoint names it ("qwen3-coder:30b", "openai/gpt-5", "claude-sonnet-4-5"): wider than Claude's aliases,
/// but never one that starts with '-' (it would read as a flag) or has a space or a quote in it.
pub fn valid_endpoint_model(m: &str) -> bool {
    (1..=100).contains(&m.len()) && m.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && m.chars().all(|c| c.is_ascii_alphanumeric() || "-._:/@+[]".contains(c))
}

/// An environment variable's name as a shell has them.
pub fn valid_key_env(n: &str) -> bool {
    (1..=64).contains(&n.len()) && n.chars().next().is_some_and(|c| c.is_ascii_uppercase() || c == '_') && n.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

fn loopback_or_local(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host == "localhost" || host.ends_with(".local") || host.ends_with(".localhost") {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Ok(std::net::IpAddr::V6(ip)) => ip.is_loopback(),
        Err(_) => false,
    }
}

/// An endpoint as the user wrote it, made safe to keep and to start Claude Code with, or why it can't be.
pub fn clean(e: Endpoint) -> Result<Endpoint, String> {
    let name: String = e.name.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string();
    if name.is_empty() || name.chars().count() > 40 {
        return Err("An endpoint needs a name of up to 40 characters.".into());
    }
    let parsed = reqwest::Url::parse(e.url.trim()).map_err(|_| format!("{:?} isn't a URL.", e.url.trim()))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("The URL has to start with http:// or https://.".into());
    }
    let Some(host) = parsed.host_str() else { return Err("The URL has no host.".into()) };
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Leave the login out of the URL: a key goes in an environment variable.".into());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("The URL is where the endpoint is, with no ? or # part.".into());
    }
    let key_env = match e.key_env.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        Some(k) if valid_key_env(k) => Some(k.to_string()),
        Some(k) => return Err(format!("{k:?} isn't an environment variable's name (capital letters, digits and _).")),
        None => None,
    };
    // A key sent over plain http across the internet is readable by whoever is on the way.
    if key_env.is_some() && parsed.scheme() == "http" && !loopback_or_local(host) {
        return Err("A key is only sent over https, or http to this Mac or its own network.".into());
    }
    let mut models: Vec<String> = Vec::new();
    for m in e.models.iter().map(|m| m.trim()).filter(|m| !m.is_empty()) {
        if !valid_endpoint_model(m) {
            return Err(format!("{m:?} isn't a model id (letters, digits and - . _ : / @ + only)."));
        }
        if !models.iter().any(|x| x == m) {
            models.push(m.to_string());
        }
    }
    if models.len() > MAX_MODELS {
        return Err(format!("An endpoint lists up to {MAX_MODELS} models."));
    }
    Ok(Endpoint { id: e.id, name, url: parsed.as_str().trim_end_matches('/').to_string(), key_env, models })
}

/// An id from a name: lower-case letters and digits with '-', and made unique among `taken` by a number.
fn make_id(name: &str, taken: &[String]) -> String {
    let mut slug: String = name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    slug = slug.split('-').filter(|s| !s.is_empty()).collect::<Vec<_>>().join("-");
    if slug.is_empty() {
        slug = "endpoint".into();
    }
    let slug: String = slug.chars().take(24).collect();
    let mut id = slug.clone();
    let mut n = 2;
    while taken.contains(&id) {
        id = format!("{slug}-{n}");
        n += 1;
    }
    id
}

/// The endpoints the user has set up, kept in the app's data folder.
pub struct EndpointStore {
    path: Option<PathBuf>,
    items: Mutex<Vec<Endpoint>>,
}

impl EndpointStore {
    /// What is saved at `path`; none (a missing or unreadable file) is no endpoints. Each one is checked again as it is read, and
    /// one that wouldn't be saved now (a file edited by hand: a key over http to a public host, say) is left out.
    pub fn load(path: Option<PathBuf>) -> EndpointStore {
        let items = path
            .as_deref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice::<Vec<Endpoint>>(&b).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|e| !e.id.is_empty())
            .filter_map(|e| {
                let id = e.id.clone();
                clean(e).ok().map(|e| Endpoint { id, ..e })
            })
            .collect();
        EndpointStore { path, items: Mutex::new(items) }
    }

    pub fn list(&self) -> Vec<Endpoint> {
        self.items.lock().unwrap().clone()
    }

    pub fn get(&self, id: &str) -> Option<Endpoint> {
        self.items.lock().unwrap().iter().find(|e| e.id == id).cloned()
    }

    /// Replaces them all with `wanted`: one that names an id we have keeps it, any other is new and gets one.
    pub fn replace(&self, wanted: Vec<Endpoint>) -> Result<Vec<Endpoint>, String> {
        if wanted.len() > MAX_ENDPOINTS {
            return Err(format!("Up to {MAX_ENDPOINTS} endpoints."));
        }
        let mut items = self.items.lock().unwrap();
        let mut next: Vec<Endpoint> = Vec::new();
        for e in wanted {
            let known = !e.id.is_empty() && items.iter().any(|x| x.id == e.id) && !next.iter().any(|x| x.id == e.id);
            let mut e = clean(e)?;
            if next.iter().any(|x| x.name.eq_ignore_ascii_case(&e.name)) {
                return Err(format!("Two endpoints are called {:?}.", e.name));
            }
            if !known {
                e.id = make_id(&e.name, &next.iter().chain(items.iter()).map(|x| x.id.clone()).collect::<Vec<_>>());
            }
            next.push(e);
        }
        if let Some(path) = &self.path {
            write_atomic(path, &serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?)?;
        }
        *items = next.clone();
        Ok(next)
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't save the endpoints: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, path)).map_err(|e| format!("Couldn't save the endpoints: {e}"))
}

/// Environment that would send a request somewhere else, or as someone else, than the endpoint says: taken out of a gateway
/// chat's Claude Code, whatever the user's shell has set.
const REMOVED_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "ANTHROPIC_FOUNDRY_RESOURCE",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
];

/// The `env` block for the command line's `--settings`: everything that says where to go and on what model, which outranks a
/// settings file's own `env` (checked), and is no secret.
fn settings_env(url: &str, model: &str) -> serde_json::Value {
    let mut env = serde_json::json!({
        "ANTHROPIC_BASE_URL": url,
        "ANTHROPIC_MODEL": model,
        "ANTHROPIC_DEFAULT_OPUS_MODEL": model,
        "ANTHROPIC_DEFAULT_SONNET_MODEL": model,
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": model,
        "ANTHROPIC_DEFAULT_FABLE_MODEL": model,
        "ANTHROPIC_SMALL_FAST_MODEL": model,
        "CLAUDE_CODE_SUBAGENT_MODEL": model,
        // Claude Code's telemetry goes to Anthropic without the gateway's key: a chat on another model sends nothing there.
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    });
    // An empty value is "not set" to Claude Code (its docs), which is how a stale one in a settings file is switched off.
    for cloud in ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_ANTHROPIC_AWS"] {
        env[cloud] = "".into();
    }
    env
}

/// What a gateway chat's Claude Code is started with, besides the usual: the `--settings` env block (no secret in it, as the
/// command line is readable by every process of the user), and the environment to set and to remove (the token among them).
pub struct GatewayEnv {
    pub settings: serde_json::Value,
    pub remove: &'static [&'static str],
    pub set: Vec<(&'static str, String)>,
}

pub fn gateway_env(g: &GatewayLaunch, model: &str) -> GatewayEnv {
    let token = g.key.as_ref().map(|k| k.expose().to_string()).unwrap_or_else(|| PLACEHOLDER_TOKEN.to_string());
    GatewayEnv { settings: serde_json::json!({ "env": settings_env(&g.url, model) }), remove: REMOVED_ENV, set: vec![("ANTHROPIC_AUTH_TOKEN", token)] }
}

/// The settings files that could put a credential or a place to send requests of their own over a gateway's token: the
/// user's, and the project's two. Their `env` names, if any are ones that would (the `--settings` env blocks the URL and the
/// models, but a token can't be put there).
pub fn settings_conflict(home: &Path, folder: &Path) -> Option<String> {
    const CLASH: &[&str] = &["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];
    let files = [home.join(".claude/settings.json"), folder.join(".claude/settings.json"), folder.join(".claude/settings.local.json")];
    for file in files {
        let Some(v) = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()) else { continue };
        if let Some(name) = CLASH.iter().find(|k| v["env"].get(**k).is_some()) {
            return Some(format!("{} sets {name}, which would be sent to this endpoint in place of its key. Take it out of that file, or run this chat on Claude.", file.display()));
        }
    }
    None
}

/// How long the endpoint has to answer a model list, and the most of its reply that is read.
const FETCH_TIME: std::time::Duration = std::time::Duration::from_secs(6);
const FETCH_MAX_BYTES: usize = 1_000_000;

/// The model ids in a `/v1/models` reply (`{"data":[{"id":...}]}`, which Anthropic's, OpenAI's and most gateways' lists are):
/// the ones that are usable ids, once each, up to the most an endpoint lists.
pub fn parse_models(body: &[u8]) -> Vec<String> {
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(body) else { return Vec::new() };
    let mut out: Vec<String> = Vec::new();
    for id in v["data"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str()) {
        if valid_endpoint_model(id) && !out.iter().any(|x| x == id) && out.len() < MAX_MODELS {
            out.push(id.to_string());
        }
    }
    out
}

/// Asks the endpoint what models it serves. Any failure is an error in words, and the user types them instead. Redirects
/// aren't followed: the key is for this URL, not for wherever it might send the request.
pub async fn fetch_models(url: &str, key: Option<&Secret>) -> Result<Vec<String>, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder().timeout(FETCH_TIME).redirect(reqwest::redirect::Policy::none()).build().map_err(|e| e.to_string())?;
    let mut request = client.get(format!("{url}/v1/models")).header("anthropic-version", "2023-06-01");
    if let Some(k) = key {
        request = request.bearer_auth(k.expose());
    }
    let mut response = request.send().await.map_err(|e| if e.is_timeout() { "It didn't answer in time.".to_string() } else { "Couldn't reach it. Is it running?".to_string() })?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 | 403 => "It refused the key (or wants one).".to_string(),
            404 => "It doesn't list its models here: type them instead.".to_string(),
            code => format!("It answered {code}."),
        });
    }
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Its answer was cut off.".to_string())? {
        body.extend_from_slice(&chunk);
        if body.len() > FETCH_MAX_BYTES {
            return Err("Its list is too long to read.".into());
        }
    }
    let models = parse_models(&body);
    if models.is_empty() {
        return Err("It listed no models Lantern can use: type them instead.".into());
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ep(name: &str, url: &str) -> Endpoint {
        Endpoint { id: String::new(), name: name.into(), url: url.into(), key_env: None, models: vec![] }
    }

    #[test]
    fn model_ids_are_what_endpoints_call_them_and_never_flags() {
        for ok in ["qwen3-coder:30b", "openai/gpt-5", "claude-sonnet-4-5", "meta-llama/Llama-3.3-70B@q4", "gpt-oss:20b", "opus[1m]"] {
            assert!(valid_endpoint_model(ok), "{ok}");
        }
        for bad in ["", "-x", "--bare", "a b", "a;b", "a\"b", "a$(x)", "a\nb", &"x".repeat(101)] {
            assert!(!valid_endpoint_model(bad), "{bad:?}");
        }
        // Claude's own rule stays narrower: it is what a Claude chat's model is checked with.
        assert!(!crate::args::valid_model("qwen3-coder:30b"));
    }

    #[test]
    fn a_key_variable_is_a_shell_name() {
        assert!(valid_key_env("OPENROUTER_API_KEY") && valid_key_env("_X1"));
        for bad in ["", "1X", "lower", "A-B", "A B", "A=B", "$X", "A;B"] {
            assert!(!valid_key_env(bad), "{bad:?}");
        }
    }

    #[test]
    fn an_endpoint_is_cleaned_or_refused_with_why() {
        let ok = clean(Endpoint { models: vec![" qwen3 ".into(), "qwen3".into(), "".into(), "llama3".into()], ..ep("  Ollama  ", "http://localhost:11434/") }).unwrap();
        assert_eq!((ok.name.as_str(), ok.url.as_str(), ok.models.as_slice()), ("Ollama", "http://localhost:11434", ["qwen3".to_string(), "llama3".to_string()].as_slice()));
        for (bad, why) in [
            (ep("", "http://localhost:1"), "name"),
            (ep("a", "localhost:1234"), "URL"),
            (ep("a", "ftp://x.test"), "http"),
            (ep("a", "https://user:pw@x.test"), "login"),
            (ep("a", "https://x.test/?key=1"), "? or #"),
            (Endpoint { key_env: Some("lower".into()), ..ep("a", "https://x.test") }, "environment variable"),
            (Endpoint { models: vec!["--bare".into()], ..ep("a", "https://x.test") }, "model id"),
        ] {
            let e = clean(bad).unwrap_err();
            assert!(e.contains(why), "{e}");
        }
    }

    /// A key is never sent in the clear across the internet, but a local server (or one on the network) is fine without https.
    #[test]
    fn a_key_goes_over_https_or_to_this_mac_and_its_own_network() {
        let keyed = |url: &str| clean(Endpoint { key_env: Some("K".into()), ..ep("a", url) });
        for ok in ["https://openrouter.ai/api", "http://localhost:4000", "http://127.0.0.1:4000", "http://192.168.1.5:4000", "http://[::1]:4000", "http://studio.local:1234"] {
            assert!(keyed(ok).is_ok(), "{ok}");
        }
        for bad in ["http://openrouter.ai/api", "http://203.0.113.9:4000"] {
            assert!(keyed(bad).unwrap_err().contains("https"), "{bad}");
        }
        // With no key there is nothing to read on the way.
        assert!(clean(ep("a", "http://203.0.113.9:4000")).is_ok());
    }

    #[test]
    fn ids_are_made_once_and_survive_a_rename() {
        let store = EndpointStore::load(None);
        let first = store.replace(vec![ep("My Ollama!", "http://localhost:11434"), ep("my ollama!", "http://localhost:1")]).unwrap_err();
        assert!(first.contains("Two endpoints"), "{first}");
        let saved = store.replace(vec![ep("My Ollama!", "http://localhost:11434"), ep("LiteLLM", "https://llm.test")]).unwrap();
        assert_eq!(saved.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["my-ollama", "litellm"]);
        // Renamed and re-pointed, still the same endpoint; a new one with a taken slug gets a number.
        let again = store.replace(vec![Endpoint { id: "my-ollama".into(), ..ep("Local", "http://localhost:11435") }, Endpoint { id: "litellm".into(), ..ep("LiteLLM", "https://llm.test") }, ep("litellm", "https://other.test")]).unwrap_err();
        assert!(again.contains("Two endpoints"), "{again}");
        let again = store.replace(vec![Endpoint { id: "my-ollama".into(), ..ep("Local", "http://localhost:11435") }, ep("LiteLLM 2", "https://other.test")]).unwrap();
        assert_eq!(again.iter().map(|e| (e.id.as_str(), e.name.as_str())).collect::<Vec<_>>(), [("my-ollama", "Local"), ("litellm-2", "LiteLLM 2")]);
        // An id nobody has is not taken from the caller.
        let made = store.replace(vec![Endpoint { id: "../etc".into(), ..ep("X", "https://x.test") }]).unwrap();
        assert_eq!(made[0].id, "x");
        assert!(store.get("my-ollama").is_none() && store.get("x").is_some());
    }

    #[test]
    fn endpoints_are_kept_between_runs_and_a_bad_file_is_none() {
        let dir = std::env::temp_dir().join(format!("lantern-endpoints-{}", std::process::id()));
        let path = dir.join("endpoints.json");
        let store = EndpointStore::load(Some(path.clone()));
        store.replace(vec![Endpoint { key_env: Some("OPENROUTER_API_KEY".into()), models: vec!["openai/gpt-5".into()], ..ep("OpenRouter", "https://openrouter.ai/api") }]).unwrap();
        let back = EndpointStore::load(Some(path.clone())).list();
        assert_eq!(back.len(), 1);
        assert_eq!((back[0].id.as_str(), back[0].key_env.as_deref()), ("openrouter", Some("OPENROUTER_API_KEY")));
        // Only the variable's name is written, never a key (there is nowhere for one).
        assert!(!std::fs::read_to_string(&path).unwrap().contains("sk-"));
        std::fs::write(&path, b"{not json").unwrap();
        assert!(EndpointStore::load(Some(path.clone())).list().is_empty());
        // A hand-edited file is checked as it is read: a key over http to a public host, a bad model id or no id is left out,
        // and one that is fine stays.
        std::fs::write(
            &path,
            br#"[{"id":"bad","name":"Bad","url":"http://203.0.113.9:4000","key_env":"K","models":[]},
                 {"id":"flag","name":"Flag","url":"https://x.test","models":["--bare"]},
                 {"name":"No id","url":"https://x.test"},
                 {"id":"fine","name":"Fine","url":"http://localhost:11434/","models":["qwen3:8b"]}]"#,
        )
        .unwrap();
        let kept = EndpointStore::load(Some(path)).list();
        assert_eq!(kept.iter().map(|e| (e.id.as_str(), e.url.as_str())).collect::<Vec<_>>(), [("fine", "http://localhost:11434")]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_key_never_prints() {
        let g = GatewayLaunch { id: "x".into(), url: "https://x.test".into(), key: Some(Secret::new("sk-secret-value".into())) };
        assert!(!format!("{g:?}").contains("sk-secret-value"));
    }

    /// The token is in the environment and nowhere on the command line; every model slot and the place to go are in the
    /// `--settings` env block, which has no secret.
    #[test]
    fn a_gateway_launch_sets_the_token_in_the_environment_and_everything_else_in_settings() {
        let keyed = gateway_env(&GatewayLaunch { id: "x".into(), url: "https://x.test".into(), key: Some(Secret::new("sk-secret-value".into())) }, "gpt-5");
        assert_eq!(keyed.set, vec![("ANTHROPIC_AUTH_TOKEN", "sk-secret-value".to_string())]);
        assert!(!keyed.settings.to_string().contains("sk-secret-value"));
        let local = gateway_env(&GatewayLaunch { id: "x".into(), url: "http://localhost:11434".into(), key: None }, "qwen3");
        assert_eq!(local.set, vec![("ANTHROPIC_AUTH_TOKEN", PLACEHOLDER_TOKEN.to_string())], "never empty: an empty token falls back to the user's own login");
        let env = &local.settings["env"];
        assert_eq!(env["ANTHROPIC_BASE_URL"], "http://localhost:11434");
        for slot in ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"] {
            assert_eq!(env[slot], "qwen3", "{slot}");
        }
        assert_eq!(env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"], "1");
        for cloud in ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"] {
            assert_eq!(env[cloud], "", "{cloud}");
        }
        // What a shell may have set that would redirect or re-credential it is taken out, the token's own name included.
        assert!(local.remove.contains(&"ANTHROPIC_API_KEY") && local.remove.contains(&"CLAUDE_CODE_OAUTH_TOKEN") && local.remove.contains(&"ANTHROPIC_BASE_URL"));
    }

    #[test]
    fn a_model_list_is_read_for_the_ids_that_can_be_used() {
        let body = br#"{"data":[{"id":"qwen3-coder:30b"},{"id":"openai/gpt-5"},{"id":"qwen3-coder:30b"},{"id":"--bare"},{"id":"a b"},{"nope":1},{"id":7}]}"#;
        assert_eq!(parse_models(body), ["qwen3-coder:30b", "openai/gpt-5"]);
        assert!(parse_models(b"not json").is_empty() && parse_models(br#"{"data":"x"}"#).is_empty() && parse_models(b"{}").is_empty());
        let many = serde_json::json!({"data": (0..80).map(|i| serde_json::json!({"id": format!("m{i}")})).collect::<Vec<_>>()});
        assert_eq!(parse_models(many.to_string().as_bytes()).len(), MAX_MODELS);
    }

    /// Serves `replies` one connection each on a free port, and hands back what each request said.
    async fn serve(replies: Vec<String>) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let mut seen = Vec::new();
            for reply in replies {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 8192];
                let n = sock.read(&mut buf).await.unwrap();
                seen.push(String::from_utf8_lossy(&buf[..n]).to_string());
                sock.write_all(reply.as_bytes()).await.unwrap();
                let _ = sock.shutdown().await;
            }
            seen
        });
        (url, task)
    }

    fn http(status: &str, extra: &str, body: &str) -> String {
        format!("HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n{extra}\r\n{body}", body.len())
    }

    #[tokio::test]
    async fn the_models_are_fetched_with_the_key_and_every_failure_says_why() {
        let list = http("200 OK", "", r#"{"data":[{"id":"gpt-oss:20b"},{"id":"qwen3:8b"}]}"#);
        let (url, seen) = serve(vec![list]).await;
        let models = fetch_models(&url, Some(&Secret::new("sk-secret-value".into()))).await.unwrap();
        assert_eq!(models, ["gpt-oss:20b", "qwen3:8b"]);
        let request = seen.await.unwrap().remove(0).to_lowercase();
        assert!(request.starts_with("get /v1/models ") && request.contains("authorization: bearer sk-secret-value"), "{request}");
        for (reply, says) in [
            (http("401 Unauthorized", "", "{}"), "refused the key"),
            (http("404 Not Found", "", "{}"), "type them"),
            (http("500 Internal Server Error", "", "{}"), "500"),
            (http("200 OK", "", r#"{"data":[]}"#), "no models"),
        ] {
            let (url, _) = serve(vec![reply]).await;
            let e = fetch_models(&url, None).await.unwrap_err();
            assert!(e.contains(says), "{e}");
        }
        let e = fetch_models("http://127.0.0.1:1", None).await.unwrap_err();
        assert!(e.contains("reach"), "{e}");
    }

    /// The key is for the URL it was given: a redirect elsewhere is a failure, not a second request carrying it.
    #[tokio::test]
    async fn a_redirect_is_not_followed_so_a_key_does_not_travel() {
        let (elsewhere, other) = serve(vec![http("200 OK", "", r#"{"data":[{"id":"x"}]}"#)]).await;
        let redirect = http("302 Found", &format!("location: {elsewhere}/v1/models\r\n"), "");
        let (url, _) = serve(vec![redirect]).await;
        let e = fetch_models(&url, Some(&Secret::new("sk-secret-value".into()))).await.unwrap_err();
        assert!(e.contains("302"), "{e}");
        assert!(!other.is_finished(), "nothing reached the other host");
        other.abort();
    }

    /// A settings file's own token would outrank the one set here (checked), so it is refused rather than sent.
    #[test]
    fn a_settings_file_with_its_own_credential_is_refused() {
        let dir = std::env::temp_dir().join(format!("lantern-conflict-{}", std::process::id()));
        let (home, project) = (dir.join("home"), dir.join("project"));
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::create_dir_all(project.join(".claude")).unwrap();
        assert!(settings_conflict(&home, &project).is_none());
        // The URL and the models in a settings file are overridden by the launch, so they are no conflict.
        std::fs::write(home.join(".claude/settings.json"), br#"{"env":{"ANTHROPIC_BASE_URL":"https://elsewhere","ANTHROPIC_MODEL":"x"}}"#).unwrap();
        assert!(settings_conflict(&home, &project).is_none());
        std::fs::write(project.join(".claude/settings.local.json"), br#"{"env":{"ANTHROPIC_AUTH_TOKEN":"abc"}}"#).unwrap();
        let why = settings_conflict(&home, &project).unwrap();
        assert!(why.contains("ANTHROPIC_AUTH_TOKEN") && why.contains("settings.local.json") && !why.contains("abc"), "{why}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
