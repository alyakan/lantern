//! Short titles for sessions. Interactive Claude Code sessions title themselves (an `ai-title` record in the
//! transcript, or a `custom-title` from /rename); sessions run with `-p`, like Lantern's, don't. For those, a quick
//! Haiku call names the session from its first prompt, and the answer is kept in Lantern's own `titles.json` (never
//! in Claude Code's transcripts).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

const TITLE_MAX: usize = 60;
const SYSTEM: &str = "You title coding chat sessions. Reply with only a title of 2 to 6 words, in sentence case, \
with no quotes, no markdown and no final punctuation. Name the task, not the person.";

/// The titles Lantern made, by session id, saved as JSON.
pub struct TitleStore {
    path: Option<PathBuf>,
    titles: Mutex<HashMap<String, String>>,
}

impl TitleStore {
    pub fn load(path: Option<PathBuf>) -> Self {
        let titles = path.as_deref().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Self { path, titles: Mutex::new(titles) }
    }

    pub fn all(&self) -> HashMap<String, String> {
        self.titles.lock().unwrap().clone()
    }

    pub fn get(&self, id: &str) -> Option<String> {
        self.titles.lock().unwrap().get(id).cloned()
    }

    pub fn set(&self, id: &str, title: &str) {
        let mut titles = self.titles.lock().unwrap();
        titles.insert(id.to_string(), title.to_string());
        if let Some(path) = &self.path {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            if let Ok(json) = serde_json::to_string(&*titles) {
                let _ = std::fs::write(path, json);
            }
        }
    }
}

/// The model's reply as a title: its first line, without quotes, a "Title:" label or final punctuation; None if empty.
pub fn clean(reply: &str) -> Option<String> {
    let line = reply.lines().map(str::trim).find(|l| !l.is_empty())?;
    let line = line.strip_prefix("Title:").unwrap_or(line).trim();
    let line = line.trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | '*' | '#' | '“' | '”')).trim();
    let line = line.trim_end_matches(['.', '!', ':', ';']).trim();
    if line.is_empty() {
        return None;
    }
    Some(if line.chars().count() <= TITLE_MAX { line.to_string() } else { format!("{}…", line.chars().take(TITLE_MAX).collect::<String>().trim_end()) })
}

/// The `claude` arguments for a title: Haiku, no tools, MCP servers, settings (so no hooks) or saved session.
pub fn args(prompt: &str) -> Vec<String> {
    let first: String = prompt.chars().take(2000).collect();
    [
        "-p",
        "--model",
        "haiku",
        "--no-session-persistence",
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--system-prompt",
        SYSTEM,
    ]
    .iter()
    .map(|s| s.to_string())
    .chain([format!("Title this session from its first message:\n\n{first}")])
    .collect()
}

/// Asks Claude for a title; None if it fails or takes longer than 45s.
pub async fn generate(claude: &Path, path_env: Option<&str>, prompt: &str) -> Option<String> {
    let mut cmd = tokio::process::Command::new(claude);
    cmd.args(args(prompt)).current_dir(std::env::temp_dir()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    if let Some(path) = path_env {
        cmd.env("PATH", path);
    }
    let out = tokio::time::timeout(Duration::from_secs(45), cmd.output()).await.ok()?.ok()?;
    if !out.status.success() {
        return None;
    }
    clean(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_the_reply_into_a_title() {
        assert_eq!(clean("Add retry backoff to fetchJson\n").as_deref(), Some("Add retry backoff to fetchJson"));
        assert_eq!(clean("\n\"Fix the login redirect.\"").as_deref(), Some("Fix the login redirect"));
        assert_eq!(clean("Title: **Review PR 128**").as_deref(), Some("Review PR 128"));
        assert_eq!(clean("  \n  "), None);
        assert!(clean(&"word ".repeat(40)).unwrap().ends_with('…'));
    }

    #[test]
    fn asks_haiku_with_nothing_loaded_and_nothing_saved() {
        let a = args("Make it faster");
        for flag in ["--no-session-persistence", "--strict-mcp-config", "--setting-sources", "--tools"] {
            assert!(a.iter().any(|x| x == flag), "{flag}");
        }
        assert!(!a.iter().any(|x| x == "--bare"));
        assert_eq!(a[a.iter().position(|x| x == "--model").unwrap() + 1], "haiku");
        assert!(a.last().unwrap().ends_with("Make it faster"));
    }

    #[test]
    fn keeps_titles_across_loads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub/titles.json");
        TitleStore::load(Some(path.clone())).set("abc", "Retry transient errors");
        assert_eq!(TitleStore::load(Some(path)).get("abc").as_deref(), Some("Retry transient errors"));
    }
}
