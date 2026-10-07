//! Commands the user runs themselves from the chat box (`!git status`), like Claude Code's `!` mode: in the chat's
//! folder, outside claude. Output streams to the UI as it comes; Claude sees it with the user's next message.

use crate::ui_event::{Sink, UiEvent};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// How often streamed output goes to the UI: a chatty command sends one event per tick, not one per read.
const FLUSH_EVERY: Duration = Duration::from_millis(50);

/// The chat's running commands, by the id the UI gave them, with their process group.
#[derive(Default)]
pub struct Shells {
    running: Mutex<HashMap<String, i32>>,
}

/// Ids come from the UI: short and plain.
pub fn valid_id(id: &str) -> bool {
    (1..=32).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The user's shell when it takes `-c` like sh does (zsh, bash), else zsh.
fn shell_path() -> String {
    match std::env::var("SHELL") {
        Ok(s) if s.ends_with("/zsh") || s.ends_with("/bash") || s.ends_with("/sh") => s,
        _ => "/bin/zsh".into(),
    }
}

/// UTF-8 text from the start of `pending`, leaving a character cut off at the end for the next read.
fn take_text(pending: &mut Vec<u8>, all: bool) -> String {
    let upto = match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        Err(e) if e.error_len().is_none() && !all => e.valid_up_to(),
        Err(_) => pending.len(),
    };
    let text = String::from_utf8_lossy(&pending[..upto]).into_owned();
    pending.drain(..upto);
    text
}

impl Shells {
    /// Starts `command` in `folder`; its output (stdout and stderr together) arrives as ShellOutput events, then
    /// ShellDone. Its own process group, so stopping it also stops whatever it started (a dev server's children).
    pub fn run(self: &std::sync::Arc<Self>, id: &str, command: &str, folder: &Path, path_env: Option<&str>, sink: Sink) -> Result<(), String> {
        if !valid_id(id) {
            return Err(format!("{id:?} is not a command id."));
        }
        let mut cmd = Command::new(shell_path());
        // One pipe for both streams keeps them in the order they were written.
        cmd.arg("-c").arg(format!("exec 2>&1\n{command}")).current_dir(folder).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).process_group(0).kill_on_drop(true);
        if let Some(p) = path_env {
            cmd.env("PATH", p);
        }
        let mut child = cmd.spawn().map_err(|e| format!("Could not run the command: {e}"))?;
        let pid = child.id().ok_or("The command exited before it started")? as i32;
        let mut out = child.stdout.take().ok_or("The command has no output pipe")?;
        self.running.lock().unwrap().insert(id.to_string(), pid);

        let (shells, id) = (self.clone(), id.to_string());
        tokio::spawn(async move {
            let mut buf = [0u8; 8192];
            let mut pending = Vec::new();
            let mut tick = tokio::time::interval(FLUSH_EVERY);
            loop {
                tokio::select! {
                    n = out.read(&mut buf) => match n {
                        Ok(0) | Err(_) => break,
                        Ok(n) => pending.extend_from_slice(&buf[..n]),
                    },
                    _ = tick.tick(), if !pending.is_empty() => {
                        let text = take_text(&mut pending, false);
                        if !text.is_empty() {
                            sink(UiEvent::ShellOutput { id: id.clone(), text });
                        }
                    }
                }
            }
            let text = take_text(&mut pending, true);
            if !text.is_empty() {
                sink(UiEvent::ShellOutput { id: id.clone(), text });
            }
            let status = child.wait().await.ok();
            let stopped = shells.running.lock().unwrap().remove(&id).is_none();
            sink(UiEvent::ShellDone { id, code: status.and_then(|s| s.code()), stopped });
        });
        Ok(())
    }

    /// Stops a running command and everything it started: SIGTERM to its group, SIGKILL if it's still there soon after.
    pub fn stop(&self, id: &str) {
        let Some(pgid) = self.running.lock().unwrap().remove(id) else { return };
        kill_group(pgid);
    }

    /// Stops every running command (the chat is closing).
    pub fn stop_all(&self) {
        let groups: Vec<i32> = self.running.lock().unwrap().drain().map(|(_, g)| g).collect();
        for g in groups {
            kill_group(g);
        }
    }
}

fn kill_group(pgid: i32) {
    unsafe { libc::kill(-pgid, libc::SIGTERM) };
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(2));
        unsafe { libc::kill(-pgid, libc::SIGKILL) };
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    fn collect() -> (Sink, mpsc::UnboundedReceiver<UiEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Arc::new(move |e| drop(tx.send(e))), rx)
    }

    /// Events until the command is done: its output joined, and how it ended.
    async fn finish(rx: &mut mpsc::UnboundedReceiver<UiEvent>) -> (String, Option<i32>, bool) {
        let mut text = String::new();
        loop {
            match tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap().unwrap() {
                UiEvent::ShellOutput { text: t, .. } => text.push_str(&t),
                UiEvent::ShellDone { code, stopped, .. } => return (text, code, stopped),
                e => panic!("unexpected {e:?}"),
            }
        }
    }

    #[test]
    fn ids_are_short_and_plain() {
        assert!(valid_id("sh-1"));
        assert!(!valid_id(""));
        assert!(!valid_id("a;b"));
        assert!(!valid_id(&"s".repeat(33)));
    }

    #[test]
    fn text_waits_for_a_character_cut_in_two() {
        let mut pending = "é".as_bytes()[..1].to_vec();
        assert_eq!(take_text(&mut pending, false), "");
        pending.extend_from_slice(&"é".as_bytes()[1..]);
        assert_eq!(take_text(&mut pending, false), "é");
        assert!(pending.is_empty());
    }

    #[tokio::test]
    async fn runs_in_the_folder_with_both_streams_and_the_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let shells = Arc::new(Shells::default());
        let (sink, mut rx) = collect();
        shells.run("a", "pwd; echo oops >&2; exit 3", dir.path(), None, sink).unwrap();
        let (text, code, stopped) = finish(&mut rx).await;
        let folder = dir.path().canonicalize().unwrap();
        assert_eq!(text, format!("{}\noops\n", folder.display()));
        assert_eq!(code, Some(3));
        assert!(!stopped);
    }

    #[tokio::test]
    async fn stopping_ends_the_command_and_what_it_started() {
        let dir = tempfile::tempdir().unwrap();
        let shells = Arc::new(Shells::default());
        let (sink, mut rx) = collect();
        shells.run("b", "echo started; sleep 30 & wait", dir.path(), None, sink).unwrap();
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap().unwrap() {
            UiEvent::ShellOutput { text, .. } => assert_eq!(text, "started\n"),
            e => panic!("unexpected {e:?}"),
        }
        shells.stop("b");
        let (_, code, stopped) = finish(&mut rx).await;
        assert!(stopped);
        assert_eq!(code, None, "ended by a signal");
    }
}
