//! Hermes Agent (Nous Research's own agent) on the user's Claude subscription: its experimental claude-subscription-directsdk
//! plugin runs Hermes's turns through the `claude` CLI, so Hermes needs no API key. Lantern only sets that up, as
//! `hermes plugins install` and `hermes model` would by hand; Lantern's own chats don't change.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

/// The plugin as the catalog names it (to install it), and as Hermes names it once installed (its provider).
const PLUGIN: &str = "claude-subscription-directsdk";
const PROVIDER: &str = "claude-subscription-directsdk-experimental";
/// The model set when Hermes's own isn't one the plugin can run (a fresh Hermes names `anthropic/claude-opus-4.6`).
const MODEL: &str = "claude-sonnet-5-5";
/// How long one `hermes` call may take: installing clones the plugin from git, the rest only read or write its config.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);
const STEP_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HermesStatus {
    /// The `hermes` CLI was found.
    pub installed: bool,
    /// Hermes runs on the plugin: its provider is the plugin's.
    pub on: bool,
}

/// What Hermes is told, in order, to run on the plugin (`installed`: the plugin is there already, so it's only enabled):
/// what `hermes model` writes when the plugin is picked. Or to stop: the provider is unset, so Hermes asks for one
/// (`hermes model`) rather than silently using another.
fn steps(on: bool, installed: bool) -> Vec<Vec<String>> {
    let s = |a: &[&str]| a.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    let base_url = format!("process://{PROVIDER}");
    if on {
        let plugin = if installed { s(&["plugins", "enable", PROVIDER]) } else { s(&["plugins", "install", PLUGIN, "--enable"]) };
        vec![plugin, s(&["config", "set", "model.provider", PROVIDER]), s(&["config", "set", "model.base_url", &base_url]), s(&["config", "set", "model.api_mode", "chat_completions"])]
    } else {
        vec![s(&["config", "unset", "model.provider"]), s(&["config", "unset", "model.base_url"]), s(&["config", "unset", "model.api_mode"]), s(&["plugins", "disable", PROVIDER])]
    }
}

/// Whether the plugin can run `model`: a Claude model id or one of its aliases (see the plugin's model_catalog.py).
fn usable_model(model: &str) -> bool {
    let m = model.trim();
    m.starts_with("claude-") || ["sonnet", "opus", "haiku"].contains(&m)
}

/// Runs `hermes` with `args` (no shell, nothing typed by anyone in them), on the login shell's PATH so it finds `claude` and
/// `git`; its output, or what it said went wrong. One that runs past `limit` is killed.
async fn run(hermes: &Path, args: &[String], path_env: Option<&str>, limit: Duration) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new(hermes);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    if let Some(p) = path_env {
        cmd.env("PATH", p);
    }
    let what = format!("hermes {}", args.join(" "));
    let out = tokio::time::timeout(limit, cmd.output()).await.map_err(|_| format!("{what} took longer than {}s and was stopped", limit.as_secs()))?.map_err(|e| format!("Couldn't run hermes: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        Ok(text)
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(format!("{what} failed: {}", if err.is_empty() { text } else { err }))
    }
}

fn get(key: &str) -> Vec<String> {
    vec!["config".into(), "get".into(), key.into()]
}

/// Where Hermes stands: whether its CLI is there, and whether it runs on the plugin.
pub async fn status(hermes: Option<&Path>, path_env: Option<&str>) -> HermesStatus {
    let Some(h) = hermes else { return HermesStatus { installed: false, on: false } };
    let provider = run(h, &get("model.provider"), path_env, STEP_TIMEOUT).await.unwrap_or_default();
    HermesStatus { installed: true, on: provider.trim() == PROVIDER }
}

/// Turns the plugin on (installing it from Hermes's catalog the first time) or off, then says where Hermes stands.
pub async fn set(hermes: &Path, on: bool, path_env: Option<&str>) -> Result<HermesStatus, String> {
    if !on {
        // A provider or plugin that is already gone is fine.
        for args in steps(false, true) {
            let _ = run(hermes, &args, path_env, STEP_TIMEOUT).await;
        }
        return Ok(status(Some(hermes), path_env).await);
    }
    // Enabling a plugin that isn't installed fails: then it is installed.
    let mut plan = steps(true, true);
    if run(hermes, &plan[0], path_env, STEP_TIMEOUT).await.is_ok() {
        plan.remove(0);
    } else {
        plan = steps(true, false);
    }
    for args in &plan {
        let limit = if args[1] == "install" { INSTALL_TIMEOUT } else { STEP_TIMEOUT };
        run(hermes, args, path_env, limit).await?;
    }
    let model = run(hermes, &get("model.default"), path_env, STEP_TIMEOUT).await.unwrap_or_default();
    if !usable_model(&model) {
        run(hermes, &["config".into(), "set".into(), "model.default".into(), MODEL.into()], path_env, STEP_TIMEOUT).await?;
    }
    Ok(status(Some(hermes), path_env).await)
}

/// Where the `hermes` CLI is usually installed (its installer puts it in ~/.local/bin).
pub fn candidate_paths(home: &Path) -> Vec<PathBuf> {
    vec![home.join(".local/bin/hermes"), PathBuf::from("/opt/homebrew/bin/hermes"), PathBuf::from("/usr/local/bin/hermes")]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn on_installs_or_enables_the_plugin_and_writes_what_the_picker_does_and_off_undoes_it() {
        let on = steps(true, false);
        assert_eq!(on[0], ["plugins", "install", "claude-subscription-directsdk", "--enable"]);
        assert_eq!(steps(true, true)[0], ["plugins", "enable", "claude-subscription-directsdk-experimental"]);
        assert_eq!(on[1..], [
            vec!["config", "set", "model.provider", "claude-subscription-directsdk-experimental"],
            vec!["config", "set", "model.base_url", "process://claude-subscription-directsdk-experimental"],
            vec!["config", "set", "model.api_mode", "chat_completions"],
        ]);
        let off = steps(false, true);
        assert_eq!(off, [vec!["config", "unset", "model.provider"], vec!["config", "unset", "model.base_url"], vec!["config", "unset", "model.api_mode"], vec!["plugins", "disable", "claude-subscription-directsdk-experimental"]]);
    }

    #[test]
    fn only_claude_models_are_kept() {
        for ok in ["claude-sonnet-5-5[1m]", "claude-opus-5-5", "sonnet", " haiku\n"] {
            assert!(usable_model(ok), "{ok}");
        }
        for bad in ["anthropic/claude-opus-4.6", "", "gpt-5", "nous/hermes-4"] {
            assert!(!usable_model(bad), "{bad}");
        }
    }

    /// A fake `hermes` that logs what it's told, keeps the provider and model in files, fails `plugins enable` until the
    /// plugin is installed, and hangs on `plugins list`.
    fn fake(dir: &Path) -> PathBuf {
        let d = dir.display();
        let script = format!(
            "#!/bin/sh\necho \"$*\" >> {d}/log\ncase \"$*\" in\n  'config get model.provider') cat {d}/provider 2>/dev/null ;;\n  'config set model.provider '*) echo \"$4\" > {d}/provider ;;\n  'config unset model.provider') rm -f {d}/provider ;;\n  'config get model.default') cat {d}/model 2>/dev/null || echo anthropic/claude-opus-4.6 ;;\n  'config set model.default '*) echo \"$4\" > {d}/model ;;\n  'plugins enable '*) [ -f {d}/installed ] || {{ echo 'not installed' >&2; exit 1; }} ;;\n  'plugins install '*) touch {d}/installed ;;\n  'plugins list') sleep 30 ;;\nesac\n"
        );
        let path = dir.join("hermes");
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[tokio::test]
    async fn the_switch_installs_once_then_enables_sets_a_usable_model_and_reads_back_where_hermes_stands() {
        let dir = tempfile::tempdir().unwrap();
        let h = fake(dir.path());
        let log = || std::fs::read_to_string(dir.path().join("log")).unwrap_or_default();
        assert_eq!(status(None, None).await, HermesStatus { installed: false, on: false });
        assert_eq!(status(Some(&h), None).await, HermesStatus { installed: true, on: false });
        assert_eq!(set(&h, true, None).await.unwrap(), HermesStatus { installed: true, on: true });
        assert!(log().contains("plugins install claude-subscription-directsdk --enable"), "{}", log());
        // A fresh Hermes's model isn't one the plugin runs: it gets one that is.
        assert_eq!(std::fs::read_to_string(dir.path().join("model")).unwrap().trim(), "claude-sonnet-5-5");
        assert_eq!(set(&h, false, None).await.unwrap(), HermesStatus { installed: true, on: false });
        // Second time on: the plugin is there, so it is only enabled, and the model it has is kept.
        std::fs::write(dir.path().join("model"), "claude-opus-5-5\n").unwrap();
        std::fs::write(dir.path().join("log"), "").unwrap();
        assert!(set(&h, true, None).await.unwrap().on);
        assert!(!log().contains("plugins install"), "{}", log());
        assert_eq!(log().matches("plugins enable").count(), 1, "{}", log());
        assert!(!log().contains("config set model.default"), "{}", log());
    }

    #[tokio::test]
    async fn a_hermes_that_hangs_is_stopped_with_words_saying_so() {
        let dir = tempfile::tempdir().unwrap();
        let h = fake(dir.path());
        let err = run(&h, &["plugins".into(), "list".into()], None, Duration::from_millis(300)).await.unwrap_err();
        assert!(err.contains("took longer than"), "{err}");
    }
}
