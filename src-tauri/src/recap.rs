//! Session recaps: the line Claude Code shows when you come back to a terminal after a while ("recap: You're getting
//! ready for… Next: …"). A `-p` session never makes one by itself, so when the user comes back to a chat Lantern asks
//! for it with `/recap`, in a claude of its own that resumes the session as a fork and saves nothing: the chat's own
//! transcript and its running claude are never touched.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

const RECAP_MAX: usize = 600;

/// The model a recap is asked of first: it reads the whole session, so on the chat's own model a long chat's recap costs
/// as much as a message. A session too long for it is asked again on Claude Code's default model (see `generate`).
const RECAP_MODEL: &str = "haiku";

/// The `claude` arguments for a recap of `session_id`: its built-in /recap, on a fork of the session that isn't saved,
/// with no MCP servers or settings (so no hooks), on `model` (None: Claude Code's default).
pub fn args(session_id: &str, model: Option<&str>) -> Vec<String> {
    let mut a: Vec<String> = ["-p", "/recap", "--resume", session_id, "--fork-session", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", ""].iter().map(|s| s.to_string()).collect();
    if let Some(m) = model {
        a.push("--model".into());
        a.push(m.into());
    }
    a
}

/// The reply as one recap: its lines joined, trimmed, cut to a sensible length; None if empty.
pub fn clean(reply: &str) -> Option<String> {
    let text = reply.split_whitespace().collect::<Vec<_>>().join(" ");
    let text = text.strip_prefix("recap:").unwrap_or(&text).trim();
    if text.is_empty() {
        return None;
    }
    Some(if text.chars().count() <= RECAP_MAX { text.to_string() } else { format!("{}…", text.chars().take(RECAP_MAX).collect::<String>().trim_end()) })
}

/// Asks Claude for a recap of the session, run in its folder (where Claude Code keeps its transcript): on Haiku, and again on
/// Claude Code's default model if that fails (a session longer than Haiku's context). None if both fail or take longer than 60s.
pub async fn generate(claude: &Path, folder: &Path, path_env: Option<&str>, session_id: &str) -> Option<String> {
    match ask(claude, folder, path_env, session_id, Some(RECAP_MODEL)).await {
        Some(recap) => Some(recap),
        None => ask(claude, folder, path_env, session_id, None).await,
    }
}

async fn ask(claude: &Path, folder: &Path, path_env: Option<&str>, session_id: &str, model: Option<&str>) -> Option<String> {
    let mut cmd = tokio::process::Command::new(claude);
    cmd.args(args(session_id, model)).current_dir(folder).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    if let Some(path) = path_env {
        cmd.env("PATH", path);
    }
    // On the user's API key when they chose it for Claude Code; a key that can't be had means no recap, not one on the sign-in.
    crate::provider_keys::apply_claude_tokio(&mut cmd).ok()?;
    let out = tokio::time::timeout(Duration::from_secs(60), cmd.output()).await.ok()?.ok()?;
    if !out.status.success() {
        return None;
    }
    clean(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_the_reply_into_one_recap() {
        assert_eq!(clean("We're planning a talk.\nNext: pick the angle.\n").as_deref(), Some("We're planning a talk. Next: pick the angle."));
        assert_eq!(clean("recap: Fixing the login redirect.").as_deref(), Some("Fixing the login redirect."));
        assert_eq!(clean("  \n "), None);
        assert!(clean(&"word ".repeat(200)).unwrap().ends_with('…'));
    }

    /// The chat's session is only read: a fork that isn't saved, so its transcript gets nothing and its claude carries on.
    #[test]
    fn asks_for_a_recap_on_an_unsaved_fork_with_nothing_loaded() {
        let a = args("sess-1", Some("haiku"));
        assert_eq!(a.iter().position(|x| x == "--model").map(|i| a[i + 1].as_str()), Some("haiku"));
        assert!(!args("sess-1", None).iter().any(|x| x == "--model"), "the fallback is Claude Code's default model");
        assert_eq!(&a[..2], ["-p", "/recap"]);
        assert_eq!(a.iter().position(|x| x == "--resume").map(|i| a[i + 1].as_str()), Some("sess-1"));
        for flag in ["--fork-session", "--no-session-persistence", "--strict-mcp-config"] {
            assert!(a.iter().any(|x| x == flag), "{flag} missing from {a:?}");
        }
        assert_eq!(a.iter().position(|x| x == "--setting-sources").map(|i| a[i + 1].as_str()), Some(""));
    }
}
