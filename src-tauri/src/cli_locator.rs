use std::io::{Read, Seek, SeekFrom};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Where Claude Code is usually installed. GUI apps don't inherit the shell PATH on macOS.
pub fn candidate_paths(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join(".local/bin/claude"),
        home.join(".claude/local/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ]
}

pub fn locate(override_path: Option<&str>) -> Result<PathBuf, String> {
    if let Some(p) = override_path.map(str::trim).filter(|p| !p.is_empty()) {
        let p = PathBuf::from(p);
        return if is_executable(&p) { Ok(p) } else { Err(format!("{} is not an executable file", p.display())) };
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "HOME is not set".to_string())?;
    if let Some(p) = candidate_paths(&home).into_iter().find(|p| is_executable(p)) {
        return Ok(p);
    }
    from_login_shell().ok_or_else(|| "Could not find the `claude` CLI. Install Claude Code, or enter its path.".to_string())
}

const BEGIN: &str = "__LANTERN_BEGIN__";
const END: &str = "__LANTERN_END__";
/// A slow shell profile must never stall the app.
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);

fn user_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
}

/// The text between the markers, ignoring anything the shell's rc files print around it.
fn extract_marked(stdout: &str) -> Option<String> {
    let start = stdout.find(BEGIN)? + BEGIN.len();
    let len = stdout[start..].find(END)?;
    let value = stdout[start..start + len].trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// Evaluates `expr` in an interactive login shell (`-ilc`), so both ~/.zprofile and ~/.zshrc are read.
/// nvm and similar tools usually set PATH in ~/.zshrc, which a plain login shell (`-lc`) skips.
fn shell_value(shell: &str, expr: &str, timeout: Duration) -> Option<String> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let script = format!("printf '%s%s%s' '{BEGIN}' {expr} '{END}'");
    // The output goes to a file, not a pipe: a background job from an rc file can hold a pipe open forever, and
    // reading it would block past the timeout. The file is unlinked at once; only this handle reads it.
    let path = std::env::temp_dir().join(format!("lantern-shell-{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
    let mut out = std::fs::OpenOptions::new().read(true).write(true).create_new(true).open(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    let mut child = Command::new(shell)
        .args(["-ilc", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::from(out.try_clone().ok()?))
        .stderr(Stdio::null())
        // Its own group, so a timeout stops what the rc files started too.
        .process_group(0)
        .spawn()
        .ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL) };
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut bytes = Vec::new();
    out.seek(SeekFrom::Start(0)).ok()?;
    out.read_to_end(&mut bytes).ok()?;
    extract_marked(&String::from_utf8_lossy(&bytes))
}

fn from_login_shell() -> Option<PathBuf> {
    let p = PathBuf::from(shell_value(&user_shell(), "\"$(command -v claude)\"", SHELL_TIMEOUT)?);
    is_executable(&p).then_some(p)
}

/// The PATH the user's terminal would have. GUI apps launched from Finder get a bare PATH,
/// but the user's hooks and MCP servers need node, Homebrew tools, and so on.
pub fn login_shell_path() -> Option<String> {
    shell_value(&user_shell(), "\"$PATH\"", SHELL_TIMEOUT)
}

pub fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn file_with_mode(dir: &Path, name: &str, mode: u32) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
        p
    }

    #[test]
    fn executable_detection() {
        let dir = tempfile::tempdir().unwrap();
        assert!(is_executable(&file_with_mode(dir.path(), "a", 0o755)));
        assert!(!is_executable(&file_with_mode(dir.path(), "b", 0o644)));
        assert!(!is_executable(&dir.path().join("missing")));
        assert!(!is_executable(dir.path()));
    }

    #[test]
    fn override_wins_when_executable() {
        let dir = tempfile::tempdir().unwrap();
        let p = file_with_mode(dir.path(), "claude", 0o755);
        assert_eq!(locate(Some(p.to_str().unwrap())).unwrap(), p);
    }

    #[test]
    fn override_that_is_not_executable_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let p = file_with_mode(dir.path(), "claude", 0o644);
        assert!(locate(Some(p.to_str().unwrap())).unwrap_err().contains("not an executable"));
    }

    #[test]
    fn extracts_the_marked_value_from_noisy_shell_output() {
        let noisy = "Welcome to oh-my-zsh!\n__LANTERN_BEGIN__/opt/homebrew/bin:/Users/x/.nvm/versions/node/v22/bin__LANTERN_END__\nbye";
        assert_eq!(extract_marked(noisy).as_deref(), Some("/opt/homebrew/bin:/Users/x/.nvm/versions/node/v22/bin"));
        assert_eq!(extract_marked("__LANTERN_BEGIN____LANTERN_END__"), None);
        assert_eq!(extract_marked("no markers"), None);
    }

    #[test]
    fn interactive_shell_output_reads_rc_files_and_times_out() {
        let dir = tempfile::tempdir().unwrap();
        // A fake $SHELL that behaves like zsh reading .zshrc: prints a banner, then runs the -c script.
        let shell = dir.path().join("fakeshell");
        std::fs::write(&shell, "#!/bin/sh\necho 'banner from rc file'\nPATH=/from/rc:$PATH\nexport PATH\nshift\nexec /bin/sh -c \"$1\"\n").unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = shell_value(shell.to_str().unwrap(), "\"$PATH\"", std::time::Duration::from_secs(5)).unwrap();
        assert!(path.starts_with("/from/rc:"), "got {path}");

        let slow = dir.path().join("slowshell");
        std::fs::write(&slow, "#!/bin/sh\nsleep 10\n").unwrap();
        std::fs::set_permissions(&slow, std::fs::Permissions::from_mode(0o755)).unwrap();
        let started = std::time::Instant::now();
        assert_eq!(shell_value(slow.to_str().unwrap(), "\"$PATH\"", std::time::Duration::from_millis(300)), None);
        assert!(started.elapsed() < std::time::Duration::from_secs(3));

        // A job the rc files started keeps the shell's output open after the shell has answered.
        let bg = dir.path().join("bgshell");
        std::fs::write(&bg, "#!/bin/sh\nsleep 5 &\nshift\nexec /bin/sh -c \"$1\"\n").unwrap();
        std::fs::set_permissions(&bg, std::fs::Permissions::from_mode(0o755)).unwrap();
        let started = std::time::Instant::now();
        assert!(shell_value(bg.to_str().unwrap(), "\"$PATH\"", std::time::Duration::from_secs(5)).is_some());
        // Under 5s, the job's own length, but with room for a loaded machine running the whole suite.
        assert!(started.elapsed() < std::time::Duration::from_millis(4500), "waited on the background job");
    }

    #[test]
    fn candidates_start_with_local_bin() {
        let c = candidate_paths(Path::new("/Users/x"));
        assert_eq!(c[0], PathBuf::from("/Users/x/.local/bin/claude"));
        assert!(c.contains(&PathBuf::from("/opt/homebrew/bin/claude")));
    }
}
