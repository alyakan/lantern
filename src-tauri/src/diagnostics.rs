//! Help ▸ Report a Bug: the facts a bug report needs, copied to the clipboard for the issue form to take. Only the
//! versions, the model and the last error go in. The error is cut to its first line and its home folder is shown as
//! ~; nothing else (no prompts, no files, no other paths) is read or sent.

use std::io::{Read, Write};
use std::process::{Command, Stdio};

/// How much of the last error goes in: enough for the message, not a whole stack or a pasted file.
const ERROR_CHARS: usize = 300;

/// The block the issue form asks for: Lantern, macOS and Claude Code versions, the model, and the last error.
pub fn report(app_version: &str, macos: Option<&str>, claude: Option<&str>, model: Option<&str>, last_error: Option<&str>, home: Option<&str>) -> String {
    let error = last_error.map(|e| redact(&first_line(e), home)).filter(|e| !e.is_empty()).unwrap_or_else(|| "none".into());
    format!(
        "```text\nLantern {app_version}\nmacOS {}\nClaude Code {}\nModel {}\nLast error: {error}\n```",
        macos.unwrap_or("unknown"),
        claude.unwrap_or("unknown"),
        model.unwrap_or("default"),
    )
}

/// The error's first line, cut to ERROR_CHARS.
fn first_line(text: &str) -> String {
    text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").chars().take(ERROR_CHARS).collect()
}

/// `text` with the home folder shown as ~ (so the user name doesn't go into the report).
fn redact(text: &str, home: Option<&str>) -> String {
    match home {
        Some(home) if home.len() > 1 => text.replace(home, "~"),
        _ => text.to_string(),
    }
}

/// macOS's version, as `sw_vers` reports it ("15.4").
pub fn macos_version() -> Option<String> {
    let out = Command::new("sw_vers").arg("-productVersion").output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|v| !v.is_empty())
}

/// How long `claude --version` may take before the report goes without it.
const VERSION_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// The Claude Code version the CLI at `claude_path` reports, e.g. "2.1.284 (Claude Code)". `path_env` is the PATH a
/// login shell gives, which the CLI's own launcher may need (it runs node). Gives up after VERSION_WAIT.
pub fn claude_version(claude_path: &str, path_env: Option<&str>) -> Option<String> {
    cli_version(claude_path, path_env)
}

/// The first line `<cli> --version` prints, for any agent CLI (Claude Code's and Codex's both answer so).
pub fn cli_version(cli_path: &str, path_env: Option<&str>) -> Option<String> {
    let mut command = Command::new(cli_path);
    command.arg("--version").stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(path) = path_env {
        command.env("PATH", path);
    }
    let mut child = command.spawn().ok()?;
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().ok()? {
            break status;
        }
        if started.elapsed() > VERSION_WAIT {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    let mut stdout = String::new();
    child.stdout.take()?.read_to_string(&mut stdout).ok()?;
    status.success().then(|| stdout.lines().next().unwrap_or("").trim().to_string()).filter(|v| !v.is_empty())
}

/// Puts `text` on the clipboard, with macOS's own pbcopy.
pub fn copy(text: &str) -> Result<(), String> {
    let mut child = Command::new("pbcopy").stdin(Stdio::piped()).spawn().map_err(|e| format!("Couldn't copy the diagnostics: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(text.as_bytes()).map_err(|e| format!("Couldn't copy the diagnostics: {e}"))?;
    }
    let status = child.wait().map_err(|e| format!("Couldn't copy the diagnostics: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Couldn't copy the diagnostics.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_block_has_the_versions_the_model_and_the_error_and_nothing_else() {
        let block = report("0.1.16", Some("15.4"), Some("2.1.284 (Claude Code)"), Some("claude-opus-5-5"), Some("Rate limited, try later"), Some("/Users/someone"));
        assert_eq!(
            block,
            "```text\nLantern 0.1.16\nmacOS 15.4\nClaude Code 2.1.284 (Claude Code)\nModel claude-opus-5-5\nLast error: Rate limited, try later\n```"
        );
    }

    #[test]
    fn what_is_not_known_says_so_and_no_error_says_none() {
        let block = report("0.1.16", None, None, None, None, None);
        assert_eq!(block, "```text\nLantern 0.1.16\nmacOS unknown\nClaude Code unknown\nModel default\nLast error: none\n```");
        assert!(report("0.1.16", None, None, None, Some("  \n  "), None).ends_with("Last error: none\n```"));
    }

    #[test]
    fn the_home_folder_is_shown_as_a_tilde_wherever_it_is_in_the_error() {
        let block = report("0.1.16", None, None, None, Some("ENOENT: /Users/someone/app/x.ts"), Some("/Users/someone"));
        assert!(block.contains("Last error: ENOENT: ~/app/x.ts"), "{block}");
        assert!(!block.contains("someone"));
    }

    #[test]
    fn only_the_first_line_of_a_long_error_goes_in_and_it_is_cut() {
        let long = format!("{}\nsecond line with a file's text", "x".repeat(500));
        let block = report("0.1.16", None, None, None, Some(&long), None);
        assert!(!block.contains("second line"));
        assert!(block.contains(&format!("Last error: {}", "x".repeat(ERROR_CHARS))));
        assert!(!block.contains(&"x".repeat(ERROR_CHARS + 1)));
    }

    #[test]
    fn a_root_home_is_not_replaced_everywhere() {
        assert_eq!(redact("/tmp/a", Some("/")), "/tmp/a");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn the_macos_version_is_read_from_sw_vers() {
        let version = macos_version().expect("sw_vers answers on a Mac");
        assert!(version.chars().next().is_some_and(|c| c.is_ascii_digit()), "{version}");
    }

    #[test]
    #[cfg(unix)]
    fn the_first_line_of_what_claude_reports_is_its_version() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("claude");
        std::fs::write(&fake, "#!/bin/sh\necho '2.9.9 (Claude Code)'\necho 'more'\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(claude_version(fake.to_str().unwrap(), None), Some("2.9.9 (Claude Code)".into()));
    }

    #[test]
    fn a_missing_claude_binary_has_no_version() {
        assert_eq!(claude_version("/definitely/not/a/claude/binary", None), None);
    }
}
