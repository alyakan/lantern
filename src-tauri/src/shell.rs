//! Commands the user runs themselves from the chat box (`!git status`), like Claude Code's `!` mode: in the chat's
//! folder, outside claude. Output streams to the UI as it comes; Claude sees it with the user's next message.
//!
//! Each runs in its own terminal (a pty, as its own session), so programs ask what they would ask in Terminal — a
//! password, a y/n — and the user answers from the app (see `input`). A prompt that turns echo off is a secret one.

use crate::ui_event::{Sink, UiEvent};
use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::Path;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// How often streamed output goes to the UI: a chatty command sends one event per tick, not one per read.
const FLUSH_EVERY: Duration = Duration::from_millis(50);
/// How often a command's terminal is checked for a secret prompt (echo turned off).
const SECRET_EVERY: Duration = Duration::from_millis(150);

struct Running {
    /// Its process group: it leads its own session, so its pid.
    pgid: i32,
    /// Its terminal's master side, for typing into it and reading its settings.
    tty: File,
}

/// The chat's running commands, by the id the UI gave them.
#[derive(Default)]
pub struct Shells {
    running: Mutex<HashMap<String, Running>>,
}

/// A new terminal: (master, the command's side). Wide enough that tools don't wrap their output early.
fn open_pty() -> Result<(OwnedFd, OwnedFd), String> {
    let (mut master, mut slave) = (0, 0);
    let mut size = libc::winsize { ws_row: 40, ws_col: 120, ws_xpixel: 0, ws_ypixel: 0 };
    if unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null_mut(), &mut size) } != 0 {
        return Err(format!("Could not open a terminal for the command: {}", std::io::Error::last_os_error()));
    }
    // The command gets its own side only.
    unsafe { libc::fcntl(master, libc::F_SETFD, libc::FD_CLOEXEC) };
    Ok(unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) })
}

/// A program reading a password turns echo off but keeps reading lines; one that turns both off (a menu you move
/// through with arrow keys) isn't asking for a secret.
fn secret_prompt(tty: &File) -> bool {
    let mut t: libc::termios = unsafe { std::mem::zeroed() };
    if unsafe { libc::tcgetattr(tty.as_raw_fd(), &mut t) } != 0 {
        return false;
    }
    t.c_lflag & libc::ECHO == 0 && t.c_lflag & libc::ICANON != 0
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
        let (master, slave) = open_pty()?;
        let side = |fd: &OwnedFd| fd.try_clone().map(Stdio::from).map_err(|e| e.to_string());
        let mut cmd = Command::new(shell_path());
        // A plain terminal: tools print lines instead of redrawing them with cursor moves.
        cmd.arg("-c").arg(command).current_dir(folder).env("TERM", "dumb").stdin(side(&slave)?).stdout(side(&slave)?).stderr(side(&slave)?).kill_on_drop(true);
        if let Some(p) = path_env {
            cmd.env("PATH", p);
        }
        // Its own session, with the terminal as its controlling one: what it asks (sudo, ssh) comes here, and stopping
        // its process group stops whatever it started.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = cmd.spawn().map_err(|e| format!("Could not run the command: {e}"))?;
        // Only the command holds its side now, so the output ends when it (and what it started) is done.
        drop(cmd);
        drop(slave);
        let pid = child.id().ok_or("The command exited before it started")? as i32;
        let tty = File::from(master);
        let mut out = tokio::fs::File::from_std(tty.try_clone().map_err(|e| e.to_string())?);
        let watch = tty.try_clone().map_err(|e| e.to_string())?;
        self.running.lock().unwrap().insert(id.to_string(), Running { pgid: pid, tty });

        let (shells, id) = (self.clone(), id.to_string());
        tokio::spawn(async move {
            let mut buf = [0u8; 8192];
            let mut pending = Vec::new();
            let mut tick = tokio::time::interval(FLUSH_EVERY);
            let mut check = tokio::time::interval(SECRET_EVERY);
            let mut secret = false;
            loop {
                tokio::select! {
                    // The terminal ends with EIO (macOS) or EOF once nothing holds the command's side.
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
                    _ = check.tick() => {
                        let now = secret_prompt(&watch);
                        if now != secret {
                            secret = now;
                            sink(UiEvent::ShellSecret { id: id.clone(), secret });
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

    /// Types `text` into a running command's terminal: a reply ending in "\r" (Enter), or "\u{4}" (⌃D, end of input).
    pub fn input(&self, id: &str, text: &str) -> Result<(), String> {
        let mut running = self.running.lock().unwrap();
        let r = running.get_mut(id).ok_or("That command has ended.")?;
        r.tty.write_all(text.as_bytes()).map_err(|e| format!("Could not type into the command: {e}"))
    }

    /// Stops a running command and everything it started: SIGTERM to its group, SIGKILL if it's still there soon after.
    pub fn stop(&self, id: &str) {
        let Some(r) = self.running.lock().unwrap().remove(id) else { return };
        kill_group(r.pgid);
    }

    /// Stops every running command (the chat is closing).
    pub fn stop_all(&self) {
        let groups: Vec<i32> = self.running.lock().unwrap().drain().map(|(_, r)| r.pgid).collect();
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

    /// Events until the command is done: its output joined (a terminal ends lines with \r\n), and how it ended.
    async fn finish(rx: &mut mpsc::UnboundedReceiver<UiEvent>) -> (String, Option<i32>, bool) {
        let mut text = String::new();
        loop {
            match tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap().unwrap() {
                UiEvent::ShellOutput { text: t, .. } => text.push_str(&t.replace("\r\n", "\n")),
                UiEvent::ShellDone { code, stopped, .. } => return (text, code, stopped),
                UiEvent::ShellSecret { .. } => {}
                e => panic!("unexpected {e:?}"),
            }
        }
    }

    /// Output until it contains `want`.
    async fn until_output(rx: &mut mpsc::UnboundedReceiver<UiEvent>, want: &str) -> String {
        let mut text = String::new();
        while !text.contains(want) {
            match tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap().unwrap() {
                UiEvent::ShellOutput { text: t, .. } => text.push_str(&t),
                UiEvent::ShellSecret { .. } => {}
                e => panic!("unexpected {e:?}"),
            }
        }
        text
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
        until_output(&mut rx, "started").await;
        shells.stop("b");
        let (_, code, stopped) = finish(&mut rx).await;
        assert!(stopped);
        assert_eq!(code, None, "ended by a signal");
    }

    #[tokio::test]
    async fn runs_in_a_terminal_of_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let shells = Arc::new(Shells::default());
        let (sink, mut rx) = collect();
        shells.run("t", "test -t 0 && test -t 1 && echo tty > /dev/tty; ps -o pgid= -p $$ | tr -d ' '; echo $$", dir.path(), None, sink).unwrap();
        let (text, code, _) = finish(&mut rx).await;
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "tty");
        assert_eq!(lines[1], lines[2], "the shell leads its own process group (and session)");
        assert_eq!(code, Some(0));
    }

    #[tokio::test]
    async fn a_reply_reaches_what_the_command_reads() {
        let dir = tempfile::tempdir().unwrap();
        let shells = Arc::new(Shells::default());
        let (sink, mut rx) = collect();
        shells.run("r", "printf 'Continue? [y/N] '; read answer; echo \"got $answer\"", dir.path(), None, sink).unwrap();
        until_output(&mut rx, "Continue? [y/N] ").await;
        shells.input("r", "y\r").unwrap();
        let (text, code, _) = finish(&mut rx).await;
        // The terminal echoes the reply, as it would in Terminal.
        assert_eq!(text, "y\ngot y\n");
        assert_eq!(code, Some(0));
        assert!(shells.input("r", "late\r").is_err(), "it has ended");
    }

    #[tokio::test]
    async fn a_password_prompt_is_secret_and_its_reply_is_not_echoed() {
        let dir = tempfile::tempdir().unwrap();
        let shells = Arc::new(Shells::default());
        let (sink, mut rx) = collect();
        shells.run("p", "stty -echo; printf 'Password:'; read pw; stty echo; echo; echo \"length ${#pw}\"", dir.path(), None, sink).unwrap();
        loop {
            match tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap().unwrap() {
                UiEvent::ShellSecret { secret: true, .. } => break,
                UiEvent::ShellOutput { .. } => {}
                e => panic!("unexpected {e:?}"),
            }
        }
        shells.input("p", "hunter2\r").unwrap();
        let mut text = String::new();
        let mut cleared = false;
        loop {
            match tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap().unwrap() {
                UiEvent::ShellOutput { text: t, .. } => text.push_str(&t),
                UiEvent::ShellSecret { secret: false, .. } => cleared = true,
                UiEvent::ShellDone { .. } => break,
                e => panic!("unexpected {e:?}"),
            }
        }
        assert!(text.contains("length 7"));
        assert!(!text.contains("hunter2"));
        let _ = cleared; // echo comes back on, though the command may end before it's seen
    }
}
