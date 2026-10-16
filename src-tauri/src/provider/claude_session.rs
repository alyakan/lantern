//! A running `claude` process: stream-json lines in and out, and the control requests on the same pipes.

use crate::args::{enabled_plugins, launch_args, Role, ADVISOR_REVIEW_ENV};
use crate::session::{EditHook, SessionConfig};
use crate::stream_parser::StreamParser;
use crate::ui_event::{Sink, UiEvent};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{watch, Mutex as AsyncMutex};

const STDERR_TAIL_BYTES: usize = 4000;

/// One running `claude` process.
pub struct ClaudeSession {
    /// Shared with the reader task, which answers the control requests it refuses. None once closed.
    stdin: Arc<AsyncMutex<Option<ChildStdin>>>,
    pid: u32,
    stopping: Arc<AtomicBool>,
    exited: watch::Receiver<bool>,
    session_id: Arc<Mutex<Option<String>>>,
    /// Numbers each control request so its control_response can be told apart.
    requests: u64,
    /// Requests whose reply someone waits for (see `request`), by request id.
    replies: Replies,
}

type Replies = Arc<Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>>>>;

/// A control_response for a request someone waits for: its reply (or error) goes to them, and true.
fn deliver(replies: &Replies, line: &str) -> bool {
    if !line.contains("\"control_response\"") {
        return false;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return false };
    let r = &v["response"];
    let Some(tx) = r["request_id"].as_str().and_then(|id| replies.lock().unwrap().remove(id)) else { return false };
    let reply = if r["subtype"] == "error" { Err(r["error"].as_str().unwrap_or("Claude couldn't do that.").to_string()) } else { Ok(r["response"].clone()) };
    let _ = tx.send(reply);
    true
}

/// The claude command for `cfg`: program, arguments, environment and folder, before it is started.
fn command(cfg: &SessionConfig) -> Command {
    let mut cmd = Command::new(&cfg.binary);
    let worker = matches!(cfg.helper.role, Role::Worker { .. });
    // A worker starts with none of the user's plugins: which those are is read from their settings (see launch_args).
    let plugins = if worker { std::env::var_os("HOME").map(|home| enabled_plugins(std::path::Path::new(&home), &cfg.folder)).unwrap_or_default() } else { vec![] };
    cmd.args(launch_args(cfg.mode, cfg.auto_approve, cfg.resume.as_deref(), cfg.model.as_deref(), cfg.effort.as_deref(), cfg.advisor.as_deref(), &cfg.helper, &plugins)).current_dir(&cfg.folder);
    // A chat whose advisor checks its risky changes doesn't also have the security-guidance plugin review every stop and
    // commit on another model.
    if cfg.advisor.is_some() && !worker {
        for (k, v) in ADVISOR_REVIEW_ENV {
            cmd.env(k, v);
        }
    }
    if let Some(m) = &cfg.subagent_model {
        cmd.env("CLAUDE_CODE_SUBAGENT_MODEL", m);
    }
    if let Some(p) = &cfg.path_env {
        cmd.env("PATH", p);
    }
    cmd
}

impl ClaudeSession {
    pub fn spawn(cfg: &SessionConfig, sink: Sink, on_edit: EditHook) -> Result<ClaudeSession, String> {
        Self::start(command(cfg), &cfg.binary, &cfg.folder, cfg.resume.clone(), sink, on_edit)
    }

    /// Runs `cmd` (a claude command line, already built) as a session: `folder` is where it works and `resume` the session
    /// id it starts from. A chat is started through `spawn`; the side chat (aside.rs) brings its own command line.
    pub fn start(mut cmd: Command, binary: &std::path::Path, folder: &std::path::Path, resume: Option<String>, sink: Sink, on_edit: EditHook) -> Result<ClaudeSession, String> {
        // Its own session, so its own group (the pid is the group id): stopping claude signals the group, and the
        // background tasks it started go with it. A session rather than just a group, so no terminal Lantern was started
        // from is shared: a child that touches it from a background group is stopped there, where here it just fails.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Failed to start {}: {e}", binary.display()))?;
        let pid = child.id().ok_or("claude exited before it started")?;
        let stdin = Arc::new(AsyncMutex::new(child.stdin.take()));
        let stdout = child.stdout.take().ok_or("claude has no stdout pipe")?;
        let stderr = child.stderr.take().ok_or("claude has no stderr pipe")?;

        let session_id = Arc::new(Mutex::new(resume));
        let replies: Replies = Arc::default();
        let stopping = Arc::new(AtomicBool::new(false));
        let tail = Arc::new(Mutex::new(String::new()));
        let (exit_tx, exited) = watch::channel(false);

        let stderr_task = {
            let tail = tail.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut buf = Vec::new();
                while let Some(line) = next_line(&mut reader, &mut buf).await {
                    push_tail(&mut tail.lock().unwrap(), &line);
                }
            })
        };

        {
            let (sid, stopping, tail, replies, stdin) = (session_id.clone(), stopping.clone(), tail.clone(), replies.clone(), stdin.clone());
            let folder = folder.to_path_buf();
            tokio::spawn(async move {
                let mut parser = StreamParser::default();
                let mut reader = BufReader::new(stdout);
                let mut buf = Vec::new();
                // Work running off the stream (workflow agents, background subagents), followed from its transcripts
                // until claude says it ended or this process does.
                let watches = crate::offstream::Watches::default();
                let gone = Arc::new(AtomicBool::new(false));
                while let Some(line) = next_line(&mut reader, &mut buf).await {
                    if deliver(&replies, &line) {
                        continue;
                    }
                    if let Some(reply) = refusal(&line) {
                        // Written apart: waiting for stdin here could hold up the stdout claude is waiting to empty.
                        let stdin = stdin.clone();
                        tokio::spawn(async move { write_line(&stdin, &reply).await });
                    }
                    for ev in parser.parse_line(&line) {
                        match &ev {
                            UiEvent::SessionStarted { session_id, .. } => {
                                *sid.lock().unwrap() = Some(session_id.clone());
                            }
                            UiEvent::EditApplied { path, original, .. } => on_edit(path, original.clone()),
                            UiEvent::Offstream { tool_use_id, dir } => {
                                let session = sid.lock().unwrap().clone();
                                if let Some(source) = offstream_source(tool_use_id, dir.as_deref(), &folder, session.as_deref()) {
                                    watches.start(source, sink.clone(), gone.clone());
                                }
                                continue;
                            }
                            UiEvent::TaskEnded { tool_use_id, .. } => watches.ended(tool_use_id),
                            _ => {}
                        }
                        sink(ev);
                    }
                }
                gone.store(true, Ordering::SeqCst);
                let status = child.wait().await.ok();
                // Gone: no reply is coming, so whoever waits for one hears now rather than at their timeout. The pid
                // is reaped, so the session counts as stopped before anything else waits on it.
                for (_, tx) in replies.lock().unwrap().drain() {
                    let _ = tx.send(Err("Claude stopped before it answered.".into()));
                }
                let _ = exit_tx.send(true);
                let _ = tokio::time::timeout(Duration::from_secs(1), stderr_task).await;
                if !stopping.load(Ordering::SeqCst) {
                    let stderr_tail = tail.lock().unwrap().clone();
                    sink(UiEvent::SessionEnded { code: status.and_then(|s| s.code()), stderr_tail });
                }
            });
        }

        Ok(ClaudeSession { stdin, pid, stopping, exited, session_id, requests: 0, replies })
    }

    pub fn session_id(&self) -> Option<String> {
        self.session_id.lock().unwrap().clone()
    }

    /// The process id of this claude.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn is_running(&self) -> bool {
        !*self.exited.borrow()
    }

    pub async fn send(&mut self, text: &str) -> Result<(), String> {
        let msg = serde_json::json!({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}});
        let mut guard = self.stdin.lock().await;
        let stdin = guard.as_mut().ok_or("The Claude session is not running")?;
        stdin.write_all(format!("{msg}\n").as_bytes()).await.map_err(|e| format!("Could not send to claude: {e}"))?;
        stdin.flush().await.map_err(|e| format!("Could not send to claude: {e}"))
    }

    /// Ends the current turn with stream-json's in-band interrupt (the one the Agent SDK uses): claude answers
    /// with a control_response, ends the turn with an interrupted result, and keeps running — no restart.
    /// Falls back to SIGINT if the request can't be written. Never SIGTERM: that leaves the turn unfinished.
    pub async fn interrupt(&mut self) {
        if self.is_running() && !self.control(serde_json::json!({"subtype": "interrupt"})).await {
            // Claude alone, not its group: the background tasks keep running, as they do after an in-band interrupt.
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

    /// Stops one background task (a run_in_background command, a background agent) by its task id.
    pub async fn stop_task(&mut self, task_id: &str) -> Result<(), String> {
        if self.control(serde_json::json!({"subtype": "stop_task", "task_id": task_id})).await { Ok(()) } else { Err("Claude isn't running.".into()) }
    }

    /// Asks claude what it offers, as the Agent SDK does first thing; the reply lists the slash commands. It also
    /// says the app stops background tasks one by one, so Stop only ends the turn and leaves them running.
    pub async fn initialize(&mut self) {
        self.control(serde_json::json!({"subtype": "initialize", "perTaskStopAffordance": true})).await;
    }

    /// Sends a control request whose reply the caller wants (MCP status, reloading skills…). Returns at once with
    /// where the reply will arrive, so the session isn't held while claude answers; Err in it is claude's error.
    pub async fn request(&mut self, request: serde_json::Value) -> Result<tokio::sync::oneshot::Receiver<Result<serde_json::Value, String>>, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.replies.lock().unwrap().insert(format!("lantern-{}", self.requests + 1), tx);
        if self.control(request).await {
            Ok(rx)
        } else {
            self.replies.lock().unwrap().remove(&format!("lantern-{}", self.requests));
            Err("Claude isn't running.".into())
        }
    }

    /// Writes a stream-json control_request; the parser turns the replies worth showing into events.
    async fn control(&mut self, request: serde_json::Value) -> bool {
        self.requests += 1;
        let msg = serde_json::json!({"type": "control_request", "request_id": format!("lantern-{}", self.requests), "request": request});
        write_line(&self.stdin, &msg.to_string()).await
    }

    /// Shuts the process down on purpose; no SessionEnded event follows. Its group gets the signals, so background
    /// tasks it started stop with it.
    pub async fn stop(mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        // Closing stdin is the polite part. A write stuck on a claude that isn't reading holds the lock, and must not
        // keep the signals below from going out.
        if let Ok(mut stdin) = tokio::time::timeout(Duration::from_secs(1), self.stdin.lock()).await {
            drop(stdin.take());
        }
        if self.is_running() {
            signal_group(self.pid, libc::SIGTERM);
        }
        let timed_out = tokio::time::timeout(Duration::from_secs(5), self.exited.wait_for(|done| *done)).await.is_err();
        if timed_out && self.is_running() {
            signal_group(self.pid, libc::SIGKILL);
            let _ = tokio::time::timeout(Duration::from_secs(1), self.exited.wait_for(|done| *done)).await;
        }
    }
}

/// Signals claude's process group (its pid is the group id, see `process_group` in spawn).
fn signal_group(pid: u32, sig: libc::c_int) {
    unsafe { libc::kill(-(pid as libc::pid_t), sig) };
}

/// Writes one line to claude's stdin. False if it's closed or the write fails.
async fn write_line(stdin: &AsyncMutex<Option<ChildStdin>>, line: &str) -> bool {
    let mut guard = stdin.lock().await;
    match guard.as_mut() {
        Some(s) => s.write_all(format!("{line}\n").as_bytes()).await.is_ok() && s.flush().await.is_ok(),
        None => false,
    }
}

/// How many reads in a row may fail before a pipe counts as closed.
const READ_ERRORS: u32 = 100;

/// The next line of a pipe, or None once it's closed. Bytes that aren't UTF-8 are replaced rather than ending the
/// read: a pipe that stops being drained blocks claude, and the chat would sit "running" forever. A read that fails is
/// tried again, but a pipe that only ever fails is as good as closed, or this would never end.
async fn next_line<R: AsyncBufRead + Unpin>(reader: &mut R, buf: &mut Vec<u8>) -> Option<String> {
    let mut failed = 0;
    loop {
        buf.clear();
        match reader.read_until(b'\n', buf).await {
            Ok(0) => return None,
            Ok(_) => return Some(String::from_utf8_lossy(buf).trim_end_matches(['\n', '\r']).to_string()),
            Err(_) if failed >= READ_ERRORS => return None,
            Err(_) => {
                failed += 1;
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
    }
}

/// The error reply to an inbound control_request Lantern doesn't handle: claude waits for a reply to each one, so
/// silence would hang it. Permissions don't come this way (the helper answers them), so `can_use_tool` is left alone.
fn refusal(line: &str) -> Option<String> {
    if !line.contains("\"control_request\"") {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let subtype = v["request"]["subtype"].as_str()?;
    if v["type"] != "control_request" || subtype == "can_use_tool" {
        return None;
    }
    Some(serde_json::json!({"type": "control_response", "response": {"subtype": "error", "request_id": v["request_id"], "error": format!("Lantern doesn't handle {subtype} requests.")}}).to_string())
}

/// Where off-stream work's transcripts are: a workflow's folder as claude gave it, or the session's subagents folder
/// (`<projects>/<folder>/<session>/subagents`) for a background subagent.
fn offstream_source(tool_use_id: &str, dir: Option<&str>, folder: &std::path::Path, session: Option<&str>) -> Option<crate::offstream::Source> {
    if let Some(d) = dir {
        return Some(crate::offstream::Source::Workflow { tool_use_id: tool_use_id.into(), dir: d.into() });
    }
    let projects = crate::skills::config_dir()?.join("projects");
    let transcript = crate::history::transcript_path(&projects, folder, session?).ok()?;
    Some(crate::offstream::Source::Agent { tool_use_id: tool_use_id.into(), subagents: transcript.with_extension("").join("subagents") })
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
    use crate::args::{HelperConfig, Mode};
    use crate::provider::ProviderId;
    use crate::session::Session;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
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
            provider: ProviderId::Claude,
            binary: claude,
            folder: folder.to_path_buf(),
            mode: Mode::Ask,
            auto_approve: false,
            resume: resume.map(String::from),
            model: None,
            effort: None,
            advisor: None,
            subagent_model: None,
            helper: HelperConfig { exe: "/usr/bin/true".into(), socket: "/tmp/none.sock".into(), role: Default::default(), providers: vec![] },
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

    /// What claude is started as, with nothing run: its path, arguments, environment (only what Lantern sets) and folder.
    #[test]
    fn claude_is_started_with_the_configured_arguments_environment_and_folder() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = config("/bin/claude".into(), dir.path(), Some("sess-1"));
        cfg.model = Some("opus".into());
        cfg.effort = Some("high".into());
        cfg.advisor = Some("fable".into());
        cfg.subagent_model = Some("haiku".into());
        cfg.path_env = Some("/custom/bin:/usr/bin".into());
        let cmd = command(&cfg);
        let cmd = cmd.as_std();
        assert_eq!(cmd.get_program(), "/bin/claude");
        let expected = launch_args(cfg.mode, cfg.auto_approve, Some("sess-1"), Some("opus"), Some("high"), Some("fable"), &cfg.helper, &[]);
        assert_eq!(&expected[expected.len() - 2..], ["--advisor", "fable"]);
        assert_eq!(cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>(), expected);
        let env: Vec<(String, Option<String>)> = cmd.get_envs().map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned()))).collect();
        let set = |k: &str, v: &str| (k.to_string(), Some(v.to_string()));
        // With an advisor, the security-guidance plugin's own reviews are off: the advisor does that job.
        assert_eq!(env, vec![set("CLAUDE_CODE_SUBAGENT_MODEL", "haiku"), set("ENABLE_COMMIT_REVIEW", "0"), set("ENABLE_STOP_REVIEW", "0"), set("PATH", "/custom/bin:/usr/bin")]);
        assert_eq!(cmd.get_current_dir(), Some(dir.path()));

        // A worker: no advisor whatever the harness says, so the plugin (which it doesn't load) isn't told anything.
        let mut worker = cfg.clone();
        worker.helper.role = crate::args::Role::Worker { name: "w".into(), read_only: false };
        let args: Vec<String> = command(&worker).as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(!args.iter().any(|a| a == "--advisor") && args.iter().any(|a| a == "--strict-mcp-config"), "{args:?}");
        assert!(!command(&worker).as_std().get_envs().any(|(k, _)| k == "ENABLE_STOP_REVIEW"));

        // Nothing chosen: no environment of its own, no advisor.
        let bare = command(&config("/bin/claude".into(), dir.path(), None));
        assert_eq!(bare.as_std().get_envs().count(), 0);
        assert!(!bare.as_std().get_args().any(|a| a == "--advisor" || a == "--resume"));
    }

    #[tokio::test]
    async fn a_request_gets_its_own_reply_and_an_error_comes_back_as_one() {
        let dir = tempfile::tempdir().unwrap();
        // Answers each control request: mcp_status with a server, anything else with an error.
        let fake = script(
            dir.path(),
            r#"while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
  case "$line" in
    *mcp_status*) printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"mcpServers":[{"name":"linear","status":"connected"}]}}}\n' "$id" ;;
    *) printf '{"type":"control_response","response":{"subtype":"error","request_id":"%s","error":"nope"}}\n' "$id" ;;
  esac
done"#,
        );
        let (sink, mut rx) = channel_sink();
        let mut s = Session::spawn(&config(fake, dir.path(), None), sink, no_edits()).unwrap();
        let status = s.request(serde_json::json!({"subtype": "mcp_status"})).await.unwrap();
        let reply = tokio::time::timeout(Duration::from_secs(10), status).await.unwrap().unwrap().unwrap();
        assert_eq!(reply["mcpServers"][0]["name"], "linear");
        let toggle = s.request(serde_json::json!({"subtype": "mcp_toggle", "serverName": "linear", "enabled": false})).await.unwrap();
        assert_eq!(tokio::time::timeout(Duration::from_secs(10), toggle).await.unwrap().unwrap(), Err("nope".to_string()));
        // Replies someone waited for aren't shown as events.
        assert!(rx.try_recv().is_err());
        s.stop().await;
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
            &format!("printf '%s\\n' \"$@\" > {d}/args.txt\nwhile IFS= read -r line; do\n  printf '%s\\n' \"$line\" >> {d}/stdin.txt\n  cat '{FIXTURE}'\ndone"),
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
    async fn the_harness_reaches_claude_as_its_advisor_flag_and_subagent_model() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().display();
        let fake = script(dir.path(), &format!("printf '%s|%s' \"$*\" \"$CLAUDE_CODE_SUBAGENT_MODEL\" > {d}/seen.txt\ncat > /dev/null"));
        let (sink, _rx) = channel_sink();
        let mut cfg = config(fake, dir.path(), None);
        cfg.advisor = Some("opus".into());
        cfg.subagent_model = Some("haiku".into());
        let s = Session::spawn(&cfg, sink, no_edits()).unwrap();
        let seen = wait_for_file(&dir.path().join("seen.txt")).await;
        let (args, sub) = seen.split_once('|').unwrap();
        assert!(args.ends_with("--advisor opus"), "{args}");
        assert_eq!(sub, "haiku");
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

    #[tokio::test]
    async fn a_line_that_is_not_utf8_does_not_stop_the_stream() {
        let dir = tempfile::tempdir().unwrap();
        let fake = script(
            dir.path(),
            r#"printf '\377\376 junk\n'
printf '%s\n' '{"type":"system","subtype":"init","session_id":"after-junk","model":"m","cwd":"/p"}'
cat > /dev/null"#,
        );
        let (sink, mut rx) = channel_sink();
        let _s = Session::spawn(&config(fake, dir.path(), None), sink, no_edits()).unwrap();
        match next_matching(&mut rx, |e| matches!(e, UiEvent::SessionStarted { .. })).await {
            UiEvent::SessionStarted { session_id, .. } => assert_eq!(session_id, "after-junk"),
            _ => unreachable!(),
        }
    }

    /// A pipe whose every read fails.
    struct Failing;
    impl tokio::io::AsyncRead for Failing {
        fn poll_read(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>, _: &mut tokio::io::ReadBuf<'_>) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(Err(std::io::Error::other("broken pipe")))
        }
    }

    #[tokio::test]
    async fn a_pipe_that_only_fails_ends_the_stream_instead_of_retrying_forever() {
        let mut reader = BufReader::new(Failing);
        let mut buf = Vec::new();
        let line = tokio::time::timeout(Duration::from_secs(10), next_line(&mut reader, &mut buf)).await.expect("retried forever");
        assert_eq!(line, None);
    }

    #[tokio::test]
    async fn a_request_claude_never_answers_hears_that_it_stopped() {
        let dir = tempfile::tempdir().unwrap();
        // Takes one line (the request), then exits without a reply.
        let fake = script(dir.path(), "read line");
        let (sink, _rx) = channel_sink();
        let mut s = Session::spawn(&config(fake, dir.path(), None), sink, no_edits()).unwrap();
        let reply = s.request(serde_json::json!({"subtype": "mcp_status"})).await.unwrap();
        let answer = tokio::time::timeout(Duration::from_secs(10), reply).await.expect("waited out the timeout");
        assert!(answer.unwrap().is_err());
    }

    #[tokio::test]
    async fn an_unhandled_control_request_from_claude_gets_an_error_reply() {
        let dir = tempfile::tempdir().unwrap();
        let body = r#"printf '%s\n' '{"type":"control_request","request_id":"c9","request":{"subtype":"hook_callback"}}'
while IFS= read -r line; do printf '%s\n' "$line" >> DIR/stdin.txt; done"#
            .replace("DIR", &dir.path().display().to_string());
        let fake = script(dir.path(), &body);
        let (sink, _rx) = channel_sink();
        let s = Session::spawn(&config(fake, dir.path(), None), sink, no_edits()).unwrap();
        let sent = wait_for_file(&dir.path().join("stdin.txt")).await;
        let reply: serde_json::Value = serde_json::from_str(sent.trim()).unwrap();
        assert_eq!(reply["type"], "control_response");
        assert_eq!(reply["response"]["subtype"], "error");
        assert_eq!(reply["response"]["request_id"], "c9");
        s.stop().await;
    }

    #[tokio::test]
    async fn stopping_claude_stops_the_background_tasks_it_started() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().display();
        // Starts a background task, records its pid, then runs until it's signalled.
        let fake = script(dir.path(), &format!("sleep 30 &\necho $! > {d}/child.txt\nwhile true; do sleep 1; done"));
        let (sink, _rx) = channel_sink();
        let s = Session::spawn(&config(fake, dir.path(), None), sink, no_edits()).unwrap();
        let child: libc::pid_t = wait_for_file(&dir.path().join("child.txt")).await.trim().parse().unwrap();
        s.stop().await;
        let gone = tokio::time::timeout(Duration::from_secs(5), async {
            while unsafe { libc::kill(child, 0) } == 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        assert!(gone.is_ok(), "the background task outlived claude");
    }
}
