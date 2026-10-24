//! API keys for the agent CLIs, an alternative to each CLI's own sign-in: with the switch on, a provider's CLI is started with the
//! user's API key (so it bills their API account, not a subscription) instead of its login.
//!
//! This reverses an earlier rule that Lantern keeps no keys (an endpoint still names an environment variable, which works as
//! before); the user asked for it. What that means, and the care taken:
//!   - A key is kept in the login Keychain (never in a file, never in the chat, never sent back to the window once saved). What
//!     is kept in a file is only the switches and which keys exist (`provider-auth.json`), so Settings never reads the Keychain.
//!   - It is read from the Keychain once, off the main thread, at launch of the app and when it is saved, and kept in memory
//!     (a `Secret`, which never prints) for starting chats.
//!   - It reaches a CLI only in that child's environment: never `std::env::set_var` in Lantern's own process (every child would
//!     inherit it), never `--settings` or the command line (any process of the user can read those).
//!   - Fail closed: with the switch on and no key (or the Keychain refusing), a chat does not start, and never falls back to the
//!     CLI's login, which would bill the account the user chose not to use.
//!   - A CLI's own tools can read its environment, so a key handed to a CLI is reachable by what that CLI runs, the same as a key
//!     exported in the user's shell. Settings says so, and suggests a key with a spending limit.
//!
//! Only Claude Code and endpoints have keys so far. Codex has no key here yet: how its app-server takes one without overwriting
//! the user's own sign-in file could not be checked (see `NOT_YET`).

use crate::endpoints::Secret;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

/// The Keychain service the keys are under (a dev run uses a service of its own).
pub const SERVICE: &str = "Lantern provider keys";
/// The account Claude Code's key is kept under; an endpoint's is `endpoint:<id>`.
const CLAUDE: &str = "claude";

/// What Settings says where a provider can't take a key yet.
pub const NOT_YET: &str = "Codex's own sign-in is used for now: how its app-server takes an API key without replacing your saved sign-in couldn't be checked yet.";

/// The longest key kept. Real ones are about 50 to 200 characters.
const MAX_KEY: usize = 512;
const MIN_KEY: usize = 8;

/// What is taken out of Claude Code's environment when it runs on a key, so the key is sent to Anthropic, as the user's own, and
/// to nowhere else: no other credential outranks it, no other service or address is used.
pub const KEY_MODE_REMOVE: &[&str] = &[
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
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
];

/// Where keys are kept: the Keychain in the app, memory in tests.
pub trait Vault: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<Secret>, String>;
    fn set(&self, account: &str, key: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// The login Keychain, under `service`.
pub struct Keychain {
    pub service: &'static str,
}

/// The Keychain's "no such item".
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

impl Vault for Keychain {
    fn get(&self, account: &str) -> Result<Option<Secret>, String> {
        match security_framework::passwords::get_generic_password(self.service, account) {
            Ok(v) => Ok(String::from_utf8(v).ok().map(Secret::new)),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(e) => Err(format!("Couldn't read the key from the Keychain: {e}")),
        }
    }

    fn set(&self, account: &str, key: &str) -> Result<(), String> {
        security_framework::passwords::set_generic_password(self.service, account, key.as_bytes()).map_err(|e| format!("Couldn't save the key in the Keychain: {e}"))
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match security_framework::passwords::delete_generic_password(self.service, account) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(e) => Err(format!("Couldn't remove the key from the Keychain: {e}")),
        }
    }
}

/// Keys in memory only (tests).
#[derive(Default)]
pub struct Memory {
    keys: Mutex<HashMap<String, String>>,
    /// Makes every read fail, as a locked Keychain would.
    pub fail_reads: Mutex<bool>,
}

impl Vault for Memory {
    fn get(&self, account: &str) -> Result<Option<Secret>, String> {
        if *self.fail_reads.lock().unwrap() {
            return Err("Couldn't read the key from the Keychain: locked.".into());
        }
        Ok(self.keys.lock().unwrap().get(account).cloned().map(Secret::new))
    }
    fn set(&self, account: &str, key: &str) -> Result<(), String> {
        self.keys.lock().unwrap().insert(account.to_string(), key.to_string());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.keys.lock().unwrap().remove(account);
        Ok(())
    }
}

/// A key as the user pasted it, made safe to keep and to put in an environment, or why it can't be. The message never contains
/// the key.
pub fn clean_key(raw: &str) -> Result<String, String> {
    let key = raw.trim();
    if key.len() < MIN_KEY {
        return Err("That's too short to be an API key.".into());
    }
    if key.len() > MAX_KEY {
        return Err("That's too long to be an API key.".into());
    }
    // One printable ASCII word: a space, a newline or any other control character is a paste that went wrong, and in an
    // environment (and a header) it would break or add to what is sent.
    if !key.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err("An API key has no spaces, line breaks or special characters. Paste just the key.".into());
    }
    Ok(key.to_string())
}

/// What is kept in `provider-auth.json`: only switches and which keys exist, never a key.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Saved {
    #[serde(default)]
    claude_use_key: bool,
    #[serde(default)]
    claude_has_key: bool,
    /// The ids of the endpoints that have a saved key.
    #[serde(default)]
    endpoint_keys: Vec<String>,
}

/// What Settings is shown. Never a key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AuthState {
    pub claude: ClaudeAuth,
    pub endpoint_keys: Vec<String>,
    pub not_yet: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClaudeAuth {
    pub use_key: bool,
    pub has_key: bool,
}

/// What Claude Code is started with when it runs on a key.
pub struct KeyLaunch {
    pub remove: &'static [&'static str],
    pub key: Secret,
}

#[derive(Default)]
struct Cache {
    claude: Option<Secret>,
    endpoints: HashMap<String, Secret>,
    /// Why a key couldn't be read from the Keychain, said when a chat that needs it is started.
    error: Option<String>,
}

pub struct ProviderKeys {
    vault: Arc<dyn Vault>,
    path: Option<PathBuf>,
    saved: Mutex<Saved>,
    cache: Mutex<Cache>,
    /// The keys have been read from the Keychain: a chat restored at launch can ask before the read at launch is done, and then
    /// reads them itself rather than finding none.
    loaded: Mutex<bool>,
}

static GLOBAL: OnceLock<Arc<ProviderKeys>> = OnceLock::new();

impl ProviderKeys {
    /// The keys kept in `vault`, with the switches read from `path` (None: kept in memory, as the tests do).
    pub fn new(vault: Arc<dyn Vault>, path: Option<PathBuf>) -> Arc<Self> {
        let saved = path.as_ref().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str::<Saved>(&t).ok()).unwrap_or_default();
        Arc::new(Self { vault, path, saved: Mutex::new(saved), cache: Mutex::new(Cache::default()), loaded: Mutex::new(false) })
    }

    /// Makes this the one the places that start Claude Code ask (they have no app state to hand): see `apply_claude`.
    pub fn install(self: &Arc<Self>) {
        let _ = GLOBAL.set(self.clone());
    }

    /// Reads the saved keys out of the Keychain into memory. Blocking: the app does it once at launch off the main thread, so
    /// starting a chat never waits on the Keychain, and Settings never triggers a read (or a prompt) by being opened.
    pub fn load(&self) {
        let saved = self.saved.lock().unwrap().clone();
        let mut cache = Cache::default();
        let mut read = |account: &str, into: &mut dyn FnMut(Secret)| match self.vault.get(account) {
            Ok(Some(k)) => into(k),
            Ok(None) => {}
            Err(e) => cache.error = Some(e),
        };
        let mut claude = None;
        if saved.claude_has_key {
            read(CLAUDE, &mut |k| claude = Some(k));
        }
        let mut endpoints = HashMap::new();
        for id in &saved.endpoint_keys {
            read(&format!("endpoint:{id}"), &mut |k| {
                endpoints.insert(id.clone(), k);
            });
        }
        cache.claude = claude;
        cache.endpoints = endpoints;
        *self.cache.lock().unwrap() = cache;
        *self.loaded.lock().unwrap() = true;
    }

    /// Reads the keys now if nobody has yet (see `loaded`).
    fn ensure_loaded(&self) {
        if !*self.loaded.lock().unwrap() {
            self.load();
        }
    }

    fn persist(&self, saved: &Saved) -> Result<(), String> {
        let Some(path) = &self.path else { return Ok(()) };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(saved).map_err(|e| e.to_string())?).and_then(|_| std::fs::rename(&tmp, path)).map_err(|e| format!("Couldn't save the settings: {e}"))
    }

    pub fn state(&self) -> AuthState {
        let s = self.saved.lock().unwrap();
        AuthState { claude: ClaudeAuth { use_key: s.claude_use_key, has_key: s.claude_has_key }, endpoint_keys: s.endpoint_keys.clone(), not_yet: NOT_YET }
    }

    /// Saves Claude Code's key (replacing one), after cleaning it. The switch is not changed.
    pub fn set_claude_key(&self, raw: &str) -> Result<(), String> {
        let key = clean_key(raw)?;
        self.vault.set(CLAUDE, &key)?;
        let mut saved = self.saved.lock().unwrap();
        saved.claude_has_key = true;
        self.persist(&saved)?;
        let mut cache = self.cache.lock().unwrap();
        cache.claude = Some(Secret::new(key));
        cache.error = None;
        Ok(())
    }

    /// Forgets Claude Code's key, and puts it back on its own sign-in: there is no key left to run on.
    pub fn clear_claude_key(&self) -> Result<(), String> {
        self.vault.delete(CLAUDE)?;
        let mut saved = self.saved.lock().unwrap();
        (saved.claude_has_key, saved.claude_use_key) = (false, false);
        self.persist(&saved)?;
        self.cache.lock().unwrap().claude = None;
        Ok(())
    }

    /// The switch: Claude Code on its API key (true) or on its own sign-in. On needs a saved key.
    pub fn set_claude_use_key(&self, on: bool) -> Result<(), String> {
        let mut saved = self.saved.lock().unwrap();
        if on && !saved.claude_has_key {
            return Err("Save an API key first.".into());
        }
        saved.claude_use_key = on;
        self.persist(&saved)
    }

    /// What Claude Code is started with for this chat: None to run on its own sign-in (the switch is off), the key and what to take
    /// out of its environment when it is on. An error, in words, when the switch is on and the key can't be had: such a chat never
    /// starts on the sign-in instead.
    pub fn claude_launch(&self) -> Result<Option<KeyLaunch>, String> {
        if !self.saved.lock().unwrap().claude_use_key {
            return Ok(None);
        }
        self.ensure_loaded();
        let cache = self.cache.lock().unwrap();
        match &cache.claude {
            Some(key) => Ok(Some(KeyLaunch { remove: KEY_MODE_REMOVE, key: key.clone() })),
            None => Err(match &cache.error {
                Some(why) => format!("Claude is set to use your API key, but it can't be read ({why}) so this chat won't start on your sign-in instead. Unlock the Keychain, or turn the key off in Settings → API keys."),
                None => "Claude is set to use your API key, but none is saved so this chat won't start on your sign-in instead. Add it, or turn the key off in Settings → API keys.".into(),
            }),
        }
    }

    /// Saves an endpoint's key (replacing one), after cleaning it. The endpoint's address is checked by the caller.
    pub fn set_endpoint_key(&self, id: &str, raw: &str) -> Result<(), String> {
        let key = clean_key(raw)?;
        self.vault.set(&format!("endpoint:{id}"), &key)?;
        let mut saved = self.saved.lock().unwrap();
        if !saved.endpoint_keys.iter().any(|e| e == id) {
            saved.endpoint_keys.push(id.to_string());
        }
        self.persist(&saved)?;
        let mut cache = self.cache.lock().unwrap();
        cache.endpoints.insert(id.to_string(), Secret::new(key));
        cache.error = None;
        Ok(())
    }

    pub fn clear_endpoint_key(&self, id: &str) -> Result<(), String> {
        self.vault.delete(&format!("endpoint:{id}"))?;
        let mut saved = self.saved.lock().unwrap();
        saved.endpoint_keys.retain(|e| e != id);
        self.persist(&saved)?;
        self.cache.lock().unwrap().endpoints.remove(id);
        Ok(())
    }

    /// An endpoint's saved key, if it has one. Ok(None) when it has none (it may name an environment variable instead); an
    /// error when it has one that can't be read: such a chat never starts on another credential.
    pub fn endpoint_key(&self, id: &str) -> Result<Option<Secret>, String> {
        if !self.saved.lock().unwrap().endpoint_keys.iter().any(|e| e == id) {
            return Ok(None);
        }
        self.ensure_loaded();
        let cache = self.cache.lock().unwrap();
        match cache.endpoints.get(id) {
            Some(k) => Ok(Some(k.clone())),
            None => Err(format!("This endpoint's saved key can't be read{}, so the chat won't start without it. Unlock the Keychain, or save the key again in Settings → Endpoints.", cache.error.as_ref().map(|e| format!(" ({e})")).unwrap_or_default())),
        }
    }

    /// Drops the keys of endpoints that are gone from the list (their ids are not in `keep`).
    pub fn forget_endpoints_except(&self, keep: &[String]) {
        let gone: Vec<String> = self.saved.lock().unwrap().endpoint_keys.iter().filter(|e| !keep.contains(e)).cloned().collect();
        for id in gone {
            let _ = self.clear_endpoint_key(&id);
        }
    }
}

/// A settings file that would send the key somewhere else or outrank it. Claude Code reads an `env` block from the user's settings
/// and the project's two (and a managed one), and that outranks the process environment, so taking a variable out of the child's
/// environment doesn't stop a file setting it: a base URL there would receive the key, and a token or another key there would be
/// used instead of it. `apiKeyHelper` supplies a credential of its own. The reason, in words, for the first one found.
pub fn settings_conflict(home: &std::path::Path, folder: &std::path::Path) -> Option<String> {
    let files = [home.join(".claude/settings.json"), folder.join(".claude/settings.json"), folder.join(".claude/settings.local.json"), PathBuf::from("/Library/Application Support/ClaudeCode/managed-settings.json")];
    for file in files {
        let Some(v) = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()) else { continue };
        if let Some(name) = KEY_MODE_REMOVE.iter().chain(["ANTHROPIC_API_KEY"].iter()).find(|k| v["env"].get(**k).is_some()) {
            return Some(format!("{} sets {name}, which would send your API key somewhere else or be used in place of it. Take it out of that file, or turn the key off in Settings → API keys.", file.display()));
        }
        if v.get("apiKeyHelper").is_some() {
            return Some(format!("{} sets apiKeyHelper, a credential of its own that would be used in place of your API key. Take it out of that file, or turn the key off in Settings → API keys.", file.display()));
        }
    }
    None
}

impl ProviderKeys {
    /// `apply_tokio` for a chat that runs in `folder`, which reads that folder's settings files as well as the user's: refused, with
    /// the reason, when one of them would send the key elsewhere or outrank it. (The title and suggestion calls read no settings
    /// at all, `--setting-sources ""`, so they use `apply_tokio`.)
    pub fn apply_tokio_in(&self, cmd: &mut tokio::process::Command, home: &std::path::Path, folder: &std::path::Path) -> Result<(), String> {
        if self.claude_launch()?.is_some() {
            if let Some(why) = settings_conflict(home, folder) {
                return Err(why);
            }
        }
        self.apply_tokio(cmd)
    }

    /// Puts Claude Code's key (when its switch is on) and the removals in `cmd`'s own environment: nowhere else, so no other
    /// process of Lantern's or the user's inherits it. Does nothing when the switch is off. An error when it is on and the key
    /// can't be had.
    pub fn apply_tokio(&self, cmd: &mut tokio::process::Command) -> Result<(), String> {
        if let Some(launch) = self.claude_launch()? {
            for k in launch.remove {
                cmd.env_remove(k);
            }
            cmd.env("ANTHROPIC_API_KEY", launch.key.expose());
        }
        Ok(())
    }
}

/// `apply_tokio` for the keys the app installed (the places that start Claude Code have no app state to hand): the chat, the side
/// question, the title and the phone's suggestions. Nothing when no keys were installed (the tests).
pub fn apply_claude_tokio(cmd: &mut tokio::process::Command) -> Result<(), String> {
    match GLOBAL.get() {
        Some(keys) => keys.apply_tokio(cmd),
        None => Ok(()),
    }
}

/// `apply_tokio_in` for the keys the app installed: a chat and the side question, which run in the project's folder.
pub fn apply_claude_tokio_in(cmd: &mut tokio::process::Command, folder: &std::path::Path) -> Result<(), String> {
    let Some(keys) = GLOBAL.get() else { return Ok(()) };
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    keys.apply_tokio_in(cmd, &home, folder)
}

/// Whether Claude Code is on its API key (so it is not asked whether it is signed in: it needn't be).
pub fn claude_on_key() -> bool {
    GLOBAL.get().is_some_and(|k| k.saved.lock().unwrap().claude_use_key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys() -> (Arc<ProviderKeys>, Arc<Memory>) {
        let vault = Arc::new(Memory::default());
        (ProviderKeys::new(vault.clone(), None), vault)
    }

    const KEY: &str = "sk-ant-api03-TESTKEYTESTKEY";

    #[test]
    fn a_key_is_one_printable_word_of_a_sensible_length_and_no_message_repeats_it() {
        assert_eq!(clean_key(&format!("  {KEY}\n")).as_deref(), Ok(KEY));
        for bad in ["", "short", "has a space in it", "tab\tin-it-12345", "line\nbreak-12345", "caf\u{e9}-key-1234567", &"k".repeat(MAX_KEY + 1), "bell\u{7}-key-123456"] {
            let err = clean_key(bad).expect_err(bad);
            // The message never repeats what was pasted (a short one would only say it is short).
            assert!(bad.len() < MIN_KEY || !err.contains(bad), "{err}");
        }
    }

    #[test]
    fn with_the_switch_off_claude_runs_on_its_own_sign_in_even_with_a_key_saved() {
        let (k, _) = keys();
        k.set_claude_key(KEY).unwrap();
        assert!(k.claude_launch().unwrap().is_none());
        assert_eq!(k.state().claude, ClaudeAuth { use_key: false, has_key: true });
    }

    #[test]
    fn with_the_switch_on_claude_gets_the_key_and_what_is_taken_out_of_its_environment() {
        let (k, _) = keys();
        k.set_claude_key(KEY).unwrap();
        k.set_claude_use_key(true).unwrap();
        let launch = k.claude_launch().unwrap().unwrap();
        assert_eq!(launch.key.expose(), KEY);
        for must in ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK"] {
            assert!(launch.remove.contains(&must), "{must}");
        }
        assert!(!launch.remove.contains(&"ANTHROPIC_API_KEY"), "the key itself isn't taken out");
    }

    #[test]
    fn the_switch_cant_be_on_without_a_key_and_clearing_the_key_puts_it_back_off() {
        let (k, _) = keys();
        assert!(k.set_claude_use_key(true).is_err());
        k.set_claude_key(KEY).unwrap();
        k.set_claude_use_key(true).unwrap();
        k.clear_claude_key().unwrap();
        assert_eq!(k.state().claude, ClaudeAuth { use_key: false, has_key: false });
        assert!(k.claude_launch().unwrap().is_none());
    }

    #[test]
    fn a_chat_never_starts_on_the_sign_in_when_the_key_is_wanted_and_cant_be_had() {
        let (k, vault) = keys();
        k.set_claude_key(KEY).unwrap();
        k.set_claude_use_key(true).unwrap();
        // A fresh start of the app: the key is read from a Keychain that refuses.
        let again = ProviderKeys::new(vault.clone(), None);
        *again.saved.lock().unwrap() = k.saved.lock().unwrap().clone();
        *vault.fail_reads.lock().unwrap() = true;
        again.load();
        let err = again.claude_launch().err().expect("refused");
        assert!(err.contains("won't start on your sign-in instead") && err.contains("locked") && !err.contains(KEY), "{err}");
        // And once it can be read, it runs.
        *vault.fail_reads.lock().unwrap() = false;
        again.load();
        assert!(again.claude_launch().unwrap().is_some());
        // Missing altogether (the Keychain item was deleted behind the app's back) refuses too.
        vault.delete(CLAUDE).unwrap();
        again.load();
        assert!(again.claude_launch().err().unwrap().contains("none is saved"));
    }

    #[test]
    fn an_endpoints_key_is_kept_by_its_id_read_back_and_forgotten_with_the_endpoint() {
        let (k, vault) = keys();
        assert!(k.endpoint_key("ollama").unwrap().is_none());
        k.set_endpoint_key("openrouter", KEY).unwrap();
        k.set_endpoint_key("litellm", "another-key-12345").unwrap();
        assert_eq!(k.endpoint_key("openrouter").unwrap().unwrap().expose(), KEY);
        assert_eq!(k.state().endpoint_keys, ["openrouter", "litellm"]);
        k.forget_endpoints_except(&["litellm".to_string()]);
        assert!(k.endpoint_key("openrouter").unwrap().is_none());
        assert!(vault.get("endpoint:openrouter").unwrap().is_none(), "gone from the Keychain too");
        assert_eq!(k.endpoint_key("litellm").unwrap().unwrap().expose(), "another-key-12345");
    }

    #[test]
    fn an_endpoint_whose_saved_key_cant_be_read_is_an_error_not_a_start_with_none() {
        let (k, vault) = keys();
        k.set_endpoint_key("openrouter", KEY).unwrap();
        let again = ProviderKeys::new(vault.clone(), None);
        *again.saved.lock().unwrap() = k.saved.lock().unwrap().clone();
        *vault.fail_reads.lock().unwrap() = true;
        again.load();
        assert!(again.endpoint_key("openrouter").err().unwrap().contains("can't be read"));
    }

    #[test]
    fn only_switches_and_ids_reach_the_file_never_a_key() {
        let dir = std::env::temp_dir().join(format!("lantern-keys-{}", std::process::id()));
        let path = dir.join("provider-auth.json");
        let vault = Arc::new(Memory::default());
        let keys = ProviderKeys::new(vault.clone(), Some(path.clone()));
        keys.set_claude_key(KEY).unwrap();
        keys.set_claude_use_key(true).unwrap();
        keys.set_endpoint_key("ollama", "endpoint-key-12345").unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains(KEY) && !text.contains("endpoint-key-12345") && !text.contains("sk-"), "{text}");
        // What was saved is what comes back at the next launch.
        let back = ProviderKeys::new(vault, Some(path));
        assert_eq!((back.state().claude, back.state().endpoint_keys), (ClaudeAuth { use_key: true, has_key: true }, vec!["ollama".to_string()]));
        back.load();
        assert_eq!(back.claude_launch().unwrap().unwrap().key.expose(), KEY);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// What a child process makes of a command: its environment as it prints it (`env`), with the same stand-ins for the user's
    /// own credentials in Lantern's process as an app started from a shell would have.
    async fn env_of(keys: &ProviderKeys) -> Result<String, String> {
        let mut cmd = tokio::process::Command::new("/usr/bin/env");
        cmd.env("CLAUDE_CODE_OAUTH_TOKEN", "oauth-LOGIN").env("ANTHROPIC_BASE_URL", "http://elsewhere.test").env("ANTHROPIC_AUTH_TOKEN", "other-token").env("KEEP_ME", "yes");
        keys.apply_tokio(&mut cmd)?;
        let out = cmd.output().await.map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    #[tokio::test]
    async fn on_a_key_the_child_gets_it_and_none_of_the_credentials_or_addresses_that_would_outrank_it() {
        let (k, _) = keys();
        k.set_claude_key(KEY).unwrap();
        k.set_claude_use_key(true).unwrap();
        let env = env_of(&k).await.unwrap();
        assert!(env.contains(&format!("ANTHROPIC_API_KEY={KEY}")), "{env}");
        for gone in ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"] {
            assert!(!env.contains(gone), "{gone} reached the child");
        }
        assert!(env.contains("KEEP_ME=yes"), "everything else is as it was");
        // And only that child: the key is not in Lantern's own environment, where every other child would inherit it.
        assert!(std::env::var_os("ANTHROPIC_API_KEY").is_none_or(|v| v != KEY));
    }

    #[tokio::test]
    async fn off_a_key_the_child_is_untouched_and_a_wanted_key_that_cant_be_had_starts_nothing() {
        let (k, vault) = keys();
        k.set_claude_key(KEY).unwrap();
        let env = env_of(&k).await.unwrap();
        assert!(env.contains("CLAUDE_CODE_OAUTH_TOKEN=oauth-LOGIN") && !env.contains(KEY), "{env}");
        // On, with the Keychain refusing: an error, so no process is started on the sign-in instead.
        k.set_claude_use_key(true).unwrap();
        let again = ProviderKeys::new(vault.clone(), None);
        *again.saved.lock().unwrap() = k.saved.lock().unwrap().clone();
        *vault.fail_reads.lock().unwrap() = true;
        again.load();
        assert!(env_of(&again).await.is_err());
    }

    fn write(dir: &std::path::Path, file: &str, text: &str) {
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        std::fs::write(dir.join(".claude").join(file), text).unwrap();
    }

    #[test]
    fn a_settings_file_that_would_redirect_the_key_or_outrank_it_stops_a_chat_on_a_key() {
        let (home, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        assert_eq!(settings_conflict(home.path(), project.path()), None);
        // Harmless settings are fine.
        write(project.path(), "settings.json", r#"{"env":{"FOO":"bar"},"permissions":{"allow":[]}}"#);
        assert_eq!(settings_conflict(home.path(), project.path()), None);
        for (dir, file, body, name) in [
            (project.path(), "settings.json", r#"{"env":{"ANTHROPIC_BASE_URL":"https://evil.test"}}"#, "ANTHROPIC_BASE_URL"),
            (project.path(), "settings.local.json", r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"x"}}"#, "ANTHROPIC_AUTH_TOKEN"),
            (home.path(), "settings.json", r#"{"env":{"ANTHROPIC_API_KEY":"another"}}"#, "ANTHROPIC_API_KEY"),
            (home.path(), "settings.json", r#"{"env":{"CLAUDE_CODE_USE_BEDROCK":"1"}}"#, "CLAUDE_CODE_USE_BEDROCK"),
            (home.path(), "settings.json", r#"{"apiKeyHelper":"echo hi"}"#, "apiKeyHelper"),
        ] {
            write(dir, file, body);
            let why = settings_conflict(home.path(), project.path()).unwrap_or_else(|| panic!("{name} was not found"));
            assert!(why.contains(name) && why.contains("Settings → API keys"), "{why}");
            std::fs::remove_file(dir.join(".claude").join(file)).unwrap();
        }
    }

    #[tokio::test]
    async fn a_chat_in_a_folder_with_such_a_file_is_refused_on_a_key_and_untouched_off_it() {
        let (k, _) = keys();
        let (home, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        write(project.path(), "settings.json", r#"{"env":{"ANTHROPIC_BASE_URL":"https://evil.test"}}"#);
        let mut cmd = tokio::process::Command::new("/usr/bin/true");
        // Off the key it is as it was: the file is the user's business.
        k.set_claude_key(KEY).unwrap();
        assert!(k.apply_tokio_in(&mut cmd, home.path(), project.path()).is_ok());
        assert!(cmd.as_std().get_envs().next().is_none(), "nothing was put in the environment");
        // On the key, the same folder is refused, and no key was put in the command.
        k.set_claude_use_key(true).unwrap();
        let err = k.apply_tokio_in(&mut cmd, home.path(), project.path()).unwrap_err();
        assert!(err.contains("ANTHROPIC_BASE_URL"), "{err}");
        assert!(cmd.as_std().get_envs().all(|(name, _)| name != "ANTHROPIC_API_KEY"));
    }

    #[test]
    fn a_chat_restored_at_launch_finds_the_key_even_before_the_launch_read_is_done() {
        let (k, vault) = keys();
        k.set_claude_key(KEY).unwrap();
        k.set_claude_use_key(true).unwrap();
        // A fresh start: the switches are known (from the file), `load` has not run.
        let fresh = ProviderKeys::new(vault.clone(), None);
        *fresh.saved.lock().unwrap() = k.saved.lock().unwrap().clone();
        assert_eq!(fresh.claude_launch().unwrap().unwrap().key.expose(), KEY);
        // The same for an endpoint's key.
        k.set_endpoint_key("openrouter", KEY).unwrap();
        let fresh = ProviderKeys::new(vault, None);
        *fresh.saved.lock().unwrap() = k.saved.lock().unwrap().clone();
        assert_eq!(fresh.endpoint_key("openrouter").unwrap().unwrap().expose(), KEY);
    }

    #[test]
    fn what_a_launch_holds_never_prints() {
        let (k, _) = keys();
        k.set_claude_key(KEY).unwrap();
        k.set_claude_use_key(true).unwrap();
        let launch = k.claude_launch().unwrap().unwrap();
        assert!(!format!("{:?}", launch.key).contains("sk-ant"));
        assert!(!format!("{:?}", k.state()).contains("sk-ant"));
    }
}
