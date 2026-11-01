//! A running `codex app-server`: JSON-RPC over stdio, one JSON object per line (Codex leaves out the `"jsonrpc"` field, and
//! so does this). Requests Lantern makes get their reply by id; the server's notifications become `UiEvent`s (codex_events);
//! its approval requests become the same Allow/Deny cards Claude's do, answered in the JSON-RPC reply.
//!
//! Signing in is the user's own (`codex login` in a terminal). Lantern asks the app-server only whether it is signed in, never
//! reads or sends a credential, and refuses the server's request for tokens.

use super::claude_session::{next_line, push_tail, signal_group, write_line, STDERR_TAIL_BYTES};
use super::codex::{parse_version, version_supported, MIN_VERSION};
use super::codex_events::{model_options, thread_events, Approval, ApprovalKind, CodexMapper};
use super::codex_prompt;
use crate::args::{Mode, Role};
use crate::session::{EditHook, SessionConfig};
use crate::ui_event::{Sink, UiEvent};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::BufReader;
use tokio::process::{ChildStdin, Command};
use tokio::sync::{oneshot, watch, Mutex as AsyncMutex};

const _: usize = STDERR_TAIL_BYTES;

/// How long a startup step may take: `launch` waits for them while it holds the chat's session lock.
const STEP_WAIT: Duration = Duration::from_secs(20);
/// How long `send` waits for a session that is still starting.
const READY_WAIT: Duration = Duration::from_secs(40);
/// How long a stopped session gets to finish after its input is closed, then after SIGTERM, before it is killed.
const EOF_GRACE: Duration = if cfg!(test) { Duration::from_millis(400) } else { Duration::from_secs(3) };
const TERM_GRACE: Duration = if cfg!(test) { Duration::from_millis(600) } else { Duration::from_secs(5) };

/// How many pages of turns a worker's transcript reads (100 turns each): more than a worker's conversation has.
const TRANSCRIPT_PAGES: usize = 20;

const SIGN_IN: &str = "Codex isn't signed in. Run `codex login` in a terminal, then send your message again.";

/// What Codex asks before it acts, and where it may write, for every mode Lantern has. Lantern has no Auto for Codex (see
/// Capabilities), so Ask and Step by step are the only ones that arrive, and an Auto that does is Ask: `on-request` with a
/// workspace-write sandbox applies edits inside the folder as they are made and asks for a command outside the sandbox,
/// network access or a file elsewhere. Nothing here ever maps to `never` or `danger-full-access`, whatever the user's
/// ~/.codex/config.toml says: it is sent with the thread and again with every turn.
pub fn approval_policy(_mode: Mode) -> &'static str {
    "on-request"
}

/// The sandbox that goes with `approval_policy`, as thread/start's `sandbox` takes it. A read-only agent (one sharing its
/// Lead's folder) gets Codex's read-only sandbox, so even a command it is allowed can't write.
pub fn sandbox_mode(_mode: Mode, read_only: bool) -> &'static str {
    if read_only {
        "read-only"
    } else {
        "workspace-write"
    }
}

/// The same sandbox as turn/start's `sandboxPolicy` takes it: the folder is writable by being the thread's cwd, nothing else
/// is; for a read-only agent, nothing is.
fn sandbox_policy(read_only: bool) -> Value {
    if read_only {
        json!({"type": "readOnly"})
    } else {
        json!({"type": "workspaceWrite", "writableRoots": [], "networkAccess": false, "excludeTmpdirEnvVar": false, "excludeSlashTmp": false})
    }
}

type Reply = oneshot::Sender<Result<Value, String>>;

#[derive(Clone, Debug, PartialEq)]
enum Ready {
    Starting,
    Yes,
    Failed(String),
}

struct Pending {
    /// The JSON-RPC id of the server's request, to answer it by.
    rpc_id: Value,
    asked: crate::permission::bridge::Pending,
    kind: ApprovalKind,
    /// The request as it came, to raise its card again if what it is about changes (see `patch_updated`).
    method: String,
    params: Value,
    /// The fileChange item a file-change card is about.
    item: Option<String>,
}

#[derive(Default)]
struct State {
    next_id: i64,
    replies: HashMap<i64, Reply>,
    thread_id: Option<String>,
    /// The running turn, once the server has said which it is.
    turn_id: Option<String>,
    /// A turn is running (or being started): a message sent now waits for it.
    busy: bool,
    /// Interrupt was asked before the turn's id was known.
    interrupt_when_started: bool,
    queued: VecDeque<(String, Vec<Value>)>,
    /// The model the user chose, for the next turn on; None is Codex's own default.
    model: Option<String>,
    /// What Codex uses when none is chosen (from `model/list`): sent when the user goes back to "default", because a model
    /// given to a turn stays for the turns after it.
    default_model: Option<String>,
    effort: Option<String>,
    /// Codex has no sign-in to use (checked at start and again before a turn while it hasn't).
    signed_out: bool,
    pending: HashMap<String, Pending>,
}

/// Cards are numbered across every session of the app, not within one: a card left on screen from a session that was
/// restarted can never be answered as the new session's card with the same number.
static CARDS: AtomicU64 = AtomicU64::new(0);

/// What every request and turn needs: the pipes and the shared state.
#[derive(Clone)]
struct Ctx {
    stdin: Arc<AsyncMutex<Option<ChildStdin>>>,
    state: Arc<Mutex<State>>,
    cwd: String,
    mode: Mode,
    /// A read-only agent: Codex's read-only sandbox, whatever it asks.
    read_only: bool,
    instructions: Arc<String>,
    ephemeral: bool,
}

impl Ctx {
    async fn request(&self, method: &str, params: Value, wait: Duration) -> Result<Value, String> {
        let (tx, rx) = oneshot::channel();
        let id = {
            let mut s = self.state.lock().unwrap();
            s.next_id += 1;
            let id = s.next_id;
            s.replies.insert(id, tx);
            id
        };
        if !write_line(&self.stdin, &json!({"id": id, "method": method, "params": params}).to_string()).await {
            self.state.lock().unwrap().replies.remove(&id);
            return Err("Codex isn't running.".into());
        }
        match tokio::time::timeout(wait, rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err("Codex stopped before it answered.".into()),
            Err(_) => {
                self.state.lock().unwrap().replies.remove(&id);
                Err(format!("Codex didn't answer {method} in time."))
            }
        }
    }

    async fn notify(&self, method: &str) {
        write_line(&self.stdin, &json!({"method": method}).to_string()).await;
    }

    async fn answer(&self, rpc_id: &Value, result: Value) {
        write_line(&self.stdin, &json!({"id": rpc_id, "result": result}).to_string()).await;
    }

    async fn refuse(&self, rpc_id: &Value, message: String) {
        write_line(&self.stdin, &json!({"id": rpc_id, "error": {"code": -32601, "message": message}}).to_string()).await;
    }

    /// Starts a turn with `text`, on the model, effort, folder and permissions this chat has now.
    async fn begin_turn(&self, text: &str, images: Vec<Value>) -> Result<(), String> {
        let (thread, model, effort) = {
            let mut s = self.state.lock().unwrap();
            s.busy = true;
            s.turn_id = None;
            (s.thread_id.clone(), s.model.clone().or_else(|| s.default_model.clone()), s.effort.clone())
        };
        let Some(thread) = thread else {
            self.state.lock().unwrap().busy = false;
            return Err("The Codex conversation isn't open.".into());
        };
        let mut input = images;
        input.push(json!({"type": "text", "text": text, "text_elements": []}));
        let mut params = json!({
            "threadId": thread,
            "input": input,
            "cwd": self.cwd,
            "approvalPolicy": approval_policy(self.mode),
            "approvalsReviewer": "user",
            "sandboxPolicy": sandbox_policy(self.read_only),
        });
        if let Some(m) = model {
            params["model"] = m.into();
        }
        if let Some(e) = effort {
            params["effort"] = e.into();
        }
        match self.request("turn/start", params, STEP_WAIT).await {
            Ok(reply) => {
                let mut s = self.state.lock().unwrap();
                if s.busy && s.turn_id.is_none() {
                    s.turn_id = reply["turn"]["id"].as_str().map(String::from);
                }
                Ok(())
            }
            Err(e) => {
                self.state.lock().unwrap().busy = false;
                Err(e)
            }
        }
    }

    /// Whether Codex has a sign-in, asked of the app-server (never of a file): `account/read` says an account is there, or that
    /// none is needed (an API-key setup, a custom provider). When it can't tell, signed in is assumed and a turn finds out.
    async fn signed_in(&self) -> bool {
        match self.request("account/read", json!({}), STEP_WAIT).await {
            Ok(r) => !(r["account"].is_null() && r["requiresOpenaiAuth"] == true),
            Err(_) => true,
        }
    }
}

pub struct CodexSession {
    ctx: Ctx,
    pid: u32,
    stopping: Arc<AtomicBool>,
    exited: watch::Receiver<bool>,
    ready: watch::Receiver<Ready>,
    sink: Sink,
}

/// The codex command for `cfg`: program, arguments, environment and folder, before it is started.
fn command(cfg: &SessionConfig) -> Command {
    let mut cmd = Command::new(&cfg.binary);
    cmd.arg("app-server").current_dir(&cfg.folder);
    // App-side inference has no MCP tools, including ones from the user's own config.
    if cfg.helper.socket.is_empty() { cmd.arg("-c").arg("mcp_servers={}"); }
    // Session-local overrides: never write to the user's Codex configuration.
    for setting in if cfg.helper.socket.is_empty() { vec![] } else { lantern_mcp_settings(cfg) } {
        cmd.arg("-c").arg(setting);
    }
    if let Some(p) = &cfg.path_env {
        cmd.env("PATH", p);
    }
    cmd
}

/// Codex's `-c` values are TOML. JSON string literals also quote these paths and
/// socket values safely as TOML basic strings, including spaces and backslashes.
fn lantern_mcp_settings(cfg: &SessionConfig) -> Vec<String> {
    let quote = |s: &str| serde_json::to_string(s).unwrap();
    let mut env = vec![format!("LANTERN_SOCKET = {}", quote(&cfg.helper.socket))];
    if matches!(cfg.helper.role, Role::Worker { read_only: true, .. }) {
        env.push(format!("LANTERN_ROLE = {}", quote(crate::permission::catalogue::READER_ROLE)));
    }
    if cfg.mode == Mode::Steps {
        env.push("LANTERN_STEPS = \"1\"".into());
    }
    vec![
        format!("mcp_servers.lantern.command={}", quote(&cfg.helper.exe)),
        "mcp_servers.lantern.args=[\"--permission-helper\"]".into(),
        format!("mcp_servers.lantern.env={{ {} }}", env.join(", ")),
        "mcp_servers.lantern.enabled=true".into(),
    ]
}

impl CodexSession {
    pub fn spawn(cfg: &SessionConfig, sink: Sink, on_edit: EditHook) -> Result<CodexSession, String> {
        if cfg.helper.role == Role::Main {
            return Err("A main agent can't run on Codex yet: it has no way to call the orchestra's tools. Start the main agent on Claude; its workers can run on Codex.".into());
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
        let pid = child.id().ok_or("codex exited before it started")?;
        let stdin = Arc::new(AsyncMutex::new(child.stdin.take()));
        let stdout = child.stdout.take().ok_or("codex has no stdout pipe")?;
        let stderr = child.stderr.take().ok_or("codex has no stderr pipe")?;

        let state = Arc::new(Mutex::new(State { model: cfg.model.clone(), effort: cfg.effort.clone(), thread_id: None, ..State::default() }));
        let ctx = Ctx { ephemeral: cfg.helper.socket.is_empty(), stdin, state: state.clone(), cwd: cfg.folder.display().to_string(), mode: cfg.mode, read_only: matches!(cfg.helper.role, Role::Worker { read_only: true, .. }), instructions: Arc::new(format!("{}{}", codex_prompt::instructions(cfg.mode, &cfg.helper.role), cfg.helper.project_notes.as_ref().map(|n|format!("\n\n{n}")).unwrap_or_default())) };
        let stopping = Arc::new(AtomicBool::new(false));
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
            let folder = cfg.folder.clone();
            tokio::spawn(async move {
                let mut mapper = CodexMapper::new(&folder);
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
                        (Some(method), Some(id)) => server_request(&ctx, &sink, &mut mapper, method, id, &v["params"]).await,
                        (Some(method), None) => notification(&ctx, &sink, &on_edit, &mut mapper, method, &v["params"]),
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
                    let _ = tx.send(Err("Codex stopped before it answered.".into()));
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
            let (resume, model) = (cfg.resume.clone(), cfg.model.clone());
            tokio::spawn(async move {
                match startup(&ctx, &sink, resume, model).await {
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

        Ok(CodexSession { ctx, pid, stopping, exited, ready, sink })
    }

    /// The conversation's id, which restarting the chat resumes.
    pub fn session_id(&self) -> Option<String> {
        self.ctx.state.lock().unwrap().thread_id.clone()
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

    pub(crate) async fn wait_ready(&self) -> Result<(), String> {
        let mut ready = self.ready.clone();
        let outcome = tokio::time::timeout(READY_WAIT, ready.wait_for(|r| *r != Ready::Starting)).await.map(|r| r.map(|state| state.clone()));
        match outcome {
            Ok(Ok(Ready::Failed(why))) => Err(why),
            Ok(Ok(_)) => Ok(()),
            Ok(Err(_)) => Err("Codex stopped before it was ready.".into()),
            Err(_) => Err("Codex didn't get ready in time.".into()),
        }
    }

    /// A message from the user: a new turn, or after the running one when there is one (Claude queues the same way).
    pub async fn send(&mut self, text: &str) -> Result<(), String> { self.send_with(text, vec![]).await }

    pub async fn compact(&mut self) -> Result<(), String> {
        self.wait_ready().await?;
        let thread = self.ctx.state.lock().unwrap().thread_id.clone().ok_or("No conversation is open")?;
        { let mut state = self.ctx.state.lock().unwrap(); if state.busy { return Err("This conversation is already working".into()); } state.busy = true; }
        match self.ctx.request("thread/compact/start", json!({"threadId": thread}), STEP_WAIT).await {
            Ok(_) => Ok(()),
            Err(e) => { self.ctx.state.lock().unwrap().busy = false; Err(e) },
        }
    }

    pub async fn send_with(&mut self, text: &str, images: Vec<Value>) -> Result<(), String> {
        self.wait_ready().await?;
        if self.ctx.state.lock().unwrap().signed_out && self.ctx.signed_in().await {
            self.ctx.state.lock().unwrap().signed_out = false;
        }
        if self.ctx.state.lock().unwrap().signed_out {
            // A turn would only fail with a 401: say so now, and how to fix it.
            (self.sink)(UiEvent::TurnDone { is_error: true, result: Some(SIGN_IN.into()), cost_usd: None, tokens: None, session_cost_usd: None, session_tokens: 0, duration_ms: None, auth_hint: true, denied: 0, context_window: None });
            return Ok(());
        }
        {
            let mut s = self.ctx.state.lock().unwrap();
            if s.busy {
                s.queued.push_back((text.to_string(), images));
                return Ok(());
            }
        }
        self.ctx.begin_turn(text, images).await
    }

    /// Ends the running turn (it finishes as interrupted) and answers the cards waiting on it; the process keeps running.
    pub async fn interrupt(&mut self) {
        // The turn can't go on while it waits for an answer, and the user has just said stop.
        self.settle_pending(true);
        let (thread, turn) = {
            let mut s = self.ctx.state.lock().unwrap();
            s.queued.clear();
            if !s.busy {
                return;
            }
            if s.turn_id.is_none() {
                s.interrupt_when_started = true;
            }
            (s.thread_id.clone(), s.turn_id.clone())
        };
        if let (Some(thread), Some(turn)) = (thread, turn) {
            let _ = self.ctx.request("turn/interrupt", json!({"threadId": thread, "turnId": turn}), Duration::from_secs(5)).await;
        }
    }

    /// The conversation so far, read from the app-server as the events it showed: its turns a page at a time (`thread/turns/list`,
    /// which is how this Codex serves them), else `thread/read` with its turns (an older one). A conversation that has had no
    /// turn yet isn't on disk to read, and reads as empty.
    pub async fn transcript(&self) -> Result<Vec<UiEvent>, String> {
        let thread = self.ctx.state.lock().unwrap().thread_id.clone().ok_or("The Codex conversation isn't open.")?;
        let empty = |e: &str| e.contains("not loaded") || e.contains("no rollout") || e.contains("not materialized");
        let mut turns: Vec<Value> = Vec::new();
        let mut cursor = Value::Null;
        for _ in 0..TRANSCRIPT_PAGES {
            let params = json!({"threadId": thread, "itemsView": "full", "sortDirection": "asc", "limit": 100, "cursor": cursor});
            match self.ctx.request("thread/turns/list", params, STEP_WAIT).await {
                Ok(page) => {
                    turns.extend(page["data"].as_array().cloned().unwrap_or_default());
                    match page["nextCursor"].as_str() {
                        Some(next) => cursor = next.into(),
                        None => return Ok(thread_events(std::path::Path::new(&self.ctx.cwd), &json!({"turns": turns}))),
                    }
                }
                Err(e) if empty(&e) => return Ok(vec![]),
                Err(e) if e.contains("not supported") && turns.is_empty() => return self.read_thread(&thread).await,
                Err(e) => return Err(format!("Couldn't read the Codex conversation: {e}")),
            }
        }
        // A conversation longer than that is read as far as it goes.
        Ok(thread_events(std::path::Path::new(&self.ctx.cwd), &json!({"turns": turns})))
    }

    /// The whole conversation in one `thread/read`, for a Codex that doesn't list turns.
    async fn read_thread(&self, thread: &str) -> Result<Vec<UiEvent>, String> {
        match self.ctx.request("thread/read", json!({"threadId": thread, "includeTurns": true}), STEP_WAIT).await {
            Ok(r) => Ok(thread_events(std::path::Path::new(&self.ctx.cwd), &r["thread"])),
            Err(e) if e.contains("not loaded") || e.contains("no rollout") || e.contains("not materialized") => Ok(vec![]),
            Err(e) => Err(format!("Couldn't read the Codex conversation: {e}")),
        }
    }

    /// The model from the next turn on; None goes back to Codex's own.
    pub fn set_effort(&mut self, effort: Option<&str>) { self.ctx.state.lock().unwrap().effort = effort.map(str::to_string); }

    pub async fn set_model(&mut self, model: Option<&str>) -> Result<(), String> {
        self.ctx.state.lock().unwrap().model = model.map(String::from);
        Ok(())
    }

    pub fn pending_permissions(&self) -> Vec<crate::permission::bridge::Pending> {
        self.ctx.state.lock().unwrap().pending.values().map(|p| p.asked.clone()).collect()
    }

    /// The user's answer to a card. False when there is no such card (it was answered, or it isn't Codex's).
    pub async fn respond_permission(&mut self, request_id: &str, allow: bool) -> bool {
        let Some(p) = self.ctx.state.lock().unwrap().pending.remove(request_id) else { return false };
        self.ctx.answer(&p.rpc_id, decision(&p.kind, allow, false)).await;
        true
    }

    /// Answers every waiting card (declined, or the turn cancelled) and takes them off the window.
    fn settle_pending(&self, cancel: bool) {
        let pending: Vec<(String, Pending)> = self.ctx.state.lock().unwrap().pending.drain().collect();
        for (request_id, p) in pending {
            let ctx = self.ctx.clone();
            tokio::spawn(async move { ctx.answer(&p.rpc_id, decision(&p.kind, false, cancel)).await });
            (self.sink)(UiEvent::PermissionWithdrawn { request_id });
        }
    }

    /// Shuts the process down on purpose; no SessionEnded event follows. Closing its input is how app-server is asked to
    /// finish; its group is signalled after that, so a command it was running stops too.
    pub async fn stop(self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.settle_pending(true);
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

/// The JSON-RPC result that answers an approval request: `allow` accepts it (for this one action), otherwise it is declined
/// (the turn goes on and Codex is told), or with `cancel` the whole turn is stopped. Permissions have no decline, so the
/// grant is simply empty.
fn decision(kind: &ApprovalKind, allow: bool, cancel: bool) -> Value {
    match kind {
        ApprovalKind::Command | ApprovalKind::FileChange => json!({"decision": if allow { "accept" } else if cancel { "cancel" } else { "decline" }}),
        ApprovalKind::Permissions { requested } => {
            let granted: serde_json::Map<String, Value> = match (allow, requested.as_object()) {
                (true, Some(o)) => o.iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.clone(), v.clone())).collect(),
                _ => Default::default(),
            };
            json!({"permissions": granted, "scope": "turn"})
        }
    }
}

/// The handshake, then the conversation: a new one, or the one `resume` names.
async fn startup(ctx: &Ctx, sink: &Sink, resume: Option<String>, model: Option<String>) -> Result<(), String> {
    let init = ctx
        .request(
            "initialize",
            json!({"clientInfo": {"name": "lantern", "title": "Lantern", "version": env!("CARGO_PKG_VERSION")}, "capabilities": {"experimentalApi": false, "requestAttestation": false}}),
            STEP_WAIT,
        )
        .await
        .map_err(|e| format!("Codex's app-server didn't start ({e}). Is this a current Codex? Update it (`npm i -g @openai/codex`), then restart the chat."))?;
    // "<client name>/<codex version> (<os>…)".
    let version = init["userAgent"].as_str().and_then(|ua| ua.split_whitespace().next()).and_then(|first| first.split_once('/')).map(|(_, v)| v.to_string());
    if let Some(v) = version.as_deref().and_then(parse_version) {
        if !version_supported(v) {
            let (a, b, c) = MIN_VERSION;
            return Err(format!("This Codex ({}.{}.{}) is older than the {a}.{b}.{c} Lantern needs. Update it (`npm i -g @openai/codex`), then restart the chat.", v.0, v.1, v.2));
        }
    }
    ctx.notify("initialized").await;

    let signed_in = ctx.signed_in().await;
    ctx.state.lock().unwrap().signed_out = !signed_in;

    // The models it offers, for the picker (and which one it uses when none is chosen). A page is plenty.
    if let Ok(list) = ctx.request("model/list", json!({}), STEP_WAIT).await {
        let (models, default) = model_options(&list["data"]);
        ctx.state.lock().unwrap().default_model = default;
        if !models.is_empty() {
            sink(UiEvent::Models { models });
        }
    }

    let mut params = json!({
        "cwd": ctx.cwd,
        "approvalPolicy": approval_policy(ctx.mode),
        "approvalsReviewer": "user",
        "sandbox": sandbox_mode(ctx.mode, ctx.read_only),
        "developerInstructions": *ctx.instructions,
        "ephemeral": ctx.ephemeral,
    });
    if let Some(m) = model {
        params["model"] = m.into();
    }
    let mut thread = None;
    if let Some(id) = resume {
        let mut p = params.clone();
        p["threadId"] = id.into();
        match ctx.request("thread/resume", p, STEP_WAIT).await {
            Ok(r) => thread = Some(r),
            // A conversation that never had a message isn't on disk to resume (a chat restarted before its first turn).
            Err(e) if e.contains("no rollout found") => {}
            Err(e) => return Err(format!("Couldn't resume the Codex conversation: {e}")),
        }
    }
    let thread = match thread {
        Some(t) => t,
        None => ctx.request("thread/start", params, STEP_WAIT).await.map_err(|e| format!("Couldn't start a Codex conversation: {e}"))?,
    };
    let id = thread["thread"]["id"].as_str().ok_or("Codex started a conversation without an id.")?.to_string();
    ctx.state.lock().unwrap().thread_id = Some(id.clone());
    sink(UiEvent::SessionStarted {
        session_id: id,
        model: thread["model"].as_str().unwrap_or("").to_string(),
        cwd: thread["cwd"].as_str().unwrap_or(&ctx.cwd).to_string(),
        permission_mode: approval_policy(ctx.mode).to_string(),
        claude_version: format!("codex {}", version.unwrap_or_default()).trim().to_string(),
    });
    Ok(())
}

/// A reply to one of our requests.
fn deliver(ctx: &Ctx, id: &Value, v: &Value) {
    let Some(tx) = id.as_i64().and_then(|id| ctx.state.lock().unwrap().replies.remove(&id)) else { return };
    let reply = match v.get("error") {
        Some(e) => Err(e["message"].as_str().unwrap_or("Codex refused the request.").to_string()),
        None => Ok(v["result"].clone()),
    };
    let _ = tx.send(reply);
}

/// A request from the server. Approvals become cards; one that can't be shown as it is, and the older kinds of approval, are
/// declined at once; anything else is refused, because the server waits for a reply to each (the user's questions, MCP
/// forms, tool calls, and the request for sign-in tokens, which Lantern never answers).
async fn server_request(ctx: &Ctx, sink: &Sink, mapper: &mut CodexMapper, method: &str, id: &Value, params: &Value) {
    // The server's ids are its own to keep apart; one that is already waiting would have two cards answered by one reply, so
    // the card waiting is taken off and the id is answered as refused.
    let twins: Vec<String> = {
        let mut s = ctx.state.lock().unwrap();
        let keys = s.pending.iter().filter(|(_, p)| p.rpc_id == *id).map(|(k, _)| k.clone()).collect::<Vec<_>>();
        keys.iter().for_each(|k| drop(s.pending.remove(k)));
        keys
    };
    if !twins.is_empty() {
        twins.into_iter().for_each(|request_id| sink(UiEvent::PermissionWithdrawn { request_id }));
        declined_step(sink, "the request reused the number of one still waiting");
        refuse_later(ctx, id, format!("{method} reused the number of a request still waiting."));
        return;
    }
    // Asked about this conversation, and no other: its id is on every approval request.
    let ours = ctx.state.lock().unwrap().thread_id.clone();
    let request = match mapper.approval(method, params) {
        Some(Ok(_)) if params["threadId"].as_str().is_none() || params["threadId"].as_str() != ours.as_deref() => Some(Err("it is not about this conversation".to_string())),
        // A read-only agent shares its Lead's folder: nothing it asks for is allowed, so the user isn't asked (one Allow would
        // let it write there). Claude's read-only agent has no tool to ask with; this is Codex's way of being the same.
        Some(Ok(_)) if ctx.read_only => Some(Err("this agent is read-only".to_string())),
        other => other,
    };
    match request {
        Some(Ok(a)) => raise(ctx, sink, id, method, params, a),
        Some(Err(why)) => {
            declined_step(sink, &why);
            let (ctx, id, answer) = (ctx.clone(), id.clone(), declined(method));
            tokio::spawn(async move { ctx.answer(&id, answer).await });
        }
        // The first protocol's approvals: a server that sends them is not one Lantern knows how to ask for.
        None if matches!(method, "execCommandApproval" | "applyPatchApproval") => {
            declined_step(sink, "it is an older kind of approval request");
            let (ctx, id) = (ctx.clone(), id.clone());
            tokio::spawn(async move { ctx.answer(&id, json!({"decision": "denied"})).await });
        }
        None => refuse_later(ctx, id, format!("Lantern doesn't handle {method} requests.")),
    }
}

/// Written apart: waiting for stdin here could hold up the stdout the server is waiting to have emptied.
fn refuse_later(ctx: &Ctx, id: &Value, message: String) {
    let (ctx, id) = (ctx.clone(), id.clone());
    tokio::spawn(async move { ctx.refuse(&id, message).await });
}

/// What answers a request Lantern won't ask about: declined, in the shape its method takes.
fn declined(method: &str) -> Value {
    match method {
        "item/permissions/requestApproval" => json!({"permissions": {}, "scope": "turn"}),
        _ => json!({"decision": "decline"}),
    }
}

/// The chat says a request was declined without the user being asked, and why.
fn declined_step(sink: &Sink, why: &str) {
    let id = format!("declined-{}", CARDS.fetch_add(1, Ordering::SeqCst) + 1);
    sink(UiEvent::ToolStarted { parent: None, tool_use_id: id.clone(), name: "Request declined".into(), summary: why.to_string() });
    sink(UiEvent::ToolFinished { parent: None, tool_use_id: id, is_error: true, output: format!("Lantern declined a request from Codex because {why}. Nothing was run, changed or allowed.") });
}

/// Puts a card up for the request, which is answered by the number it came with.
fn raise(ctx: &Ctx, sink: &Sink, rpc_id: &Value, method: &str, params: &Value, a: Approval) {
    let request_id = format!("codex-{}", CARDS.fetch_add(1, Ordering::SeqCst) + 1);
    let asked = crate::permission::bridge::Pending {
        request_id: request_id.clone(), tool_name: a.tool_name.clone(), input: a.input.clone(),
        at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64),
    };
    let pending = Pending { rpc_id: rpc_id.clone(), asked, kind: a.kind, method: method.to_string(), params: params.clone(), item: a.item };
    ctx.state.lock().unwrap().pending.insert(request_id.clone(), pending);
    sink(UiEvent::PermissionRequested { request_id, tool_name: a.tool_name, input: a.input });
}

/// The files of a change a card is waiting on were updated: what the user was shown is not what Codex would now apply, so
/// that card is taken off and the request is asked again as it is now (or declined, when it can't be shown).
fn patch_updated(ctx: &Ctx, sink: &Sink, mapper: &CodexMapper, item: &str) {
    let stale: Vec<(String, Pending)> = {
        let mut s = ctx.state.lock().unwrap();
        let keys = s.pending.iter().filter(|(_, p)| p.item.as_deref() == Some(item)).map(|(k, _)| k.clone()).collect::<Vec<_>>();
        keys.into_iter().filter_map(|k| s.pending.remove(&k).map(|p| (k, p))).collect()
    };
    for (old, p) in stale {
        sink(UiEvent::PermissionWithdrawn { request_id: old });
        match mapper.approval(&p.method, &p.params) {
            Some(Ok(a)) => raise(ctx, sink, &p.rpc_id, &p.method, &p.params, a),
            other => {
                declined_step(sink, other.and_then(Result::err).as_deref().unwrap_or("the request changed"));
                let (ctx, answer) = (ctx.clone(), declined(&p.method));
                tokio::spawn(async move { ctx.answer(&p.rpc_id, answer).await });
            }
        }
    }
}

/// A notification from the server: what it does to the session, then what the window shows of it.
fn notification(ctx: &Ctx, sink: &Sink, on_edit: &EditHook, mapper: &mut CodexMapper, method: &str, params: &Value) {
    let mut next = None;
    match method {
        "turn/started" => {
            let interrupt = {
                let mut s = ctx.state.lock().unwrap();
                s.busy = true;
                s.turn_id = params["turn"]["id"].as_str().map(String::from);
                (std::mem::take(&mut s.interrupt_when_started), s.thread_id.clone(), s.turn_id.clone())
            };
            if let (true, Some(thread), Some(turn)) = interrupt {
                let ctx = ctx.clone();
                tokio::spawn(async move { ctx.request("turn/interrupt", json!({"threadId": thread, "turnId": turn}), Duration::from_secs(5)).await });
            }
        }
        // Resolved elsewhere (the turn ended, or it was interrupted): the card can't be answered any more.
        "serverRequest/resolved" => {
            let gone = {
                let mut s = ctx.state.lock().unwrap();
                let key = s.pending.iter().find(|(_, p)| p.rpc_id == params["requestId"]).map(|(k, _)| k.clone());
                key.and_then(|k| s.pending.remove(&k).map(|_| k))
            };
            if let Some(request_id) = gone {
                sink(UiEvent::PermissionWithdrawn { request_id });
            }
            return;
        }
        "turn/completed" => {
            let (stale, queued) = {
                let mut s = ctx.state.lock().unwrap();
                s.busy = false;
                s.turn_id = None;
                s.interrupt_when_started = false;
                (s.pending.drain().map(|(id, _)| id).collect::<Vec<_>>(), s.queued.pop_front())
            };
            for request_id in stale {
                sink(UiEvent::PermissionWithdrawn { request_id });
            }
            next = queued;
        }
        _ => {}
    }
    let mapped = mapper.notification(method, params);
    // Whatever tells Codex's files of a change anew: a card still waiting on it is for what was true before.
    let file_item = |item: &Value| item["type"] == "fileChange" && item["id"].is_string();
    match method {
        "item/fileChange/patchUpdated" => patch_updated(ctx, sink, mapper, params["itemId"].as_str().unwrap_or("")),
        "item/started" if file_item(&params["item"]) => patch_updated(ctx, sink, mapper, params["item"]["id"].as_str().unwrap_or("")),
        // Over: Codex has its answer, and the files are no longer known, so there is nothing left to ask.
        "item/completed" if file_item(&params["item"]) => {
            let item = params["item"]["id"].as_str().unwrap_or("");
            let gone: Vec<String> = {
                let mut s = ctx.state.lock().unwrap();
                let keys = s.pending.iter().filter(|(_, p)| p.item.as_deref() == Some(item)).map(|(k, _)| k.clone()).collect::<Vec<_>>();
                keys.iter().for_each(|k| drop(s.pending.remove(k)));
                keys
            };
            gone.into_iter().for_each(|request_id| sink(UiEvent::PermissionWithdrawn { request_id }));
        }
        _ => {}
    }
    for ev in mapped.events {
        sink(ev);
    }
    for (path, original) in mapped.edits {
        on_edit(&path, original);
    }
    // The message sent while that turn ran, after its end has been shown.
    if let Some((text, images)) = next {
        let (ctx, sink) = (ctx.clone(), sink.clone());
        tokio::spawn(async move {
            if let Err(why) = ctx.begin_turn(&text, images).await {
                sink(UiEvent::TurnDone { is_error: true, result: Some(why), cost_usd: None, tokens: None, session_cost_usd: None, session_tokens: 0, duration_ms: None, auth_hint: false, denied: 0, context_window: None });
            }
        });
    }
}

/// `text` without terminal colour codes, which Codex's log lines carry.
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

    #[test]
    fn colour_codes_are_taken_out_of_log_lines() {
        assert_eq!(strip_ansi("\u{1b}[2m2026\u{1b}[0m \u{1b}[31mERROR\u{1b}[0m failed"), "2026 ERROR failed");
        assert_eq!(strip_ansi("plain"), "plain");
    }

    #[test]
    fn every_mode_asks_in_the_workspace_sandbox_and_none_maps_to_never_or_full_access() {
        for mode in [Mode::Ask, Mode::Steps, Mode::Auto] {
            assert_eq!(approval_policy(mode), "on-request");
            assert_eq!(sandbox_mode(mode, false), "workspace-write");
            assert_eq!(sandbox_mode(mode, true), "read-only");
        }
        assert_eq!(sandbox_policy(false)["type"], "workspaceWrite");
        assert_eq!(sandbox_policy(true)["type"], "readOnly");
        assert_eq!(sandbox_policy(false)["networkAccess"], false);
    }

    #[test]
    fn a_decision_accepts_declines_or_cancels_and_a_permission_grant_is_the_asked_for_part_or_nothing() {
        assert_eq!(decision(&ApprovalKind::Command, true, false), json!({"decision": "accept"}));
        assert_eq!(decision(&ApprovalKind::FileChange, false, false), json!({"decision": "decline"}));
        assert_eq!(decision(&ApprovalKind::Command, false, true), json!({"decision": "cancel"}));
        let asked = ApprovalKind::Permissions { requested: json!({"network": {"enabled": true}, "fileSystem": null}) };
        assert_eq!(decision(&asked, true, false), json!({"permissions": {"network": {"enabled": true}}, "scope": "turn"}));
        assert_eq!(decision(&asked, false, false), json!({"permissions": {}, "scope": "turn"}));
    }
}

/// The session against a fake `codex app-server`: a shell script that answers the handshake the way the real one did
/// (see fixtures/codex/handshake.jsonl, recorded from codex 0.162.1) and plays a scripted turn.
#[cfg(test)]
mod fake_server_tests {
    use super::*;
    use crate::args::HelperConfig;
    use crate::provider::ProviderId;
    use crate::session::Session;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use tokio::sync::mpsc;

    #[test]
    fn lantern_server_is_scoped_to_the_session_and_reader_role() {
        let mut cfg = config("/bin/codex".into(), Path::new("/tmp"), None);
        cfg.helper.exe = "/Applications/Lantern App/lantern".into();
        cfg.helper.socket = "/tmp/chat socket".into();
        cfg.mode = Mode::Steps;
        cfg.helper.role = Role::Worker { name: "reader".into(), read_only: true };
        let settings = lantern_mcp_settings(&cfg).join("\n");
        assert!(settings.contains("/Applications/Lantern App/lantern"));
        assert!(settings.contains("LANTERN_SOCKET = \"/tmp/chat socket\""));
        assert!(settings.contains("LANTERN_STEPS = \"1\""));
        assert!(settings.contains(crate::permission::catalogue::READER_ROLE));
        cfg.mode = Mode::Ask;
        cfg.helper.role = Role::Normal;
        let settings = lantern_mcp_settings(&cfg).join("\n");
        assert!(!settings.contains("LANTERN_ROLE") && !settings.contains("LANTERN_STEPS"));
    }

    /// What the fake does when a turn starts, after it has answered turn/start.
    const NOTHING: &str = ":";
    const TURN_STARTED: &str = r#"printf '%s\n' '{"method":"turn/started","params":{"threadId":"thr-1","turn":{"id":"turn-1","status":"inProgress","items":[]}}}'"#;
    const TURN_DONE: &str = r#"printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thr-1","turn":{"id":"turn-1","status":"completed","items":[],"durationMs":12}}}'"#;

    struct Fake {
        version: &'static str,
        account: &'static str,
        /// The reply to thread/resume (a shell command, given `$id`).
        resume: &'static str,
        /// The replies to thread/turns/list and thread/read (shell commands, given `$id` and `$line`).
        turns: &'static str,
        read: &'static str,
        on_turn: String,
    }

    impl Fake {
        fn new(on_turn: &str) -> Fake {
            Fake {
                version: "0.162.1",
                account: r#"{"account":{"type":"chatgpt"},"requiresOpenaiAuth":true}"#,
                resume: r#"reply "$id" '{"thread":{"id":"thr-resumed"},"model":"gpt-x","cwd":"/p"}'"#,
                turns: r#"reply "$id" '{"data":[],"nextCursor":null}'"#,
                read: r#"reply "$id" '{"thread":{"id":"thr-1","turns":[]}}'"#,
                on_turn: on_turn.to_string(),
            }
        }

        fn script(&self, dir: &Path) -> PathBuf {
            let body = format!(
                r#"#!/bin/sh
LOG={dir}/stdin.txt
reply() {{ printf '{{"id":%s,"result":%s}}\n' "$1" "$2"; }}
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG"
  id=$(printf '%s' "$line" | sed -n 's/^{{"id":\([0-9]*\),.*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) reply "$id" '{{"userAgent":"lantern/{version} (Mac OS 26.4.1; arm64) unknown (lantern; 0)","codexHome":"/tmp/h","platformFamily":"unix","platformOs":"macos"}}' ;;
    *'"method":"account/read"'*) reply "$id" '{account}' ;;
    *'"method":"model/list"'*) reply "$id" '{{"data":[{{"id":"gpt-x","model":"gpt-x","displayName":"GPT X","description":"d","hidden":false,"isDefault":true,"supportedReasoningEfforts":[{{"reasoningEffort":"low","description":""}},{{"reasoningEffort":"ultra","description":""}}]}}],"nextCursor":null}}' ;;
    *'"method":"thread/resume"'*) {resume} ;;
    *'"method":"thread/start"'*) reply "$id" '{{"thread":{{"id":"thr-1"}},"model":"gpt-x","cwd":"{dir}"}}' ;;
    *'"method":"thread/turns/list"'*) {turns} ;;
    *'"method":"thread/read"'*) {read} ;;
    *'"method":"thread/compact/start"'*) reply "$id" '{{}}'
{on_turn}
      ;;
    *'"method":"turn/start"'*) reply "$id" '{{"turn":{{"id":"turn-1","status":"inProgress","items":[]}}}}'
{on_turn}
      ;;
  esac
done
"#,
                dir = dir.display(),
                version = self.version,
                account = self.account,
                resume = self.resume,
                turns = self.turns,
                read = self.read,
                on_turn = self.on_turn,
            );
            let p = dir.join("fake-codex");
            std::fs::write(&p, body).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p
        }
    }

    fn config(binary: PathBuf, folder: &Path, resume: Option<&str>) -> SessionConfig {
        SessionConfig {
            provider: ProviderId::Codex,
            binary,
            folder: folder.to_path_buf(),
            mode: Mode::Ask,
            auto_approve: false,
            resume: resume.map(String::from),
            model: None,
            effort: Some("high".into()),
            advisor: None,
            subagent_model: None,
            helper: HelperConfig { exe: "/usr/bin/true".into(), socket: "/tmp/none.sock".into(), role: Role::Normal, providers: vec![], project_notes: None },
            path_env: None,
            endpoint: None,
        }
    }

    fn channel_sink() -> (Sink, mpsc::UnboundedReceiver<UiEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Arc::new(move |ev| { let _ = tx.send(ev); }), rx)
    }

    fn no_edits() -> EditHook {
        Arc::new(|_: &str, _: Option<String>| {})
    }

    async fn next_matching(rx: &mut mpsc::UnboundedReceiver<UiEvent>, pred: impl Fn(&UiEvent) -> bool) -> UiEvent {
        tokio::time::timeout(Duration::from_secs(15), async {
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

    /// Every line Lantern wrote to the fake, as JSON.
    fn sent(dir: &Path) -> Vec<Value> {
        std::fs::read_to_string(dir.join("stdin.txt")).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    fn requests(dir: &Path, method: &str) -> Vec<Value> {
        sent(dir).into_iter().filter(|m| m["method"] == method).collect()
    }

    async fn wait_sent(dir: &Path, enough: impl Fn(&[Value]) -> bool) -> Vec<Value> {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let all = sent(dir);
                if enough(&all) {
                    return all;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("timed out waiting for what Lantern sends")
    }

    async fn open(fake: &Fake, dir: &Path, resume: Option<&str>) -> (Session, mpsc::UnboundedReceiver<UiEvent>) {
        let (sink, rx) = channel_sink();
        let mut s = Session::spawn(&config(fake.script(dir), dir, resume), sink, no_edits()).unwrap();
        s.initialize().await;
        (s, rx)
    }

    #[tokio::test]
    async fn compact_uses_the_protocol_and_effort_changes_apply_to_the_next_turn() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, mut rx) = open(&Fake::new(&format!("{TURN_STARTED}\n{TURN_DONE}")), dir.path(), None).await;
        s.set_effort(Some("low"));
        s.send("first").await.unwrap();
        until_turn_done(&mut rx).await;
        assert_eq!(requests(dir.path(), "turn/start")[0]["params"]["effort"], "low");
        s.compact().await.unwrap();
        assert_eq!(requests(dir.path(), "thread/compact/start")[0]["params"]["threadId"], "thr-1");
        assert_eq!(requests(dir.path(), "turn/start").len(), 1, "compact must not send a slash command as a prompt");
        s.stop().await;
    }

    #[tokio::test]
    async fn pictures_are_sent_to_codex_as_data_urls_before_the_text() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::new(&format!("{TURN_STARTED}\n{TURN_DONE}"));
        let (sink, mut rx) = channel_sink();
        let mut s = Session::spawn(&config(fake.script(dir.path()), dir.path(), None), sink, no_edits()).unwrap();
        s.initialize().await;
        s.send_with("what is this?", vec![crate::session::InputImage { media_type: "image/png".into(), data: "aGVsbG8=".into() }]).await.unwrap();
        until_turn_done(&mut rx).await;
        let turns = requests(dir.path(), "turn/start");
        assert_eq!(turns[0]["params"]["input"][0], json!({"type":"image","url":"data:image/png;base64,aGVsbG8="}));
        assert_eq!(turns[0]["params"]["input"][1]["text"], "what is this?");
        s.stop().await;
    }

    #[tokio::test]
    async fn project_notes_and_provider_handoff_reach_codex_without_replacing_its_own_instructions() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = config(Fake::new(NOTHING).script(dir.path()), dir.path(), None);
        cfg.helper.project_notes = Some("Keep the existing API. Earlier user: fix retries.".into());
        let (sink, _) = channel_sink();
        let mut s = Session::spawn(&cfg, sink, no_edits()).unwrap();
        s.initialize().await;
        let start = requests(dir.path(), "thread/start").remove(0);
        assert!(start["params"]["developerInstructions"].as_str().unwrap().contains("Earlier user: fix retries."));
        assert!(start["params"].get("baseInstructions").is_none());
        s.stop().await;
    }

    #[tokio::test]
    async fn the_handshake_starts_a_conversation_with_lanterns_instructions_and_asks_before_it_acts() {
        let dir = tempfile::tempdir().unwrap();
        let (s, mut rx) = open(&Fake::new(NOTHING), dir.path(), None).await;
        let models = match next_matching(&mut rx, |e| matches!(e, UiEvent::Models { .. })).await {
            UiEvent::Models { models } => models,
            _ => unreachable!(),
        };
        match next_matching(&mut rx, |e| matches!(e, UiEvent::SessionStarted { .. })).await {
            UiEvent::SessionStarted { session_id, model, claude_version, .. } => {
                assert_eq!((session_id.as_str(), model.as_str(), claude_version.as_str()), ("thr-1", "gpt-x", "codex 0.162.1"));
            }
            _ => unreachable!(),
        }
        assert_eq!(s.session_id().as_deref(), Some("thr-1"));
        // The effort Lantern can't send ("ultra") isn't offered.
        assert_eq!((models[0].value.as_str(), models[0].effort_levels.clone()), ("gpt-x", vec!["low".to_string()]));

        let all = sent(dir.path());
        let methods: Vec<&str> = all.iter().filter_map(|m| m["method"].as_str()).collect();
        assert_eq!(methods, ["initialize", "initialized", "account/read", "model/list", "thread/start"]);
        assert_eq!(all[0]["params"]["clientInfo"]["name"], "lantern");
        let start = &all[4]["params"];
        assert_eq!((start["approvalPolicy"].as_str(), start["sandbox"].as_str(), start["approvalsReviewer"].as_str()), (Some("on-request"), Some("workspace-write"), Some("user")));
        assert_eq!(start["cwd"], dir.path().display().to_string());
        assert!(start["developerInstructions"].as_str().unwrap().contains("running inside Lantern, a macOS desktop app for coding agents"));
        assert!(start.get("threadId").is_none());
        s.stop().await;
    }

    const RECORDED: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/codex/handshake.jsonl");

    /// The replies the real codex 0.162.1 gave (recorded in an empty CODEX_HOME, no credentials), replayed one per request.
    #[tokio::test]
    async fn what_the_real_app_server_answered_is_read_the_way_it_is_sent() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("replay-codex");
        let body = format!(
            r#"#!/bin/sh
F="{RECORDED}"
send() {{ sed -n "$1p" "$F" | sed "s/^{{\"id\":[0-9]*/{{\"id\":$2/"; }}
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/^{{"id":\([0-9]*\),.*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) send 1 "$id" ;;
    *'"method":"account/read"'*) send 2 "$id" ;;
    *'"method":"model/list"'*) send 3 "$id" ;;
    *'"method":"thread/start"'*) send 4 "$id" ;;
  esac
done
"#
        );
        std::fs::write(&script, body).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (sink, mut rx) = channel_sink();
        let mut s = Session::spawn(&config(script, dir.path(), None), sink, no_edits()).unwrap();
        s.initialize().await;
        match next_matching(&mut rx, |e| matches!(e, UiEvent::Models { .. })).await {
            UiEvent::Models { models } => {
                assert_eq!(models[0].value, "gpt-6.1-sol");
                assert!(models.iter().all(|m| m.value != "gpt-daybreak-blue-latest"), "a hidden model is offered");
                assert_eq!(models[0].effort_levels, ["low", "medium", "high", "xhigh", "max"]);
            }
            _ => unreachable!(),
        }
        match next_matching(&mut rx, |e| matches!(e, UiEvent::SessionStarted { .. })).await {
            UiEvent::SessionStarted { session_id, model, claude_version, .. } => {
                assert_eq!(session_id, "01a13b0b-d6c1-70c2-bff2-486c86281375");
                assert_eq!((model.as_str(), claude_version.as_str()), ("gpt-6.1-sol", "codex 0.162.1"));
            }
            _ => unreachable!(),
        }
        // The recorded account/read: nobody signed in, and it says one is needed.
        s.send("hi").await.unwrap();
        match next_matching(&mut rx, |e| matches!(e, UiEvent::TurnDone { .. })).await {
            UiEvent::TurnDone { is_error: true, result: Some(r), .. } => assert!(r.contains("codex login")),
            other => panic!("{other:?}"),
        }
        s.stop().await;
    }

    #[tokio::test]
    async fn a_turn_streams_text_runs_a_command_and_reports_tokens_without_dollars() {
        let dir = tempfile::tempdir().unwrap();
        let on_turn = [
            TURN_STARTED,
            r#"printf '%s\n' '{"method":"item/started","params":{"threadId":"thr-1","turnId":"turn-1","item":{"type":"commandExecution","id":"c1","command":"/bin/zsh -lc \"ls\"","status":"inProgress"}}}'"#,
            r#"printf '%s\n' '{"method":"item/completed","params":{"threadId":"thr-1","turnId":"turn-1","item":{"type":"commandExecution","id":"c1","command":"/bin/zsh -lc \"ls\"","status":"completed","aggregatedOutput":"a.txt\n","exitCode":0}}}'"#,
            r#"printf '%s\n' '{"method":"item/agentMessage/delta","params":{"threadId":"thr-1","turnId":"turn-1","itemId":"a1","delta":"Fou"}}'"#,
            r#"printf '%s\n' '{"method":"item/completed","params":{"threadId":"thr-1","turnId":"turn-1","item":{"type":"agentMessage","id":"a1","text":"Found a.txt"}}}'"#,
            r#"printf '%s\n' '{"method":"thread/tokenUsage/updated","params":{"threadId":"thr-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":900},"last":{"totalTokens":900},"modelContextWindow":272000}}}'"#,
            TURN_DONE,
        ]
        .join("\n");
        let (mut s, mut rx) = open(&Fake::new(&on_turn), dir.path(), None).await;
        s.send("what files?").await.unwrap();
        let mut seen = Vec::new();
        loop {
            let ev = next_matching(&mut rx, |_| true).await;
            let done = matches!(ev, UiEvent::TurnDone { .. });
            seen.push(ev);
            if done {
                break;
            }
        }
        let kinds: Vec<&str> = seen
            .iter()
            .filter_map(|e| match e {
                UiEvent::ToolStarted { name, .. } if name == "Bash" => Some("bash"),
                UiEvent::ToolFinished { is_error: false, output, .. } if output == "a.txt\n" => Some("output"),
                UiEvent::TextDelta { .. } => Some("delta"),
                UiEvent::AssistantText { text, .. } if text == "Found a.txt" => Some("text"),
                UiEvent::TurnDone { is_error: false, cost_usd: None, tokens: Some(900), session_tokens: 900, context_window: Some(272000), .. } => Some("done"),
                _ => None,
            })
            .collect();
        assert_eq!(kinds, ["bash", "output", "delta", "text", "done"]);

        let turn = requests(dir.path(), "turn/start").remove(0);
        let p = &turn["params"];
        assert_eq!(p["threadId"], "thr-1");
        assert_eq!(p["input"], json!([{"type": "text", "text": "what files?", "text_elements": []}]));
        assert_eq!((p["approvalPolicy"].as_str(), p["approvalsReviewer"].as_str(), p["effort"].as_str(), p["model"].as_str()), (Some("on-request"), Some("user"), Some("high"), Some("gpt-x")));
        assert_eq!(p["sandboxPolicy"]["type"], "workspaceWrite");
        s.stop().await;
    }

    #[tokio::test]
    async fn a_command_the_user_allows_runs_and_a_file_change_they_deny_does_not() {
        let dir = tempfile::tempdir().unwrap();
        let on_turn = [
            TURN_STARTED,
            r#"printf '%s\n' '{"method":"item/started","params":{"threadId":"thr-1","turnId":"turn-1","item":{"type":"commandExecution","id":"c1","command":"npm test","status":"inProgress"}}}'"#,
            r#"printf '%s\n' '{"id":900,"method":"item/commandExecution/requestApproval","params":{"threadId":"thr-1","turnId":"turn-1","itemId":"c1","command":"npm test","reason":"needs the network","startedAtMs":1}}'"#,
            r#"read -r answer; printf '%s\n' "$answer" >> "$LOG""#,
            r#"printf '%s\n' '{"method":"serverRequest/resolved","params":{"threadId":"thr-1","requestId":900}}'"#,
            r#"printf '%s\n' '{"method":"item/started","params":{"threadId":"thr-1","turnId":"turn-1","item":{"type":"fileChange","id":"f1","changes":[{"path":"/p/x.txt","kind":{"type":"add"},"diff":"hi"}],"status":"inProgress"}}}'"#,
            r#"printf '%s\n' '{"id":901,"method":"item/fileChange/requestApproval","params":{"threadId":"thr-1","turnId":"turn-1","itemId":"f1","startedAtMs":2}}'"#,
            r#"read -r answer; printf '%s\n' "$answer" >> "$LOG""#,
            r#"printf '%s\n' '{"method":"item/completed","params":{"threadId":"thr-1","turnId":"turn-1","item":{"type":"fileChange","id":"f1","changes":[{"path":"/p/x.txt","kind":{"type":"add"},"diff":"hi"}],"status":"declined"}}}'"#,
            TURN_DONE,
        ]
        .join("\n");
        let (mut s, mut rx) = open(&Fake::new(&on_turn), dir.path(), None).await;
        s.send("go").await.unwrap();

        let (id, tool, input) = match next_matching(&mut rx, |e| matches!(e, UiEvent::PermissionRequested { .. })).await {
            UiEvent::PermissionRequested { request_id, tool_name, input } => (request_id, tool_name, input),
            _ => unreachable!(),
        };
        assert_eq!((tool.as_str(), input["command"].as_str(), input["description"].as_str()), ("Bash", Some("npm test"), Some("needs the network")));
        let waiting = s.pending_permissions();
        assert_eq!(waiting.len(), 1);
        assert_eq!((&waiting[0].request_id, &waiting[0].tool_name, &waiting[0].input), (&id, &tool, &input));
        assert!(waiting[0].at > 0);
        assert!(s.respond_permission(&id, true).await);
        assert!(s.pending_permissions().iter().all(|p| p.request_id != id));
        assert!(!s.respond_permission(&id, true).await, "a card is answered once");

        let (id2, tool2, input2) = match next_matching(&mut rx, |e| matches!(e, UiEvent::PermissionRequested { .. })).await {
            UiEvent::PermissionRequested { request_id, tool_name, input } => (request_id, tool_name, input),
            _ => unreachable!(),
        };
        assert_eq!((tool2.as_str(), input2["file_path"].as_str()), ("Write", Some("Create /p/x.txt")));
        assert_ne!(id, id2);
        assert!(s.respond_permission(&id2, false).await);
        match next_matching(&mut rx, |e| matches!(e, UiEvent::TurnDone { .. })).await {
            UiEvent::TurnDone { denied, is_error: false, .. } => assert_eq!(denied, 1),
            _ => unreachable!(),
        }
        let answers: Vec<Value> = sent(dir.path()).into_iter().filter(|m| m.get("method").is_none() && m.get("result").is_some()).collect();
        assert_eq!(answers[0], json!({"id": 900, "result": {"decision": "accept"}}));
        assert_eq!(answers[1], json!({"id": 901, "result": {"decision": "decline"}}));
        s.stop().await;
    }

    /// Every event up to the end of the turn.
    async fn until_turn_done(rx: &mut mpsc::UnboundedReceiver<UiEvent>) -> Vec<UiEvent> {
        let mut seen = Vec::new();
        loop {
            let ev = next_matching(rx, |_| true).await;
            let done = matches!(ev, UiEvent::TurnDone { .. });
            seen.push(ev);
            if done {
                return seen;
            }
        }
    }

    fn answers(dir: &Path) -> Vec<Value> {
        sent(dir).into_iter().filter(|m| m.get("method").is_none() && (m.get("result").is_some() || m.get("error").is_some())).collect()
    }

    #[tokio::test]
    async fn a_read_only_agent_is_never_asked_about_its_requests_they_are_all_declined() {
        let dir = tempfile::tempdir().unwrap();
        let ask = |id: u32, method: &str, params: &str| format!(r#"printf '%s\n' '{{"id":{id},"method":"{method}","params":{params}}}'"#);
        let on_turn = [
            TURN_STARTED.to_string(),
            ask(900, "item/commandExecution/requestApproval", r#"{"threadId":"thr-1","turnId":"turn-1","itemId":"c1","command":"touch x","startedAtMs":1}"#),
            r#"read -r answer; printf '%s\n' "$answer" >> "$LOG""#.to_string(),
            ask(901, "item/permissions/requestApproval", r#"{"threadId":"thr-1","turnId":"turn-1","itemId":"p1","cwd":"/p","permissions":{"network":{"enabled":true}},"startedAtMs":1}"#),
            r#"read -r answer; printf '%s\n' "$answer" >> "$LOG""#.to_string(),
            TURN_DONE.to_string(),
        ]
        .join("\n");
        let (sink, mut rx) = channel_sink();
        let mut cfg = config(Fake::new(&on_turn).script(dir.path()), dir.path(), None);
        cfg.helper.role = Role::Worker { name: "reader".into(), read_only: true };
        let mut s = Session::spawn(&cfg, sink, no_edits()).unwrap();
        s.initialize().await;
        s.send("go").await.unwrap();
        let seen = until_turn_done(&mut rx).await;
        assert!(!seen.iter().any(|e| matches!(e, UiEvent::PermissionRequested { .. })), "a read-only agent's request was put to the user");
        let got = answers(dir.path());
        assert_eq!(got[0], json!({"id": 900, "result": {"decision": "decline"}}));
        assert_eq!(got[1], json!({"id": 901, "result": {"permissions": {}, "scope": "turn"}}));
        // It ran in Codex's read-only sandbox too.
        let turn = &requests(dir.path(), "turn/start")[0];
        assert_eq!(turn["params"]["sandboxPolicy"]["type"], "readOnly");
        s.stop().await;
    }

    #[tokio::test]
    async fn requests_that_cannot_be_shown_as_they_are_are_declined_and_said_never_asked() {
        let dir = tempfile::tempdir().unwrap();
        let ask = |id: u32, method: &str, params: &str| format!(r#"printf '%s\n' '{{"id":{id},"method":"{method}","params":{params}}}'"#);
        let on_turn = [
            TURN_STARTED.to_string(),
            ask(900, "item/commandExecution/requestApproval", r#"{"threadId":"thr-1","turnId":"turn-1","itemId":"c1","command":["rm","-rf","/"],"startedAtMs":1}"#),
            r#"read -r answer; printf '%s\n' "$answer" >> "$LOG""#.to_string(),
            ask(901, "execCommandApproval", r#"{"conversationId":"thr-1","callId":"c2","command":["ls"],"cwd":"/p","parsedCmd":[]}"#),
            r#"read -r answer; printf '%s\n' "$answer" >> "$LOG""#.to_string(),
            ask(902, "item/permissions/requestApproval", r#"{"threadId":"thr-1","turnId":"turn-1","itemId":"p1","cwd":"/p","permissions":{"network":{"enabled":true},"shell":{}},"startedAtMs":1}"#),
            r#"read -r answer; printf '%s\n' "$answer" >> "$LOG""#.to_string(),
            ask(903, "item/fileChange/requestApproval", r#"{"threadId":"thr-1","turnId":"turn-1","itemId":"never-announced","startedAtMs":1}"#),
            r#"read -r answer; printf '%s\n' "$answer" >> "$LOG""#.to_string(),
            TURN_DONE.to_string(),
        ]
        .join("\n");
        let (mut s, mut rx) = open(&Fake::new(&on_turn), dir.path(), None).await;
        s.send("go").await.unwrap();
        let seen = until_turn_done(&mut rx).await;
        assert!(!seen.iter().any(|e| matches!(e, UiEvent::PermissionRequested { .. })), "a request that can't be shown was asked");
        let declined: Vec<&str> = seen.iter().filter_map(|e| match e { UiEvent::ToolFinished { is_error: true, output, .. } => Some(output.as_str()), _ => None }).collect();
        assert_eq!(declined.len(), 4);
        assert!(declined.iter().all(|o| o.starts_with("Lantern declined a request from Codex because") && o.ends_with("Nothing was run, changed or allowed.")), "{declined:?}");
        let got = answers(dir.path());
        assert_eq!(got[0], json!({"id": 900, "result": {"decision": "decline"}}));
        assert_eq!(got[1], json!({"id": 901, "result": {"decision": "denied"}}));
        assert_eq!(got[2], json!({"id": 902, "result": {"permissions": {}, "scope": "turn"}}));
        assert_eq!(got[3], json!({"id": 903, "result": {"decision": "decline"}}));
        s.stop().await;
    }

    #[tokio::test]
    async fn a_card_is_numbered_apart_from_every_card_of_every_session() {
        let on_turn = [TURN_STARTED, r#"printf '%s\n' '{"id":900,"method":"item/commandExecution/requestApproval","params":{"threadId":"thr-1","turnId":"turn-1","itemId":"c1","command":"ls","startedAtMs":1}}'"#].join("\n");
        let mut ids = Vec::new();
        for _ in 0..2 {
            let dir = tempfile::tempdir().unwrap();
            let (mut s, mut rx) = open(&Fake::new(&on_turn), dir.path(), None).await;
            s.send("go").await.unwrap();
            match next_matching(&mut rx, |e| matches!(e, UiEvent::PermissionRequested { .. })).await {
                UiEvent::PermissionRequested { request_id, .. } => ids.push(request_id),
                _ => unreachable!(),
            }
            s.stop().await;
        }
        assert_ne!(ids[0], ids[1], "the second session's first card has the first session's number");
    }

    #[tokio::test]
    async fn a_second_request_with_a_number_still_waiting_takes_the_first_card_off_and_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let request = r#"printf '%s\n' '{"id":900,"method":"item/commandExecution/requestApproval","params":{"threadId":"thr-1","turnId":"turn-1","itemId":"c1","command":"ls","startedAtMs":1}}'"#;
        let on_turn = [TURN_STARTED, request, request, r#"read -r answer; printf '%s\n' "$answer" >> "$LOG""#].join("\n");
        let (mut s, mut rx) = open(&Fake::new(&on_turn), dir.path(), None).await;
        s.send("go").await.unwrap();
        let first = match next_matching(&mut rx, |e| matches!(e, UiEvent::PermissionRequested { .. })).await {
            UiEvent::PermissionRequested { request_id, .. } => request_id,
            _ => unreachable!(),
        };
        match next_matching(&mut rx, |e| matches!(e, UiEvent::PermissionWithdrawn { .. })).await {
            UiEvent::PermissionWithdrawn { request_id } => assert_eq!(request_id, first),
            _ => unreachable!(),
        }
        assert!(!s.respond_permission(&first, true).await, "the withdrawn card still answers");
        let got = wait_sent(dir.path(), |all| all.iter().any(|m| m["id"] == 900 && m.get("method").is_none())).await;
        assert!(got.iter().any(|m| m["id"] == 900 && m["error"].is_object() && m.get("result").is_none()));
        s.stop().await;
    }

    #[tokio::test]
    async fn when_the_files_of_a_change_move_on_the_card_is_asked_again_with_the_new_list() {
        let dir = tempfile::tempdir().unwrap();
        let on_turn = [
            TURN_STARTED,
            r#"printf '%s\n' '{"method":"item/started","params":{"threadId":"thr-1","turnId":"turn-1","item":{"type":"fileChange","id":"f1","changes":[{"path":"/p/a.txt","kind":{"type":"add"},"diff":"x"}],"status":"inProgress"}}}'"#,
            r#"printf '%s\n' '{"id":900,"method":"item/fileChange/requestApproval","params":{"threadId":"thr-1","turnId":"turn-1","itemId":"f1","startedAtMs":2}}'"#,
            r#"printf '%s\n' '{"method":"item/fileChange/patchUpdated","params":{"threadId":"thr-1","turnId":"turn-1","itemId":"f1","changes":[{"path":"/p/a.txt","kind":{"type":"add"},"diff":"x"},{"path":"/etc/hosts","kind":{"type":"update","move_path":null},"diff":""}]}}'"#,
            r#"read -r answer; printf '%s\n' "$answer" >> "$LOG""#,
        ]
        .join("\n");
        let (mut s, mut rx) = open(&Fake::new(&on_turn), dir.path(), None).await;
        s.send("go").await.unwrap();
        let first = match next_matching(&mut rx, |e| matches!(e, UiEvent::PermissionRequested { .. })).await {
            UiEvent::PermissionRequested { request_id, input, .. } => {
                assert_eq!(input["file_path"], "Create /p/a.txt");
                request_id
            }
            _ => unreachable!(),
        };
        next_matching(&mut rx, |e| matches!(e, UiEvent::PermissionWithdrawn { request_id } if *request_id == first)).await;
        let (second, tool, input) = match next_matching(&mut rx, |e| matches!(e, UiEvent::PermissionRequested { .. })).await {
            UiEvent::PermissionRequested { request_id, tool_name, input } => (request_id, tool_name, input),
            _ => unreachable!(),
        };
        assert_eq!((tool.as_str(), input["file_path"].as_str()), ("Edit", Some("Create /p/a.txt\nEdit /etc/hosts")));
        assert!(!s.respond_permission(&first, true).await, "the card that was replaced still answers");
        assert!(s.respond_permission(&second, true).await);
        let got = wait_sent(dir.path(), |all| all.iter().any(|m| m["id"] == 900 && m.get("method").is_none())).await;
        assert_eq!(got.iter().filter(|m| m["id"] == 900 && m.get("method").is_none()).count(), 1, "one request, one answer");
        s.stop().await;
    }

    #[tokio::test]
    async fn a_request_about_another_conversation_or_none_is_declined_and_a_finished_change_takes_its_card_off() {
        let dir = tempfile::tempdir().unwrap();
        let on_turn = [
            TURN_STARTED,
            r#"printf '%s\n' '{"id":900,"method":"item/commandExecution/requestApproval","params":{"threadId":"someone-else","turnId":"turn-1","itemId":"c1","command":"ls","startedAtMs":1}}'"#,
            r#"read -r answer; printf '%s\n' "$answer" >> "$LOG""#,
            r#"printf '%s\n' '{"id":901,"method":"item/commandExecution/requestApproval","params":{"turnId":"turn-1","itemId":"c1","command":"ls","startedAtMs":1}}'"#,
            r#"read -r answer; printf '%s\n' "$answer" >> "$LOG""#,
            r#"printf '%s\n' '{"method":"item/started","params":{"threadId":"thr-1","turnId":"turn-1","item":{"type":"fileChange","id":"f1","changes":[{"path":"/p/a.txt","kind":{"type":"add"},"diff":"x"}],"status":"inProgress"}}}'"#,
            r#"printf '%s\n' '{"id":902,"method":"item/fileChange/requestApproval","params":{"threadId":"thr-1","turnId":"turn-1","itemId":"f1","startedAtMs":2}}'"#,
            // The item starts again with other files, and then is over: the card is for neither.
            r#"printf '%s\n' '{"method":"item/started","params":{"threadId":"thr-1","turnId":"turn-1","item":{"type":"fileChange","id":"f1","changes":[{"path":"/etc/hosts","kind":{"type":"delete"},"diff":"x"}],"status":"inProgress"}}}'"#,
            r#"printf '%s\n' '{"method":"item/completed","params":{"threadId":"thr-1","turnId":"turn-1","item":{"type":"fileChange","id":"f1","changes":[],"status":"declined"}}}'"#,
            TURN_DONE,
        ]
        .join("\n");
        let (mut s, mut rx) = open(&Fake::new(&on_turn), dir.path(), None).await;
        s.send("go").await.unwrap();
        let seen = until_turn_done(&mut rx).await;
        let asked: Vec<&str> = seen.iter().filter_map(|e| match e { UiEvent::PermissionRequested { input, .. } => input["file_path"].as_str(), _ => None }).collect();
        // The first card for the old files, a second for the new, neither left standing.
        assert_eq!(asked, ["Create /p/a.txt", "Delete /etc/hosts"]);
        assert_eq!(seen.iter().filter(|e| matches!(e, UiEvent::PermissionWithdrawn { .. })).count(), 2);
        let got = answers(dir.path());
        assert_eq!((got[0]["id"].clone(), got[0]["result"].clone()), (json!(900), json!({"decision": "decline"})));
        assert_eq!((got[1]["id"].clone(), got[1]["result"].clone()), (json!(901), json!({"decision": "decline"})));
        s.stop().await;
    }

    fn a_page_of_turns(user: &str, said: &str) -> String {
        format!(
            r#"{{"id":"t","status":"completed","items":[{{"type":"userMessage","id":"u","content":[{{"type":"text","text":"{user}"}}]}},{{"type":"agentMessage","id":"a","text":"{said}"}}]}}"#
        )
    }

    #[tokio::test]
    async fn a_workers_conversation_is_read_a_page_of_turns_at_a_time_from_the_running_codex() {
        let dir = tempfile::tempdir().unwrap();
        let turns = format!(
            r#"case "$line" in *'"cursor":"c2"'*) reply "$id" '{{"data":[{}],"nextCursor":null}}' ;; *) reply "$id" '{{"data":[{}],"nextCursor":"c2"}}' ;; esac"#,
            a_page_of_turns("second", "Done."),
            a_page_of_turns("[From the lead] first", "On it.")
        );
        let turns: &'static str = Box::leak(turns.into_boxed_str());
        let mut fake = Fake::new(NOTHING);
        fake.turns = turns;
        let (mut s, _rx) = open(&fake, dir.path(), None).await;
        let events = s.transcript().await.unwrap();
        let lines = crate::orchestra::condense(&events);
        assert_eq!(lines.iter().filter(|l| l.starts_with("lead: ")).count(), 1, "{lines:?}");
        assert!(lines.iter().any(|l| l == "agent: On it.") && lines.iter().any(|l| l == "agent: Done."), "{lines:?}");
        let asked = requests(dir.path(), "thread/turns/list");
        assert_eq!(asked.len(), 2);
        assert_eq!((asked[0]["params"]["threadId"].as_str(), asked[0]["params"]["itemsView"].as_str(), asked[0]["params"]["sortDirection"].as_str()), (Some("thr-1"), Some("full"), Some("asc")));
        assert_eq!(asked[1]["params"]["cursor"], "c2");
        assert!(requests(dir.path(), "thread/read").is_empty());
        s.stop().await;
    }

    #[tokio::test]
    async fn a_codex_that_does_not_list_turns_is_read_whole_and_a_conversation_with_no_turn_yet_reads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let mut fake = Fake::new(NOTHING);
        fake.turns = r#"printf '{"id":%s,"error":{"code":-32601,"message":"thread/turns/list is not supported yet"}}\n' "$id""#;
        fake.read = r#"reply "$id" '{"thread":{"id":"thr-1","turns":[{"id":"t","status":"completed","items":[{"type":"agentMessage","id":"a","text":"Hi."}]}]}}'"#;
        let (mut s, _rx) = open(&fake, dir.path(), None).await;
        let lines = crate::orchestra::condense(&s.transcript().await.unwrap());
        assert!(lines.iter().any(|l| l == "agent: Hi."), "{lines:?}");
        assert_eq!(requests(dir.path(), "thread/read")[0]["params"]["includeTurns"], true);
        s.stop().await;

        // What the real 0.162.1 answers for a conversation before its first message.
        let dir = tempfile::tempdir().unwrap();
        let mut fake = Fake::new(NOTHING);
        fake.turns = r#"printf '{"id":%s,"error":{"code":-32600,"message":"thread thr-1 is not materialized yet; thread/turns/list is unavailable before first user message"}}\n' "$id""#;
        let (mut s, _rx) = open(&fake, dir.path(), None).await;
        assert!(s.transcript().await.unwrap().is_empty());
        // Any other refusal is an error the main agent reads, not an empty conversation.
        let dir = tempfile::tempdir().unwrap();
        let mut fake = Fake::new(NOTHING);
        fake.turns = r#"printf '{"id":%s,"error":{"code":-32603,"message":"disk on fire"}}\n' "$id""#;
        let (mut s2, _rx2) = open(&fake, dir.path(), None).await;
        assert!(s2.transcript().await.unwrap_err().contains("disk on fire"));
        s.stop().await;
        s2.stop().await;
    }

    #[tokio::test]
    async fn interrupt_names_the_running_turn_cancels_waiting_cards_and_keeps_the_process() {
        let dir = tempfile::tempdir().unwrap();
        let on_turn = [
            TURN_STARTED,
            r#"printf '%s\n' '{"id":900,"method":"item/commandExecution/requestApproval","params":{"threadId":"thr-1","turnId":"turn-1","itemId":"c1","command":"sleep 99","startedAtMs":1}}'"#,
            r#"read -r answer; printf '%s\n' "$answer" >> "$LOG""#,
            r#"read -r stop; printf '%s\n' "$stop" >> "$LOG""#,
            r#"id=$(printf '%s' "$stop" | sed -n 's/^{"id":\([0-9]*\),.*/\1/p'); reply "$id" '{}'"#,
            r#"printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thr-1","turn":{"id":"turn-1","status":"interrupted","items":[]}}}'"#,
        ]
        .join("\n");
        let (mut s, mut rx) = open(&Fake::new(&on_turn), dir.path(), None).await;
        s.send("go").await.unwrap();
        let card = match next_matching(&mut rx, |e| matches!(e, UiEvent::PermissionRequested { .. })).await {
            UiEvent::PermissionRequested { request_id, .. } => request_id,
            _ => unreachable!(),
        };
        s.interrupt().await;
        match next_matching(&mut rx, |e| matches!(e, UiEvent::PermissionWithdrawn { .. })).await {
            UiEvent::PermissionWithdrawn { request_id } => assert_eq!(request_id, card),
            _ => unreachable!(),
        }
        match next_matching(&mut rx, |e| matches!(e, UiEvent::TurnDone { .. })).await {
            UiEvent::TurnDone { is_error: true, result: Some(r), .. } => assert_eq!(r, "interrupted"),
            other => panic!("{other:?}"),
        }
        let all = sent(dir.path());
        assert!(all.iter().any(|m| m["id"] == 900 && m["result"] == json!({"decision": "cancel"})));
        let interrupt = all.iter().find(|m| m["method"] == "turn/interrupt").unwrap();
        assert_eq!(interrupt["params"], json!({"threadId": "thr-1", "turnId": "turn-1"}));
        assert!(s.is_running(), "an interrupt must not end the process");
        s.stop().await;
    }

    #[tokio::test]
    async fn a_message_sent_during_a_turn_waits_for_it() {
        let dir = tempfile::tempdir().unwrap();
        let on_turn = [TURN_STARTED, "sleep 0.6", TURN_DONE].join("\n");
        let (mut s, mut rx) = open(&Fake::new(&on_turn), dir.path(), None).await;
        s.send("one").await.unwrap();
        s.send("two").await.unwrap();
        assert_eq!(requests(dir.path(), "turn/start").len(), 1, "the second message started a turn while the first ran");
        next_matching(&mut rx, |e| matches!(e, UiEvent::TurnDone { .. })).await;
        let all = wait_sent(dir.path(), |all| all.iter().filter(|m| m["method"] == "turn/start").count() == 2).await;
        let texts: Vec<&str> = all.iter().filter(|m| m["method"] == "turn/start").map(|m| m["params"]["input"][0]["text"].as_str().unwrap()).collect();
        assert_eq!(texts, ["one", "two"]);
        next_matching(&mut rx, |e| matches!(e, UiEvent::TurnDone { .. })).await;
        s.stop().await;
    }

    #[tokio::test]
    async fn the_model_follows_the_user_and_going_back_to_default_names_the_default() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, mut rx) = open(&Fake::new(&format!("{TURN_STARTED}\n{TURN_DONE}")), dir.path(), None).await;
        s.set_model(Some("gpt-y")).await.unwrap();
        s.send("a").await.unwrap();
        next_matching(&mut rx, |e| matches!(e, UiEvent::TurnDone { .. })).await;
        s.set_model(None).await.unwrap();
        s.send("b").await.unwrap();
        next_matching(&mut rx, |e| matches!(e, UiEvent::TurnDone { .. })).await;
        let models: Vec<Option<String>> = requests(dir.path(), "turn/start").iter().map(|m| m["params"]["model"].as_str().map(String::from)).collect();
        assert_eq!(models, [Some("gpt-y".to_string()), Some("gpt-x".to_string())]);
        s.stop().await;
    }

    #[tokio::test]
    async fn a_codex_that_is_not_signed_in_says_to_run_codex_login_and_starts_no_turn() {
        let dir = tempfile::tempdir().unwrap();
        let mut fake = Fake::new(NOTHING);
        fake.account = r#"{"account":null,"requiresOpenaiAuth":true}"#;
        let (mut s, mut rx) = open(&fake, dir.path(), None).await;
        s.send("hello").await.unwrap();
        match next_matching(&mut rx, |e| matches!(e, UiEvent::TurnDone { .. })).await {
            UiEvent::TurnDone { is_error: true, result: Some(r), auth_hint: true, .. } => assert!(r.contains("codex login"), "{r}"),
            other => panic!("{other:?}"),
        }
        assert!(requests(dir.path(), "turn/start").is_empty());
        // It asked the app-server, and sent nothing like a credential.
        assert!(sent(dir.path()).iter().all(|m| !m.to_string().to_lowercase().contains("token")));
        s.stop().await;
    }

    #[tokio::test]
    async fn a_codex_older_than_the_protocol_lantern_speaks_ends_the_session_with_how_to_update() {
        let dir = tempfile::tempdir().unwrap();
        let mut fake = Fake::new(NOTHING);
        fake.version = "0.120.0";
        let (sink, mut rx) = channel_sink();
        let mut s = Session::spawn(&config(fake.script(dir.path()), dir.path(), None), sink, no_edits()).unwrap();
        s.initialize().await;
        match next_matching(&mut rx, |e| matches!(e, UiEvent::SessionEnded { .. })).await {
            UiEvent::SessionEnded { stderr_tail, code: None } => assert!(stderr_tail.contains("0.120.0") && stderr_tail.contains("0.150.0") && stderr_tail.contains("npm i -g @openai/codex"), "{stderr_tail}"),
            other => panic!("{other:?}"),
        }
        assert!(s.send("hi").await.is_err());
        assert!(requests(dir.path(), "thread/start").is_empty());
        s.stop().await;
    }

    #[tokio::test]
    async fn a_conversation_is_resumed_by_its_id_and_one_that_was_never_written_starts_afresh() {
        let dir = tempfile::tempdir().unwrap();
        let (s, mut rx) = open(&Fake::new(NOTHING), dir.path(), Some("thr-old")).await;
        match next_matching(&mut rx, |e| matches!(e, UiEvent::SessionStarted { .. })).await {
            UiEvent::SessionStarted { session_id, .. } => assert_eq!(session_id, "thr-resumed"),
            _ => unreachable!(),
        }
        let resume = requests(dir.path(), "thread/resume").remove(0);
        assert_eq!(resume["params"]["threadId"], "thr-old");
        assert_eq!(resume["params"]["approvalPolicy"], "on-request");
        assert!(resume["params"]["developerInstructions"].is_string());
        // excludeTurns needs the experimental API on older Codex: never sent.
        assert!(resume["params"].get("excludeTurns").is_none());
        s.stop().await;

        let dir = tempfile::tempdir().unwrap();
        let mut fake = Fake::new(NOTHING);
        fake.resume = r#"printf '{"id":%s,"error":{"code":-32600,"message":"no rollout found for thread id thr-old"}}\n' "$id""#;
        let (s, mut rx) = open(&fake, dir.path(), Some("thr-old")).await;
        match next_matching(&mut rx, |e| matches!(e, UiEvent::SessionStarted { .. })).await {
            UiEvent::SessionStarted { session_id, .. } => assert_eq!(session_id, "thr-1"),
            _ => unreachable!(),
        }
        assert_eq!(requests(dir.path(), "thread/start").len(), 1);
        s.stop().await;

        // Any other trouble resuming is not hidden behind a new conversation.
        let dir = tempfile::tempdir().unwrap();
        let mut fake = Fake::new(NOTHING);
        fake.resume = r#"printf '{"id":%s,"error":{"code":-32600,"message":"database is locked"}}\n' "$id""#;
        let (sink, mut rx) = channel_sink();
        let mut s = Session::spawn(&config(fake.script(dir.path()), dir.path(), Some("thr-old")), sink, no_edits()).unwrap();
        s.initialize().await;
        match next_matching(&mut rx, |e| matches!(e, UiEvent::SessionEnded { .. })).await {
            UiEvent::SessionEnded { stderr_tail, .. } => assert!(stderr_tail.contains("database is locked"), "{stderr_tail}"),
            _ => unreachable!(),
        }
        s.stop().await;
    }

    #[tokio::test]
    async fn requests_lantern_does_not_handle_are_refused_at_once_and_tokens_are_never_given() {
        let dir = tempfile::tempdir().unwrap();
        let on_turn = [
            TURN_STARTED,
            r#"printf '%s\n' '{"id":910,"method":"item/tool/requestUserInput","params":{"threadId":"thr-1","turnId":"turn-1","itemId":"q","questions":[]}}'"#,
            r#"printf '%s\n' '{"id":911,"method":"account/chatgptAuthTokens/refresh","params":{"reason":"unauthorized"}}'"#,
            TURN_DONE,
        ]
        .join("\n");
        let (mut s, mut rx) = open(&Fake::new(&on_turn), dir.path(), None).await;
        s.send("go").await.unwrap();
        next_matching(&mut rx, |e| matches!(e, UiEvent::TurnDone { .. })).await;
        let all = wait_sent(dir.path(), |all| all.iter().filter(|m| m.get("error").is_some()).count() == 2).await;
        for id in [910, 911] {
            let reply = all.iter().find(|m| m["id"] == id).unwrap();
            assert!(reply.get("result").is_none() && reply["error"]["code"] == -32601, "{reply}");
        }
        // No card was raised for them.
        assert!(rx.try_recv().is_err());
        s.stop().await;
    }

    #[tokio::test]
    async fn a_codex_that_dies_mid_turn_ends_the_session_and_takes_its_cards_off_the_window() {
        let dir = tempfile::tempdir().unwrap();
        let on_turn = [
            TURN_STARTED,
            r#"printf '%s\n' '{"id":900,"method":"item/commandExecution/requestApproval","params":{"threadId":"thr-1","turnId":"turn-1","itemId":"c1","command":"x","startedAtMs":1}}'"#,
            "echo 'ERROR: the model fell over' >&2",
            "exit 3",
        ]
        .join("\n");
        let (mut s, mut rx) = open(&Fake::new(&on_turn), dir.path(), None).await;
        s.send("go").await.unwrap();
        let card = match next_matching(&mut rx, |e| matches!(e, UiEvent::PermissionRequested { .. })).await {
            UiEvent::PermissionRequested { request_id, .. } => request_id,
            _ => unreachable!(),
        };
        match next_matching(&mut rx, |e| matches!(e, UiEvent::PermissionWithdrawn { .. })).await {
            UiEvent::PermissionWithdrawn { request_id } => assert_eq!(request_id, card),
            _ => unreachable!(),
        }
        match next_matching(&mut rx, |e| matches!(e, UiEvent::SessionEnded { .. })).await {
            UiEvent::SessionEnded { code, stderr_tail } => {
                assert_eq!(code, Some(3));
                assert!(stderr_tail.contains("the model fell over"));
            }
            _ => unreachable!(),
        }
        assert!(!s.is_running());
        assert!(s.send("again").await.is_err() || !s.is_running());
        s.stop().await;
    }

    #[tokio::test]
    async fn stopping_closes_its_input_and_says_nothing_more() {
        let dir = tempfile::tempdir().unwrap();
        let (s, mut rx) = open(&Fake::new(NOTHING), dir.path(), None).await;
        let started = std::time::Instant::now();
        s.stop().await;
        assert!(started.elapsed() < Duration::from_secs(5));
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
    async fn a_codex_that_ignores_both_its_input_closing_and_sigterm_is_killed_with_what_it_started() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().display();
        // Answers nothing, ignores SIGTERM, and has started a background command, as a running turn would have.
        let script = dir.path().join("stubborn-codex");
        std::fs::write(&script, format!("#!/bin/sh\ntrap '' TERM\nsleep 30 &\necho $! > {d}/child.txt\nwhile true; do sleep 1; done\n")).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (sink, _rx) = channel_sink();
        let s = Session::spawn(&config(script, dir.path(), None), sink, no_edits()).unwrap();
        let child: libc::pid_t = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some(c) = std::fs::read_to_string(dir.path().join("child.txt")).ok().filter(|c| !c.trim().is_empty()) {
                    return c.trim().parse().unwrap();
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        s.stop().await;
        let gone = tokio::time::timeout(Duration::from_secs(5), async {
            while unsafe { libc::kill(child, 0) } == 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        assert!(gone.is_ok(), "the command outlived codex");
    }

    #[tokio::test]
    async fn a_main_agent_cannot_run_on_codex_yet_and_a_missing_binary_is_a_clear_error() {
        let dir = tempfile::tempdir().unwrap();
        let (sink, _rx) = channel_sink();
        let mut cfg = config(Fake::new(NOTHING).script(dir.path()), dir.path(), None);
        cfg.helper.role = Role::Main;
        let err = Session::spawn(&cfg, sink.clone(), no_edits()).err().unwrap();
        assert!(err.contains("main agent") && err.contains("Claude"), "{err}");
        let err = Session::spawn(&config(dir.path().join("nope"), dir.path(), None), sink, no_edits()).err().unwrap();
        assert!(err.contains("Failed to start"));
    }

    #[tokio::test]
    async fn the_edit_hook_hears_of_a_changed_file_with_what_it_was_before() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "one\nTWO\n").unwrap();
        let change = r#"{"path":"a.txt","kind":{"type":"update","move_path":null},"diff":"@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n"}"#;
        let on_turn = [
            TURN_STARTED,
            &format!(r#"printf '%s\n' '{{"method":"item/completed","params":{{"threadId":"thr-1","turnId":"turn-1","item":{{"type":"fileChange","id":"f1","changes":[{change}],"status":"completed"}}}}}}'"#),
            TURN_DONE,
        ]
        .join("\n");
        let (sink, mut rx) = channel_sink();
        let edits = Arc::new(Mutex::new(Vec::new()));
        let e2 = edits.clone();
        let hook: EditHook = Arc::new(move |p: &str, o: Option<String>| e2.lock().unwrap().push((p.to_string(), o)));
        let mut s = Session::spawn(&config(Fake::new(&on_turn).script(dir.path()), dir.path(), None), sink, hook).unwrap();
        s.initialize().await;
        s.send("edit").await.unwrap();
        next_matching(&mut rx, |e| matches!(e, UiEvent::TurnDone { .. })).await;
        assert_eq!(*edits.lock().unwrap(), vec![(dir.path().join("a.txt").display().to_string(), Some("one\ntwo\n".to_string()))]);
        s.stop().await;
    }
}
