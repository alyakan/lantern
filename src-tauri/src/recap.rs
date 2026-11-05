//! Session recaps: the line Claude Code shows when you come back to a terminal after a while ("recap: You're getting
//! ready for… Next: …"). A `-p` session never makes one by itself, so when the user comes back to a chat Lantern asks
//! for it with `/recap`, in a claude of its own that resumes the session as a fork and saves nothing: the chat's own
//! transcript and its running claude are never touched.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

const RECAP_MAX: usize = 600;

/// The `claude` arguments for a recap of `session_id`: its built-in /recap, on a fork of the session that isn't saved,
/// with no MCP servers or settings (so no hooks).
pub fn args(session_id: &str) -> Vec<String> {
    ["-p", "/recap", "--resume", session_id, "--fork-session", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", ""].iter().map(|s| s.to_string()).collect()
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

/// Asks Claude for a recap of the session, run in its folder (where Claude Code keeps its transcript); None if it fails or
/// takes longer than 60s.
pub async fn generate(claude: &Path, folder: &Path, path_env: Option<&str>, session_id: &str) -> Option<String> {
    let mut cmd = tokio::process::Command::new(claude);
    cmd.args(args(session_id)).current_dir(folder).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    if let Some(path) = path_env {
        cmd.env("PATH", path);
    }
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
        let a = args("sess-1");
        assert_eq!(&a[..2], ["-p", "/recap"]);
        assert_eq!(a.iter().position(|x| x == "--resume").map(|i| a[i + 1].as_str()), Some("sess-1"));
        for flag in ["--fork-session", "--no-session-persistence", "--strict-mcp-config"] {
            assert!(a.iter().any(|x| x == flag), "{flag} missing from {a:?}");
        }
        assert_eq!(a.iter().position(|x| x == "--setting-sources").map(|i| a[i + 1].as_str()), Some(""));
    }
}
