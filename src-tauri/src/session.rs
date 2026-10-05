use crate::args::{build_args, HelperConfig, Mode};
use crate::stream_parser::StreamParser;
use crate::ui_event::{Sink, UiEvent};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::watch;

const STDERR_TAIL_BYTES: usize = 4000;

/// Called for every successful edit with (path, content before the edit).
pub type EditHook = Arc<dyn Fn(&str, Option<String>) + Send + Sync>;

#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub claude: PathBuf,
    pub folder: PathBuf,
    pub mode: Mode,
    /// In Step by step: Claude Code's auto mode instead of the in-app prompts (see build_args).
    pub auto_approve: bool,
    pub resume: Option<String>,
    /// `--model`; None uses Claude Code's default.
    pub model: Option<String>,
    /// `--effort`; None uses Claude Code's default.
    pub effort: Option<String>,
    pub helper: HelperConfig,
    /// PATH for the child (the user's login-shell PATH); None inherits ours.
    pub path_env: Option<String>,
}

/// One running `claude` process.
pub struct Session {
    stdin: Option<ChildStdin>,
    pid: u32,
    stopping: Arc<AtomicBool>,
    exited: watch::Receiver<bool>,
    session_id: Arc<Mutex<Option<String>>>,
    /// Numbers each control request so its control_response can be told apart.
    requests: u64,
}

impl Session {
    pub fn spawn(cfg: &SessionConfig, sink: Sink, on_edit: EditHook) -> Result<Session, String> {
        let mut cmd = Command::new(&cfg.claude);
        cmd.args(build_args(cfg.mode, cfg.auto_approve, cfg.resume.as_deref(), cfg.model.as_deref(), cfg.effort.as_deref(), &cfg.helper)).current_dir(&cfg.folder);
        if let Some(p) = &cfg.path_env {
            cmd.env("PATH", p);
        }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Failed to start {}: {e}", cfg.claude.display()))?;
        let pid = child.id().ok_or("claude exited before it started")?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or("claude has no stdout pipe")?;
        let stderr = child.stderr.take().ok_or("claude has no stderr pipe")?;

        let session_id = Arc::new(Mutex::new(cfg.resume.clone()));
        let stopping = Arc::new(AtomicBool::new(false));
        let tail = Arc::new(Mutex::new(String::new()));
        let (exit_tx, exited) = watch::channel(false);

        let stderr_task = {
            let tail = tail.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    push_tail(&mut tail.lock().unwrap(), &line);
                }
            })
        };

        {
            let (sid, stopping, tail) = (session_id.clone(), stopping.clone(), tail.clone());
            tokio::spawn(async move {
                let mut parser = StreamParser::default();
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    for ev in parser.parse_line(&line) {
                        match &ev {
                            UiEvent::SessionStarted { session_id, .. } => {
                                *sid.lock().unwrap() = Some(session_id.clone());
                            }
                            UiEvent::EditApplied { path, original, .. } => on_edit(path, original.clone()),
                            _ => {}
                        }
                        sink(ev);
                    }
                }
                let status = child.wait().await.ok();
                let _ = tokio::time::timeout(Duration::from_secs(1), stderr_task).await;
                if !stopping.load(Ordering::SeqCst) {
                    let stderr_tail = tail.lock().unwrap().clone();
                    sink(UiEvent::SessionEnded { code: status.and_then(|s| s.code()), stderr_tail });
                }
                let _ = exit_tx.send(true);
            });
        }

        Ok(Session { stdin, pid, stopping, exited, session_id, requests: 0 })
    }

    pub fn session_id(&self) -> Option<String> {
        self.session_id.lock().unwrap().clone()
    }

    pub fn is_running(&self) -> bool {
        !*self.exited.borrow()
    }

    pub async fn send(&mut self, text: &str) -> Result<(), String> {
        let msg = serde_json::json!({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}});
        let stdin = self.stdin.as_mut().ok_or("The Claude session is not running")?;
        stdin.write_all(format!("{msg}\n").as_bytes()).await.map_err(|e| format!("Could not send to claude: {e}"))?;
        stdin.flush().await.map_err(|e| format!("Could not send to claude: {e}"))
    }

    /// Ends the current turn with stream-json's in-band interrupt (the one the Agent SDK uses): claude answers
    /// with a control_response, ends the turn with an interrupted result, and keeps running — no restart.
    /// Falls back to SIGINT if the request can't be written. Never SIGTERM: that leaves the turn unfinished.
    pub async fn interrupt(&mut self) {
        if self.is_running() && !self.control(serde_json::json!({"subtype": "interrupt"})).await {
            unsafe { libc::kill(self.pid as libc::pid_t, libc::SIGINT) };
        }
    }

    /// Switches the model from the next turn on, in-band (claude re-announces it in a fresh init message).
    /// None goes back to Claude Code's default.
    pub async fn set_model(&mut self, model: Option<&str>) -> Result<(), String> {
        let request = match model {
            Some(m) => serde_json::json!({"subtype": "set_model", "model": m}),
            None => serde_json::json!({"subtype": "set_model"}),
        };
        if self.control(request).await { Ok(()) } else { Err("Claude isn't running.".into()) }
    }

    /// Switches the permission mode in-band, e.g. out of plan mode once the plan is approved.
    pub async fn set_permission_mode(&mut self, mode: crate::args::Mode) -> Result<(), String> {
        let request = serde_json::json!({"subtype": "set_permission_mode", "mode": mode.cli_name()});
        if self.control(request).await { Ok(()) } else { Err("Claude isn't running.".into()) }
    }

    /// Stops one background task (a run_in_background command, a background agent) by its task id.
    pub async fn stop_task(&mut self, task_id: &str) -> Result<(), String> {
        if self.control(serde_json::json!({"subtype": "stop_task", "task_id": task_id})).await { Ok(()) } else { Err("Claude isn't running.".into()) }
    }

    /// Asks claude what it offers, as the Agent SDK does first thing; the reply lists the slash commands. It also
    /// says the app stops background tasks one by one, so Stop only ends the turn and leaves them running.
    pub async fn initialize(&mut self) {
        self.control(serde_json::json!({"subtype": "initialize", "perTaskStopAffordance": true})).await;
    }

    /// Writes a stream-json control_request; the parser turns the replies worth showing into events.
    async fn control(&mut self, request: serde_json::Value) -> bool {
        self.requests += 1;
        let msg = serde_json::json!({"type": "control_request", "request_id": format!("lantern-{}", self.requests), "request": request});
        match self.stdin.as_mut() {
            Some(stdin) => stdin.write_all(format!("{msg}\n").as_bytes()).await.is_ok() && stdin.flush().await.is_ok(),
            None => false,
        }
    }

    /// Shuts the process down on purpose; no SessionEnded event follows.
    pub async fn stop(mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        drop(self.stdin.take());
        if self.is_running() {
            unsafe { libc::kill(self.pid as libc::pid_t, libc::SIGTERM) };
        }
        let timed_out = tokio::time::timeout(Duration::from_secs(5), self.exited.wait_for(|done| *done)).await.is_err();
        if timed_out && self.is_running() {
            unsafe { libc::kill(self.pid as libc::pid_t, libc::SIGKILL) };
            let _ = tokio::time::timeout(Duration::from_secs(1), self.exited.wait_for(|done| *done)).await;
        }
    }
}

fn push_tail(tail: &mut String, line: &str) {
    tail.push_str(line);
    tail.push('\n');
    if tail.len() > STDERR_TAIL_BYTES {
        let mut cut = tail.len() - STDERR_TAIL_BYTES;
        while !tail.is_char_boundary(cut) {
            cut += 1;
        }
        tail.drain(..cut);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tokio::sync::mpsc;

    const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/stream/write_create_and_error.jsonl");

    fn script(dir: &std::path::Path, body: &str) -> PathBuf {
        let p = dir.join("fake-claude");
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    fn config(claude: PathBuf, folder: &std::path::Path, resume: Option<&str>) -> SessionConfig {
        SessionConfig {
            claude,
            folder: folder.to_path_buf(),
            mode: Mode::Ask,
            auto_approve: false,
            resume: resume.map(String::from),
            model: None,
            effort: None,
            helper: HelperConfig { exe: "/usr/bin/true".into(), socket: "/tmp/none.sock".into() },
            path_env: None,
        }
    }

    fn channel_sink() -> (Sink, mpsc::UnboundedReceiver<UiEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Arc::new(move |ev| { let _ = tx.send(ev); }), rx)
    }

    fn no_edits() -> EditHook {
        Arc::new(|_: &str, _: Option<String>| {})
    }

    /// Polls until `path` exists and returns its contents, rather than a fixed sleep:
    /// on this machine, a freshly-written script's first exec can take longer than a
    /// couple hundred ms (macOS scans newly created executables before running them),
    /// so a fixed short sleep was flaky.
    async fn wait_for_file(path: &std::path::Path) -> String {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                // Non-empty, too: the shell creates the file before writing to it.
                if let Some(contents) = std::fs::read_to_string(path).ok().filter(|c| !c.is_empty()) {
                    return contents;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("timed out waiting for file to appear")
    }

    async fn next_matching(rx: &mut mpsc::UnboundedReceiver<UiEvent>, pred: impl Fn(&UiEvent) -> bool) -> UiEvent {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let ev = rx.recv().await.expect("event channel closed");
                if pred(&ev) {
                    return ev;
                }
            }
        })
        .await
        .expect("timed out waiting for event")
    }

    #[tokio::test]
    async fn interrupt_and_set_model_are_in_band_control_requests_that_keep_the_process() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().display();
        let fake = script(dir.path(), &format!("while IFS= read -r line; do\n  printf '%s\\n' \"$line\" >> {d}/stdin.txt\ndone"));
        let (sink, _rx) = channel_sink();
        let mut s = Session::spawn(&config(fake, dir.path(), None), sink, no_edits()).unwrap();
        s.interrupt().await;
        let sent: serde_json::Value = serde_json::from_str(wait_for_file(&dir.path().join("stdin.txt")).await.trim()).unwrap();
        assert_eq!(sent["type"], "control_request");
        assert_eq!(sent["request"]["subtype"], "interrupt");
        assert!(s.is_running(), "an interrupt must not end the process");

        s.set_model(Some("sonnet")).await.unwrap();
        s.set_model(None).await.unwrap();
        s.stop_task("b2qyaawj0").await.unwrap();
        let lines = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let text = std::fs::read_to_string(dir.path().join("stdin.txt")).unwrap();
                if text.lines().count() >= 4 {
                    return text;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        let reqs: Vec<serde_json::Value> = lines.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(reqs[1]["request"], serde_json::json!({"subtype": "set_model", "model": "sonnet"}));
        assert_eq!(reqs[2]["request"], serde_json::json!({"subtype": "set_model"}));
        assert_ne!(reqs[1]["request_id"], reqs[2]["request_id"]);
        assert_eq!(reqs[3]["request"], serde_json::json!({"subtype": "stop_task", "task_id": "b2qyaawj0"}));
        s.stop().await;
    }

    #[tokio::test]
    async fn streams_fixture_events_records_session_and_edits() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().display();
        let fake = script(
            dir.path(),
            &format!("printf '%s\\n' \"$@\" > {d}/args.txt\nwhile IFS= read -r line; do\n  printf '%s\\n' \"$line\" >> {d}/stdin.txt\n  cat {FIXTURE}\ndone"),
        );
        let (sink, mut rx) = channel_sink();
        let edits = Arc::new(Mutex::new(Vec::new()));
        let e2 = edits.clone();
        let hook: EditHook = Arc::new(move |p: &str, o: Option<String>| e2.lock().unwrap().push((p.to_string(), o)));
        let mut s = Session::spawn(&config(fake, dir.path(), None), sink, hook).unwrap();

        let text = "say \"hi\"\nsecond line ünïcode";
        s.send(text).await.unwrap();
        next_matching(&mut rx, |e| matches!(e, UiEvent::TurnDone { .. })).await;

        assert_eq!(s.session_id().as_deref(), Some("fbc46b98-a81a-4d3c-b78e-f98203416065"));
        assert_eq!(
            *edits.lock().unwrap(),
            vec![("/tmp/proj/new.txt".to_string(), None), ("/tmp/proj/hello.txt".to_string(), Some("hi\n".to_string()))]
        );
        let stdin = std::fs::read_to_string(dir.path().join("stdin.txt")).unwrap();
        assert_eq!(stdin.lines().count(), 1, "message must be a single JSON line");
        let sent: serde_json::Value = serde_json::from_str(stdin.trim()).unwrap();
        assert_eq!(sent["type"], "user");
        assert_eq!(sent["message"]["content"][0]["text"], text);
        let args = std::fs::read_to_string(dir.path().join("args.txt")).unwrap();
        assert!(args.contains("stream-json") && !args.contains("--bare"));

        s.stop().await;
        let late = tokio::time::timeout(Duration::from_millis(300), async {
            loop {
                match rx.recv().await {
                    Some(UiEvent::SessionEnded { .. }) => return true,
                    Some(_) => continue,
                    None => return false,
                }
            }
        })
        .await;
        assert!(!matches!(late, Ok(true)), "stop() must not emit SessionEnded");
    }

    #[tokio::test]
    async fn unexpected_exit_emits_session_ended_with_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let fake = script(dir.path(), "echo 'boom: not logged in' >&2\nexit 3");
        let (sink, mut rx) = channel_sink();
        let _s = Session::spawn(&config(fake, dir.path(), None), sink, no_edits()).unwrap();
        match next_matching(&mut rx, |e| matches!(e, UiEvent::SessionEnded { .. })).await {
            UiEvent::SessionEnded { code, stderr_tail } => {
                assert_eq!(code, Some(3));
                assert!(stderr_tail.contains("boom: not logged in"));
            }
            _ => unreachable!(),
        }
    }

    #[tokio::test]
    async fn resume_id_is_passed_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().display();
        let fake = script(dir.path(), &format!("printf '%s\\n' \"$@\" > {d}/args.txt\ncat > /dev/null"));
        let (sink, _rx) = channel_sink();
        let s = Session::spawn(&config(fake, dir.path(), Some("sess-42")), sink, no_edits()).unwrap();
        assert_eq!(s.session_id().as_deref(), Some("sess-42"));
        let args_path = dir.path().join("args.txt");
        let args = wait_for_file(&args_path).await;
        assert!(args.contains("--resume\nsess-42\n"));
        assert!(s.is_running());
        s.stop().await;
    }

    #[tokio::test]
    async fn path_env_is_applied_to_the_child() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().display();
        let fake = script(dir.path(), &format!("printf '%s' \"$PATH\" > {d}/path.txt\ncat > /dev/null"));
        let (sink, _rx) = channel_sink();
        let mut cfg = config(fake, dir.path(), None);
        cfg.path_env = Some("/custom/bin:/usr/bin:/bin".into());
        let s = Session::spawn(&cfg, sink, no_edits()).unwrap();
        let path_file = dir.path().join("path.txt");
        let got = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Ok(c) = std::fs::read_to_string(&path_file) {
                    if !c.is_empty() {
                        return c;
                    }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("timed out waiting for path.txt");
        assert_eq!(got, "/custom/bin:/usr/bin:/bin");
        s.stop().await;
    }

    #[tokio::test]
    async fn missing_binary_is_a_clear_error() {
        let dir = tempfile::tempdir().unwrap();
        let (sink, _rx) = channel_sink();
        let err = Session::spawn(&config(dir.path().join("nope"), dir.path(), None), sink, no_edits()).err().unwrap();
        assert!(err.contains("Failed to start"));
    }
}
