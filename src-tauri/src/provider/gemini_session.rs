//! A running `gemini --acp`: the Agent Client Protocol, JSON-RPC over stdio, one JSON object per line. Requests Lantern makes
//! get their reply by id; the agent's `session/update` notifications become `UiEvent`s (gemini_events); its
//! `session/request_permission` requests become the same Allow/Deny cards Claude's do, answered in the JSON-RPC reply.
//!
//! Signing in is the user's own (`gemini` in a terminal, or an API key in their environment). Lantern never calls the agent's
//! `authenticate`, never reads or sends a credential, and says so when a session can't be opened for want of one. It also
//! advertises no file or terminal service, so Gemini reads, writes and runs things itself, in the chat's folder, and asks
//! before it does what the chat's mode says to ask about.

use super::claude_session::{next_line, push_tail, signal_group, write_line, STDERR_TAIL_BYTES};
use super::gemini::{version_of, version_supported, MIN_VERSION};
use super::gemini_events::{model_options, sign_in_text, signed_out, GeminiMapper};
use crate::args::{Mode, Role};
use crate::session::{EditHook, SessionConfig};
use crate::ui_event::{Sink, UiEvent};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::BufReader;
use tokio::process::{ChildStdin, Command};
use tokio::sync::{oneshot, watch, Mutex as AsyncMutex};

const _: usize = STDERR_TAIL_BYTES;

/// How long a startup step may take: `launch` waits for them while it holds the chat's session lock.
const STEP_WAIT: Duration = Duration::from_secs(20);
/// A session opens its tools and servers before it answers (`session/new`, `session/load`): more than a step.
const OPEN_WAIT: Duration = Duration::from_secs(60);
/// A turn has no time limit but the user's: it runs until Gemini has answered or is stopped.
const TURN_WAIT: Duration = Duration::from_secs(24 * 3600);
/// How long `send` waits for a session that is still starting.
const READY_WAIT: Duration = Duration::from_secs(90);
/// How long a stopped session gets to finish after its input is closed, then after SIGTERM, before it is killed.
const EOF_GRACE: Duration = if cfg!(test) { Duration::from_millis(400) } else { Duration::from_secs(3) };
const TERM_GRACE: Duration = if cfg!(test) { Duration::from_millis(600) } else { Duration::from_secs(5) };

/// The protocol version Lantern speaks (ACP's first, which is the one Gemini CLI answers with).
const PROTOCOL_VERSION: u64 = 1;

/// What Gemini's approval modes are called, by the ids it takes (`session/set_mode`). Lantern's Ask is "edits apply in the
/// folder, the rest asks", which is Gemini's `autoEdit`; there is no mode here that maps to `yolo`, which approves everything,
/// whatever the user's own settings say: the mode is set at the start of every session and fails the start if it can't be.
pub const ASK_MODE: &str = "autoEdit";
const FALLBACK_MODE: &str = "default";
/// Gemini's read-only mode, for an agent that shares its Lead's folder.
const READ_ONLY_MODE: &str = "plan";

/// The approval mode a chat on `mode` runs in, among those the session offers. Ask and Step by step are the only ones that
/// arrive (Gemini has no Auto, see Capabilities), and an Auto that does is Ask.
pub fn approval_mode(_mode: Mode, read_only: bool, offered: &[String]) -> Result<&'static str, String> {
    let has = |id: &str| offered.iter().any(|m| m == id);
    let wanted = if read_only { [READ_ONLY_MODE, FALLBACK_MODE] } else { [ASK_MODE, FALLBACK_MODE] };
    wanted.into_iter().find(|id| has(id)).ok_or_else(|| "This Gemini offers none of the approval modes Lantern can run a chat in. Update it (`npm i -g @google/gemini-cli`), then restart the chat.".to_string())
}

type RpcResult = Result<Value, (i64, String)>;
type Reply = oneshot::Sender<RpcResult>;

#[derive(Clone, Debug, PartialEq)]
enum Ready {
    Starting,
    Yes,
    Failed(String),
}

struct Pending {
    /// The JSON-RPC id of the agent's request, to answer it by.
    rpc_id: Value,
    /// The option that allows this one action, and the one that refuses it.
    allow: String,
    reject: Option<String>,
}

#[derive(Default)]
struct State {
    next_id: i64,
    replies: HashMap<i64, Reply>,
    session_id: Option<String>,
    /// A turn is running (or being started): a message sent now waits for it.
    busy: bool,
    queued: VecDeque<String>,
    /// The model the user chose, for the next turns on; None is Gemini's own default.
    model: Option<String>,
    /// Gemini had no sign-in to use when a session was opened (checked again when a message is sent).
    signed_out: bool,
    turn_started: Option<Instant>,
    pending: HashMap<String, Pending>,
    /// What `initialize` said Gemini's version is, for the session's start event.
    version: Option<String>,
}

/// Cards are numbered across every session of the app, not within one: a card left on screen from a session that was
/// restarted can never be answered as the new session's card with the same number.
static CARDS: AtomicU64 = AtomicU64::new(0);

/// What every request and turn needs: the pipes, the shared state, and where events go.
#[derive(Clone)]
struct Ctx {
    stdin: Arc<AsyncMutex<Option<ChildStdin>>>,
    state: Arc<Mutex<State>>,
    mapper: Arc<Mutex<GeminiMapper>>,
    sink: Sink,
    on_edit: EditHook,
    cwd: String,
    mode: Mode,
    /// A read-only agent: Gemini's read-only mode, and nothing it asks for is allowed.
    read_only: bool,
    /// The session was stopped on purpose: nothing it says after that is shown.
    stopping: Arc<AtomicBool>,
}

impl Ctx {
    async fn request(&self, method: &str, params: Value, wait: Duration) -> RpcResult {
        let (tx, rx) = oneshot::channel();
        let id = {
            let mut s = self.state.lock().unwrap();
            s.next_id += 1;
            let id = s.next_id;
            s.replies.insert(id, tx);
            id
        };
        if !write_line(&self.stdin, &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string()).await {
            self.state.lock().unwrap().replies.remove(&id);
            return Err((-1, "Gemini isn't running.".into()));
        }
        match tokio::time::timeout(wait, rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err((-1, "Gemini stopped before it answered.".into())),
            Err(_) => {
                self.state.lock().unwrap().replies.remove(&id);
                Err((-1, format!("Gemini didn't answer {method} in time.")))
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) {
        write_line(&self.stdin, &json!({"jsonrpc": "2.0", "method": method, "params": params}).to_string()).await;
    }

    async fn answer(&self, rpc_id: &Value, result: Value) {
        write_line(&self.stdin, &json!({"jsonrpc": "2.0", "id": rpc_id, "result": result}).to_string()).await;
    }

    async fn refuse(&self, rpc_id: &Value, message: String) {
        write_line(&self.stdin, &json!({"jsonrpc": "2.0", "id": rpc_id, "error": {"code": -32601, "message": message}}).to_string()).await;
    }

    /// Opens the conversation: the one `resume` names, else a new one, and puts it in the approval mode this chat runs in and
    /// on the model it chose. Returns the session's id, or None when Gemini has no sign-in to open one with.
    async fn open_session(&self, resume: Option<&str>, sink: &Sink) -> Result<Option<String>, String> {
        let base = json!({"cwd": self.cwd, "mcpServers": []});
        let mut opened = None;
        if let Some(id) = resume {
            let mut p = base.clone();
            p["sessionId"] = id.into();
            match self.request("session/load", p, OPEN_WAIT).await {
                Ok(r) => opened = Some((id.to_string(), r)),
                Err((code, why)) if signed_out(code, &why) => return Ok(self.not_signed_in()),
                // A conversation that never had a message isn't on disk to load (a chat restarted before its first turn).
                Err((_, why)) if looks_missing(&why) => {}
                Err((_, why)) => return Err(format!("Couldn't resume the Gemini conversation: {why}")),
            }
        }
        let (id, reply) = match opened {
            Some(o) => o,
            None => match self.request("session/new", base, OPEN_WAIT).await {
                Ok(r) => (r["sessionId"].as_str().filter(|s| !s.is_empty()).ok_or("Gemini opened a conversation without an id.")?.to_string(), r),
                Err((code, why)) if signed_out(code, &why) => return Ok(self.not_signed_in()),
                Err((_, why)) => return Err(format!("Couldn't start a Gemini conversation: {why}")),
            },
        };
        self.state.lock().unwrap().signed_out = false;

        // The mode first, and the start fails if it can't be set: a session left in whatever mode the user's own settings
        // name could be one that approves everything.
        let offered: Vec<String> = reply["modes"]["availableModes"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str().map(String::from)).collect();
        let mode = approval_mode(self.mode, self.read_only, &offered)?;
        if reply["modes"]["currentModeId"].as_str() != Some(mode) {
            self.request("session/set_mode", json!({"sessionId": id, "modeId": mode}), STEP_WAIT).await.map_err(|(_, why)| format!("Couldn't set Gemini's approval mode to {mode}: {why}"))?;
        }
        let models = model_options(&reply["models"]["availableModels"]);
        if !models.is_empty() {
            sink(UiEvent::Models { models });
        }
        let chosen = self.state.lock().unwrap().model.clone();
        let mut model = reply["models"]["currentModelId"].as_str().unwrap_or("").to_string();
        if let Some(m) = chosen.filter(|m| *m != model) {
            self.request("session/set_model", json!({"sessionId": id, "modelId": m}), STEP_WAIT).await.map_err(|(_, why)| format!("Couldn't switch Gemini to {m}: {why}"))?;
            model = m;
        }
        let version = {
            let mut s = self.state.lock().unwrap();
            s.session_id = Some(id.clone());
            s.version.clone().unwrap_or_default()
        };
        sink(UiEvent::SessionStarted { session_id: id.clone(), model, cwd: self.cwd.clone(), permission_mode: mode.to_string(), claude_version: format!("gemini {version}").trim().to_string() });
        Ok(Some(id))
    }

    /// Gemini has no sign-in: remembered, so a message says so (and how to fix it) instead of failing a turn.
    fn not_signed_in(&self) -> Option<String> {
        self.state.lock().unwrap().signed_out = true;
        None
    }

    /// Starts a turn with `text`; the turn runs on its own, and its end is shown when its reply comes (see `run_turn`).
    fn begin_turn(&self, text: &str) -> Result<(), String> {
        let session = {
            let mut s = self.state.lock().unwrap();
            s.busy = true;
            s.turn_started = Some(Instant::now());
            s.session_id.clone()
        };
        let Some(session) = session else {
            self.state.lock().unwrap().busy = false;
            return Err("The Gemini conversation isn't open.".into());
        };
        let (ctx, text) = (self.clone(), text.to_string());
        tokio::spawn(async move { ctx.run_turn(session, text).await });
        Ok(())
    }

    async fn run_turn(&self, session: String, text: String) {
        let reply = self.request("session/prompt", json!({"sessionId": session, "prompt": [{"type": "text", "text": text}]}), TURN_WAIT).await;
        // Over, however it ended: no card can be answered, and what was said while it ran is already shown.
        let (stale, queued, started) = {
            let mut s = self.state.lock().unwrap();
            s.busy = false;
            (s.pending.drain().map(|(id, _)| id).collect::<Vec<_>>(), s.queued.pop_front(), s.turn_started.take())
        };
        if self.stopping.load(Ordering::SeqCst) {
            return;
        }
        for request_id in stale {
            (self.sink)(UiEvent::PermissionWithdrawn { request_id });
        }
        let ms = started.map(|t| t.elapsed().as_millis() as u64);
        let mapped = {
            let mut mapper = self.mapper.lock().unwrap();
            match &reply {
                Ok(v) => mapper.turn_done(Ok(v), ms),
                Err((code, why)) => mapper.turn_done(Err((*code, why.as_str())), ms),
            }
        };
        for ev in mapped.events {
            (self.sink)(ev);
        }
        // A turn that failed for want of a sign-in is told again, with the session's note, on the next message.
        if let Err((code, why)) = &reply {
            if signed_out(*code, why) {
                self.state.lock().unwrap().signed_out = true;
            }
        }
        // The message sent while that turn ran, after its end has been shown.
        if let Some(next) = queued {
            if let Err(why) = self.begin_turn(&next) {
                (self.sink)(UiEvent::TurnDone { is_error: true, result: Some(why), cost_usd: None, tokens: None, session_cost_usd: None, session_tokens: 0, duration_ms: None, auth_hint: false, denied: 0, context_window: None });
            }
        }
    }
}

/// Whether a failed `session/load` says there is no such conversation (as opposed to one that failed to open).
fn looks_missing(why: &str) -> bool {
    let w = why.to_lowercase();
    w.contains("not found") || w.contains("no session") || w.contains("no conversation") || w.contains("does not exist") || w.contains("no such")
}

pub struct GeminiSession {
    ctx: Ctx,
    pid: u32,
    stopping: Arc<AtomicBool>,
    exited: watch::Receiver<bool>,
    ready: watch::Receiver<Ready>,
}

/// The gemini command for `cfg`: program, arguments, environment and folder, before it is started. Gemini is a Node script
/// (`#!/usr/bin/env node`): its own folder comes first on the PATH, so the `node` it was installed with is the one that runs
/// it, not whichever a login shell finds first.
fn command(cfg: &SessionConfig) -> Command {
    let mut cmd = Command::new(&cfg.binary);
    cmd.arg("--acp").current_dir(&cfg.folder);
    let inherited = cfg.path_env.clone().or_else(|| std::env::var("PATH").ok()).unwrap_or_default();
    let path = match cfg.binary.canonicalize().ok().or_else(|| Some(cfg.binary.clone())).and_then(|b| b.parent().map(|p| p.display().to_string())) {
        Some(dir) => format!("{dir}:{inherited}"),
        None => inherited,
    };
    cmd.env("PATH", path);
    // Without this it starts a second copy of itself as a child (to raise Node's memory limit), which is another process to
    // stop and another pile of memory.
    cmd.env("GEMINI_CLI_NO_RELAUNCH", "true");
    cmd
}

impl GeminiSession {
    pub fn spawn(cfg: &SessionConfig, sink: Sink, on_edit: EditHook) -> Result<GeminiSession, String> {
        if cfg.helper.role == Role::Main {
            return Err("A main agent can't run on Gemini yet: it has no way to call the orchestra's tools. Start the main agent on Claude; its workers can run on Gemini.".into());
        }
        let mut cmd = command(cfg);
        // Its own session and group, as Claude's is: stopping it signals the group, so a command it is running goes too.
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
            .map_err(|e| format!("Failed to start {}: {e}", cfg.binary.display()))?;
        let pid = child.id().ok_or("gemini exited before it started")?;
        let stdin = Arc::new(AsyncMutex::new(child.stdin.take()));
        let stdout = child.stdout.take().ok_or("gemini has no stdout pipe")?;
        let stderr = child.stderr.take().ok_or("gemini has no stderr pipe")?;

        let state = Arc::new(Mutex::new(State { model: cfg.model.clone(), ..State::default() }));
        let stopping = Arc::new(AtomicBool::new(false));
        let cwd = cfg.folder.display().to_string();
        let ctx = Ctx {
            stdin,
            state: state.clone(),
            mapper: Arc::new(Mutex::new(GeminiMapper::new(&cfg.folder))),
            sink: sink.clone(),
            on_edit,
            cwd,
            mode: cfg.mode,
            read_only: matches!(cfg.helper.role, Role::Worker { read_only: true, .. }),
            stopping: stopping.clone(),
        };
        let tail = Arc::new(Mutex::new(String::new()));
        let (exit_tx, exited) = watch::channel(false);
        let (ready_tx, ready) = watch::channel(Ready::Starting);

        let stderr_task = {
            let tail = tail.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut buf = Vec::new();
                while let Some(line) = next_line(&mut reader, &mut buf).await {
                    push_tail(&mut tail.lock().unwrap(), &strip_ansi(&line));
                }
            })
        };

        {
            let (ctx, sink, stopping, tail) = (ctx.clone(), sink.clone(), stopping.clone(), tail.clone());
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout);
                let mut buf = Vec::new();
                while let Some(line) = next_line(&mut reader, &mut buf).await {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let Ok(v) = serde_json::from_str::<Value>(&line) else {
                        sink(UiEvent::ParseError { line: crate::stream_parser::truncate(&line, 500) });
                        continue;
                    };
                    match (v["method"].as_str(), v.get("id").filter(|id| !id.is_null())) {
                        (Some(method), Some(id)) => server_request(&ctx, method, id, &v["params"]),
                        (Some(method), None) => notification(&ctx, method, &v["params"]),
                        (None, Some(id)) => deliver(&ctx, id, &v),
                        (None, None) => {}
                    }
                }
                let status = child.wait().await.ok();
                // Gone: no reply is coming, and no card can be answered.
                let (replies, pending) = {
                    let mut s = ctx.state.lock().unwrap();
                    s.busy = false;
                    (s.replies.drain().collect::<Vec<_>>(), s.pending.drain().map(|(id, _)| id).collect::<Vec<_>>())
                };
                for (_, tx) in replies {
                    let _ = tx.send(Err((-1, "Gemini stopped before it answered.".into())));
                }
                for request_id in pending {
                    sink(UiEvent::PermissionWithdrawn { request_id });
                }
                let _ = exit_tx.send(true);
                let _ = tokio::time::timeout(Duration::from_secs(1), stderr_task).await;
                if !stopping.swap(true, Ordering::SeqCst) {
                    let stderr_tail = tail.lock().unwrap().clone();
                    sink(UiEvent::SessionEnded { code: status.and_then(|s| s.code()), stderr_tail });
                }
            });
        }

        // The handshake and the conversation's start run on their own: `initialize` (the session's) and `send` wait for them.
        {
            let (ctx, sink, stopping, tail) = (ctx.clone(), sink.clone(), stopping.clone(), tail.clone());
            let resume = cfg.resume.clone();
            tokio::spawn(async move {
                match startup(&ctx, &sink, resume).await {
                    Ok(()) => {
                        let _ = ready_tx.send(Ready::Yes);
                    }
                    Err(why) => {
                        let _ = ready_tx.send(Ready::Failed(why.clone()));
                        // Said once, here: the process is stopped on purpose, so its exit won't say it again.
                        if !stopping.swap(true, Ordering::SeqCst) {
                            let stderr_tail = format!("{why}\n{}", tail.lock().unwrap());
                            sink(UiEvent::SessionEnded { code: None, stderr_tail: stderr_tail.trim().to_string() });
                            ctx.stdin.lock().await.take();
                            signal_group(pid, libc::SIGTERM);
                        }
                    }
                }
            });
        }

        Ok(GeminiSession { ctx, pid, stopping, exited, ready })
    }

    /// The conversation's id, which restarting the chat resumes.
    pub fn session_id(&self) -> Option<String> {
        self.ctx.state.lock().unwrap().session_id.clone()
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn is_running(&self) -> bool {
        !*self.exited.borrow()
    }

    /// Waits for the handshake and the conversation's start, so the first message has somewhere to go.
    pub async fn initialize(&mut self) {
        let _ = self.wait_ready().await;
    }

    async fn wait_ready(&self) -> Result<(), String> {
        let mut ready = self.ready.clone();
        let outcome = tokio::time::timeout(READY_WAIT, ready.wait_for(|r| *r != Ready::Starting)).await.map(|r| r.map(|state| state.clone()));
        match outcome {
            Ok(Ok(Ready::Failed(why))) => Err(why),
            Ok(Ok(_)) => Ok(()),
            Ok(Err(_)) => Err("Gemini stopped before it was ready.".into()),
            Err(_) => Err("Gemini didn't get ready in time.".into()),
        }
    }

    /// A message from the user: a new turn, or after the running one when there is one (Claude queues the same way).
    pub async fn send(&mut self, text: &str) -> Result<(), String> {
        self.wait_ready().await?;
        // No conversation yet because there was no sign-in: try again, as the user may have signed in since.
        if self.ctx.state.lock().unwrap().session_id.is_none() {
            let sink = self.ctx.sink.clone();
            if self.ctx.open_session(None, &sink).await?.is_none() {
                (self.ctx.sink)(UiEvent::TurnDone { is_error: true, result: Some(sign_in_text("")), cost_usd: None, tokens: None, session_cost_usd: None, session_tokens: 0, duration_ms: None, auth_hint: true, denied: 0, context_window: None });
                return Ok(());
            }
        }
        {
            let mut s = self.ctx.state.lock().unwrap();
            if s.busy {
                s.queued.push_back(text.to_string());
                return Ok(());
            }
        }
        self.ctx.begin_turn(text)
    }

    /// Ends the running turn (it finishes as interrupted) and answers the cards waiting on it; the process keeps running.
    pub async fn interrupt(&mut self) {
        // The turn can't go on while it waits for an answer, and the user has just said stop.
        self.settle_pending();
        let session = {
            let mut s = self.ctx.state.lock().unwrap();
            s.queued.clear();
            if !s.busy {
                return;
            }
            s.session_id.clone()
        };
        if let Some(session) = session {
            self.ctx.notify("session/cancel", json!({"sessionId": session})).await;
        }
    }

    /// The model from the next turn on; None goes back to Gemini's own.
    pub async fn set_model(&mut self, model: Option<&str>) -> Result<(), String> {
        let session = {
            let mut s = self.ctx.state.lock().unwrap();
            s.model = model.map(String::from);
            s.session_id.clone()
        };
        // Told to the running session at once; one that isn't open yet takes it when it is.
        if let (Some(session), Some(model)) = (session, model) {
            self.ctx.request("session/set_model", json!({"sessionId": session, "modelId": model}), STEP_WAIT).await.map_err(|(_, why)| format!("Couldn't switch Gemini to {model}: {why}"))?;
        }
        Ok(())
    }

    /// The user's answer to a card. False when there is no such card (it was answered, or it isn't Gemini's).
    pub async fn respond_permission(&mut self, request_id: &str, allow: bool) -> bool {
        let Some(p) = self.ctx.state.lock().unwrap().pending.remove(request_id) else { return false };
        self.ctx.answer(&p.rpc_id, outcome(&p, allow)).await;
        true
    }

    /// Answers every waiting card as cancelled and takes them off the window.
    fn settle_pending(&self) {
        let pending: Vec<(String, Pending)> = self.ctx.state.lock().unwrap().pending.drain().collect();
        for (request_id, p) in pending {
            let ctx = self.ctx.clone();
            tokio::spawn(async move { ctx.answer(&p.rpc_id, cancelled()).await });
            (self.ctx.sink)(UiEvent::PermissionWithdrawn { request_id });
        }
    }

    /// Shuts the process down on purpose; no SessionEnded event follows. Closing its input is how the agent is asked to
    /// finish; its group is signalled after that, so a command it was running stops too.
    pub async fn stop(self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.settle_pending();
        let mut exited = self.exited.clone();
        if let Ok(mut stdin) = tokio::time::timeout(Duration::from_secs(1), self.ctx.stdin.lock()).await {
            drop(stdin.take());
        }
        if tokio::time::timeout(EOF_GRACE, exited.wait_for(|done| *done)).await.is_ok() {
            return;
        }
        signal_group(self.pid, libc::SIGTERM);
        if tokio::time::timeout(TERM_GRACE, exited.wait_for(|done| *done)).await.is_err() {
            signal_group(self.pid, libc::SIGKILL);
            let _ = tokio::time::timeout(Duration::from_secs(1), exited.wait_for(|done| *done)).await;
        }
    }
}

/// The JSON-RPC result that answers a permission request: `allow` chooses the option for this one action; otherwise the
/// refusing option, or (when it offers none) the cancelled outcome, which refuses the same way.
fn outcome(p: &Pending, allow: bool) -> Value {
    match (allow, &p.reject) {
        (true, _) => json!({"outcome": {"outcome": "selected", "optionId": p.allow}}),
        (false, Some(reject)) => json!({"outcome": {"outcome": "selected", "optionId": reject}}),
        (false, None) => cancelled(),
    }
}

fn cancelled() -> Value {
    json!({"outcome": {"outcome": "cancelled"}})
}

/// The handshake, then the conversation: a new one, or the one `resume` names.
async fn startup(ctx: &Ctx, sink: &Sink, resume: Option<String>) -> Result<(), String> {
    let init = ctx
        .request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                // No file or terminal service: Gemini reads, writes and runs things itself, in the chat's folder.
                "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false},
                "clientInfo": {"name": "lantern", "title": "Lantern", "version": env!("CARGO_PKG_VERSION")},
            }),
            OPEN_WAIT,
        )
        .await
        .map_err(|(_, e)| format!("Gemini's ACP agent didn't start ({e}). Is this a current Gemini CLI? Update it (`npm i -g @google/gemini-cli`), then restart the chat."))?;
    let version = init["agentInfo"]["version"].as_str().map(String::from);
    if let Some(v) = version.as_deref().and_then(version_of) {
        if !version_supported(v) {
            let (a, b, c) = MIN_VERSION;
            return Err(format!("This Gemini ({}.{}.{}) is older than the {a}.{b}.{c} Lantern needs. Update it (`npm i -g @google/gemini-cli`), then restart the chat.", v.0, v.1, v.2));
        }
    }
    ctx.state.lock().unwrap().version = version;
    ctx.open_session(resume.as_deref(), sink).await?;
    Ok(())
}

/// A reply to one of our requests.
fn deliver(ctx: &Ctx, id: &Value, v: &Value) {
    let Some(tx) = id.as_i64().and_then(|id| ctx.state.lock().unwrap().replies.remove(&id)) else { return };
    let reply = match v.get("error") {
        Some(e) => Err((e["code"].as_i64().unwrap_or(-1), e["message"].as_str().unwrap_or("Gemini refused the request.").to_string())),
        None => Ok(v["result"].clone()),
    };
    let _ = tx.send(reply);
}

/// A request from the agent. Permission requests become cards; one that can't be shown as it is is declined at once;
/// anything else is refused, because the agent waits for a reply to each (Lantern offers it no file or terminal service).
fn server_request(ctx: &Ctx, method: &str, id: &Value, params: &Value) {
    if method != "session/request_permission" {
        refuse_later(ctx, id, format!("Lantern doesn't handle {method} requests."));
        return;
    }
    // The agent's ids are its own to keep apart; one that is already waiting would have two cards answered by one reply, so
    // the card waiting is taken off and the id is answered as refused.
    let twins: Vec<String> = {
        let mut s = ctx.state.lock().unwrap();
        let keys = s.pending.iter().filter(|(_, p)| p.rpc_id == *id).map(|(k, _)| k.clone()).collect::<Vec<_>>();
        keys.iter().for_each(|k| drop(s.pending.remove(k)));
        keys
    };
    if !twins.is_empty() {
        twins.into_iter().for_each(|request_id| (ctx.sink)(UiEvent::PermissionWithdrawn { request_id }));
        declined_step(ctx, "the request reused the number of one still waiting");
        answer_later(ctx, id, cancelled());
        return;
    }
    // Asked about this conversation, and no other.
    let ours = ctx.state.lock().unwrap().session_id.clone();
    let request = if params["sessionId"].as_str().is_none() || params["sessionId"].as_str() != ours.as_deref() {
        Err("it is not about this conversation".to_string())
    // A read-only agent shares its Lead's folder: nothing it asks for is allowed, so the user isn't asked (one Allow would
    // let it write there).
    } else if ctx.read_only {
        Err("this agent is read-only".to_string())
    } else {
        ctx.mapper.lock().unwrap().approval(params)
    };
    match request {
        Ok(a) => {
            let request_id = format!("gemini-{}", CARDS.fetch_add(1, Ordering::SeqCst) + 1);
            ctx.state.lock().unwrap().pending.insert(request_id.clone(), Pending { rpc_id: id.clone(), allow: a.allow, reject: a.reject });
            (ctx.sink)(UiEvent::PermissionRequested { request_id, tool_name: a.tool_name, input: a.input });
        }
        Err(why) => {
            declined_step(ctx, &why);
            answer_later(ctx, id, cancelled());
        }
    }
}

/// Written apart: waiting for stdin here could hold up the stdout the agent is waiting to have emptied.
fn refuse_later(ctx: &Ctx, id: &Value, message: String) {
    let (ctx, id) = (ctx.clone(), id.clone());
    tokio::spawn(async move { ctx.refuse(&id, message).await });
}

fn answer_later(ctx: &Ctx, id: &Value, result: Value) {
    let (ctx, id) = (ctx.clone(), id.clone());
    tokio::spawn(async move { ctx.answer(&id, result).await });
}

/// The chat says a request was declined without the user being asked, and why.
fn declined_step(ctx: &Ctx, why: &str) {
    let id = format!("declined-{}", CARDS.fetch_add(1, Ordering::SeqCst) + 1);
    (ctx.sink)(UiEvent::ToolStarted { parent: None, tool_use_id: id.clone(), name: "Request declined".into(), summary: why.to_string() });
    (ctx.sink)(UiEvent::ToolFinished { parent: None, tool_use_id: id, is_error: true, output: format!("Lantern declined a request from Gemini because {why}. Nothing was run, changed or allowed.") });
}

/// A notification from the agent. What it says while no turn runs is the conversation replayed to a loaded session (the chat
/// has it already), and isn't shown.
fn notification(ctx: &Ctx, method: &str, params: &Value) {
    if method != "session/update" {
        return;
    }
    {
        let s = ctx.state.lock().unwrap();
        if !s.busy || params["sessionId"].as_str() != s.session_id.as_deref() {
            return;
        }
    }
    let mapped = ctx.mapper.lock().unwrap().update(&params["update"]);
    for ev in mapped.events {
        (ctx.sink)(ev);
    }
    for (path, original) in mapped.edits {
        (ctx.on_edit)(&path, original);
    }
}

/// `text` without terminal colour codes, which Gemini's log lines may carry.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for n in chars.by_ref() {
                if n.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offered(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn colour_codes_are_taken_out_of_log_lines() {
        assert_eq!(strip_ansi("\u{1b}[31mred\u{1b}[0m text"), "red text");
    }

    #[test]
    fn every_mode_asks_and_none_maps_to_yolo_whatever_gemini_offers() {
        let all = offered(&["default", "autoEdit", "yolo", "plan"]);
        for mode in [Mode::Ask, Mode::Steps, Mode::Auto] {
            assert_eq!(approval_mode(mode, false, &all).unwrap(), "autoEdit");
            assert_eq!(approval_mode(mode, true, &all).unwrap(), "plan");
        }
        // Without autoEdit the plain mode (which asks for edits too); without plan, a read-only agent asks, and is declined.
        assert_eq!(approval_mode(Mode::Ask, false, &offered(&["default", "yolo"])).unwrap(), "default");
        assert_eq!(approval_mode(Mode::Ask, true, &offered(&["default", "autoEdit", "yolo"])).unwrap(), "default");
        // A Gemini that offers nothing but yolo is not one a chat can run on.
        assert!(approval_mode(Mode::Ask, false, &offered(&["yolo"])).is_err());
        assert!(approval_mode(Mode::Ask, false, &[]).is_err());
    }

    #[test]
    fn a_decision_selects_the_option_for_this_one_action_or_refuses_it() {
        let both = Pending { rpc_id: json!(7), allow: "proceed_once".into(), reject: Some("cancel".into()) };
        assert_eq!(outcome(&both, true), json!({"outcome": {"outcome": "selected", "optionId": "proceed_once"}}));
        assert_eq!(outcome(&both, false), json!({"outcome": {"outcome": "selected", "optionId": "cancel"}}));
        let only_allow = Pending { rpc_id: json!(7), allow: "proceed_once".into(), reject: None };
        assert_eq!(outcome(&only_allow, false), json!({"outcome": {"outcome": "cancelled"}}));
    }

    #[test]
    fn a_conversation_that_is_missing_is_told_from_one_that_failed() {
        assert!(looks_missing("Session not found: abc"));
        assert!(looks_missing("No such file or directory"));
        assert!(!looks_missing("Invalid session identifier format."));
        assert!(!looks_missing("Authentication required."));
    }
}
