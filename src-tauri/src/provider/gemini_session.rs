//! A running ACP agent of Google's: `gemini --acp` (Gemini CLI) or `agy acp` (Antigravity CLI), see `AcpAgent`. The Agent
//! Client Protocol is JSON-RPC over stdio, one JSON object per line. Requests Lantern makes get their reply by id; the agent's
//! `session/update` notifications become `UiEvent`s (gemini_events); its `session/request_permission` requests become the
//! same Allow/Deny cards Claude's do, answered in the JSON-RPC reply.
//!
//! Signing in is the user's own (`gemini` or `agy` in a terminal, or an API key in their environment). Lantern never calls
//! the agent's `authenticate`, never reads or sends a credential, and says so when a session can't be opened for want of one.
//! It also advertises no file or terminal service, so the agent reads, writes and runs things itself, in the chat's folder,
//! and asks before it does what the chat's mode says to ask about.

use super::claude_session::{next_line, push_tail, signal_group, write_line, STDERR_TAIL_BYTES};
use super::gemini::{version_of, AcpAgent};
use super::gemini_events::{config_model_options, model_options, sign_in_text, signed_out, GeminiMapper};
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

/// How long Gemini has to be quiet before the history it replays to a loaded conversation is over (it sends no end of it), and
/// the longest a chat waits for that.
const REPLAY_QUIET: Duration = if cfg!(test) { Duration::from_millis(150) } else { Duration::from_millis(400) };
const REPLAY_MAX: Duration = Duration::from_secs(8);

/// The protocol version Lantern speaks (ACP's first, which is the one Gemini CLI answers with).
const PROTOCOL_VERSION: u64 = 1;

/// What the agents' approval modes are called, by the ids they take (`session/set_mode`). Lantern's Ask is "edits apply in the
/// folder, the rest asks": Gemini CLI's `autoEdit`, Antigravity's `accept-edits`. Lantern's Auto is Antigravity's `auto`
/// ("edits and safe commands; ask before irreversible actions"); Gemini CLI has none (its `yolo` approves everything, and
/// nothing maps to it). The mode is set at the start of every session and fails the start if it can't be, so a session is
/// never left in whatever mode the user's own settings name.
pub const ASK_MODE: &str = "autoEdit";
const AGY_ASK_MODE: &str = "accept-edits";
const AGY_AUTO_MODE: &str = "auto";
const FALLBACK_MODE: &str = "default";
/// Gemini CLI's read-only mode, for an agent that shares its Lead's folder. Antigravity's `plan` only says to plan first, so
/// a read-only agent there runs in `default`, where everything asks (and Lantern declines it).
const READ_ONLY_MODE: &str = "plan";

/// The approval mode a chat runs in, among those the session offers: `auto` when the chat is on Auto (Antigravity only; a
/// Gemini CLI chat never is, see Capabilities).
pub fn approval_mode(agent: AcpAgent, auto: bool, read_only: bool, offered: &[String]) -> Result<&'static str, String> {
    let has = |id: &str| offered.iter().any(|m| m == id);
    let wanted: &[&'static str] = match (agent, read_only, auto) {
        (AcpAgent::Gemini, true, _) => &[READ_ONLY_MODE, FALLBACK_MODE],
        (AcpAgent::Gemini, false, _) => &[ASK_MODE, FALLBACK_MODE],
        (AcpAgent::Antigravity, true, _) => &[FALLBACK_MODE],
        (AcpAgent::Antigravity, false, true) => &[AGY_AUTO_MODE],
        (AcpAgent::Antigravity, false, false) => &[AGY_ASK_MODE, FALLBACK_MODE],
    };
    wanted.iter().copied().find(|id| has(id)).ok_or_else(|| format!("This {} offers none of the approval modes Lantern can run this chat in. Update it ({}), then restart the chat.", agent.name(), agent.update_hint()))
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
    /// The card as the window was shown it, which a paired phone reads to show and answer it.
    asked: crate::permission::bridge::Pending,
}

#[derive(Default)]
struct State {
    next_id: i64,
    replies: HashMap<i64, Reply>,
    session_id: Option<String>,
    /// A turn is running (or being started): a message sent now waits for it.
    busy: bool,
    /// Messages sent while a turn ran, as the prompt blocks they will be sent as.
    queued: VecDeque<Vec<Value>>,
    /// The model the user chose, for the next turns on; None is the agent's own default.
    model: Option<String>,
    /// The thinking level the user chose (Antigravity's `thought_level`); None is the agent's own.
    effort: Option<String>,
    /// The effort changed since it was last told to the session: told before the next turn.
    effort_changed: bool,
    /// Gemini had no sign-in to use when a session was opened (checked again when a message is sent).
    signed_out: bool,
    turn_started: Option<Instant>,
    pending: HashMap<String, Pending>,
    /// What `initialize` said Gemini's version is, for the session's start event.
    version: Option<String>,
    /// When the last update arrived while no turn ran: the history Gemini replays to a loaded conversation.
    last_replay: Option<Instant>,
    /// That history as the chat shows it, read back when a chat is restored without Lantern's own copy (see `transcript`).
    replayed: Vec<UiEvent>,
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
    /// Maps the replayed history apart from the live turns, so what it remembers of old tool calls never meets a new one's.
    replay_mapper: Arc<Mutex<GeminiMapper>>,
    sink: Sink,
    on_edit: EditHook,
    cwd: String,
    agent: AcpAgent,
    /// The chat is on Auto (Lantern's Auto, or Step by step with its auto-approve): the agent's own auto mode, where it has one.
    auto: bool,
    /// A read-only agent: a mode that asks for everything, and nothing it asks for is allowed.
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
            return Err((-1, format!("{} isn't running.", self.agent.name())));
        }
        match tokio::time::timeout(wait, rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err((-1, format!("{} stopped before it answered.", self.agent.name()))),
            Err(_) => {
                self.state.lock().unwrap().replies.remove(&id);
                Err((-1, format!("{} didn't answer {method} in time.", self.agent.name())))
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
                Ok(r) => {
                    self.let_replay_finish().await;
                    opened = Some((id.to_string(), r));
                }
                Err((code, why)) if signed_out(code, &why) => return Ok(self.not_signed_in()),
                // A conversation that never had a message isn't on disk to load (a chat restarted before its first turn).
                Err((_, why)) if looks_missing(&why) => {}
                Err((_, why)) => return Err(format!("Couldn't resume the {} conversation: {why}", self.agent.name())),
            }
        }
        let (id, reply) = match opened {
            Some(o) => o,
            None => match self.request("session/new", base, OPEN_WAIT).await {
                Ok(r) => (r["sessionId"].as_str().filter(|s| !s.is_empty()).ok_or_else(|| format!("{} opened a conversation without an id.", self.agent.name()))?.to_string(), r),
                Err((code, why)) if signed_out(code, &why) => return Ok(self.not_signed_in()),
                Err((_, why)) => return Err(format!("Couldn't start a {} conversation: {why}", self.agent.name())),
            },
        };
        self.state.lock().unwrap().signed_out = false;

        // The mode first, and the start fails if it can't be set: a session left in whatever mode the user's own settings
        // name could be one that approves everything.
        let offered: Vec<String> = reply["modes"]["availableModes"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str().map(String::from)).collect();
        let name = self.agent.name();
        let mode = approval_mode(self.agent, self.auto, self.read_only, &offered)?;
        if reply["modes"]["currentModeId"].as_str() != Some(mode) {
            self.request("session/set_mode", json!({"sessionId": id, "modeId": mode}), STEP_WAIT).await.map_err(|(_, why)| format!("Couldn't set {name}'s approval mode to {mode}: {why}"))?;
        }
        let (chosen, effort) = {
            let mut s = self.state.lock().unwrap();
            s.effort_changed = false;
            (s.model.clone(), s.effort.clone())
        };
        let model = if self.agent.config_options() {
            // Antigravity: a model and a thinking level, each a config option of the session.
            let (models, current) = config_model_options(&reply["configOptions"]);
            if !models.is_empty() {
                sink(UiEvent::Models { models });
            }
            let mut model = current.unwrap_or_default();
            if let Some(m) = chosen.filter(|m| *m != model) {
                self.set_option(&id, "model", &m).await?;
                model = m;
            }
            if let Some(e) = effort {
                self.set_option(&id, "thought_level", &e).await?;
            }
            model
        } else {
            let models = model_options(&reply["models"]["availableModels"]);
            if !models.is_empty() {
                sink(UiEvent::Models { models });
            }
            let mut model = reply["models"]["currentModelId"].as_str().unwrap_or("").to_string();
            if let Some(m) = chosen.filter(|m| *m != model) {
                self.request("session/set_model", json!({"sessionId": id, "modelId": m}), STEP_WAIT).await.map_err(|(_, why)| format!("Couldn't switch {name} to {m}: {why}"))?;
                model = m;
            }
            model
        };
        let version = {
            let mut s = self.state.lock().unwrap();
            s.session_id = Some(id.clone());
            s.version.clone().unwrap_or_default()
        };
        sink(UiEvent::SessionStarted { session_id: id.clone(), model, cwd: self.cwd.clone(), permission_mode: mode.to_string(), claude_version: format!("{} {version}", self.agent.slug()).trim().to_string() });
        Ok(Some(id))
    }

    /// Sets one of the session's config options (Antigravity's `model` and `thought_level`).
    async fn set_option(&self, session: &str, option: &str, value: &str) -> Result<(), String> {
        let what = if option == "model" { "model" } else { "thinking level" };
        self.request("session/set_config_option", json!({"sessionId": session, "configId": option, "value": value}), STEP_WAIT)
            .await
            .map(|_| ())
            .map_err(|(_, why)| format!("Couldn't set {}'s {what} to {value}: {why}", self.agent.name()))
    }

    /// Gemini replays a loaded conversation's messages as updates, after it has answered the load and with nothing to say where
    /// it ends. They are the chat's own already, and are dropped (see `notification`); the chat is ready once Gemini has been
    /// quiet a moment, so a first message can't be mistaken for part of them.
    async fn let_replay_finish(&self) {
        let began = Instant::now();
        loop {
            tokio::time::sleep(REPLAY_QUIET / 4).await;
            let last = self.state.lock().unwrap().last_replay.unwrap_or(began);
            if last.elapsed() >= REPLAY_QUIET || began.elapsed() >= REPLAY_MAX {
                break;
            }
        }
    }

    /// Gemini has no sign-in: remembered, so a message says so (and how to fix it) instead of failing a turn.
    fn not_signed_in(&self) -> Option<String> {
        self.state.lock().unwrap().signed_out = true;
        None
    }

    /// Starts a turn with `prompt` (its ACP content blocks); the turn runs on its own, and its end is shown when its reply
    /// comes (see `run_turn`).
    fn begin_turn(&self, prompt: Vec<Value>) -> Result<(), String> {
        let session = {
            let mut s = self.state.lock().unwrap();
            s.busy = true;
            s.turn_started = Some(Instant::now());
            s.session_id.clone()
        };
        let Some(session) = session else {
            self.state.lock().unwrap().busy = false;
            return Err(format!("The {} conversation isn't open.", self.agent.name()));
        };
        let ctx = self.clone();
        tokio::spawn(async move { ctx.run_turn(session, prompt).await });
        Ok(())
    }

    async fn run_turn(&self, session: String, prompt: Vec<Value>) {
        // A thinking level chosen since the last turn is told first; one that can't be set says so and the turn goes on as is.
        let effort = {
            let mut s = self.state.lock().unwrap();
            std::mem::take(&mut s.effort_changed).then(|| s.effort.clone()).flatten()
        };
        if let Some(e) = effort.filter(|_| self.agent.config_options()) {
            if let Err(why) = self.set_option(&session, "thought_level", &e).await {
                let id = format!("effort-{}", CARDS.fetch_add(1, Ordering::SeqCst) + 1);
                (self.sink)(UiEvent::ToolStarted { parent: None, tool_use_id: id.clone(), name: "Thinking level".into(), summary: e });
                (self.sink)(UiEvent::ToolFinished { parent: None, tool_use_id: id, is_error: true, output: why });
            }
        }
        let reply = self.request("session/prompt", json!({"sessionId": session, "prompt": prompt}), TURN_WAIT).await;
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
            if let Err(why) = self.begin_turn(next) {
                (self.sink)(UiEvent::TurnDone { is_error: true, result: Some(why), cost_usd: None, tokens: None, session_cost_usd: None, session_tokens: 0, duration_ms: None, auth_hint: false, denied: 0, context_window: None });
            }
        }
    }
}

/// Lantern's effort as Antigravity's thinking level: the same names, but its highest is `xhigh` (Claude's `max` is that).
fn thought_level(effort: &str) -> String {
    if effort == "max" { "xhigh".into() } else { effort.to_string() }
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

/// The agent's command for `cfg`: program, arguments, environment and folder, before it is started. Gemini CLI is a Node
/// script (`#!/usr/bin/env node`): its own folder comes first on the PATH, so the `node` it was installed with is the one
/// that runs it, not whichever a login shell finds first (harmless for Antigravity's single binary).
fn command(cfg: &SessionConfig, agent: AcpAgent) -> Command {
    let mut cmd = Command::new(&cfg.binary);
    cmd.args(agent.args()).current_dir(&cfg.folder);
    let inherited = cfg.path_env.clone().or_else(|| std::env::var("PATH").ok()).unwrap_or_default();
    let path = match cfg.binary.canonicalize().ok().or_else(|| Some(cfg.binary.clone())).and_then(|b| b.parent().map(|p| p.display().to_string())) {
        Some(dir) => format!("{dir}:{inherited}"),
        None => inherited,
    };
    cmd.env("PATH", path);
    // Without this Gemini CLI starts a second copy of itself as a child (to raise Node's memory limit), which is another
    // process to stop and another pile of memory.
    if agent == AcpAgent::Gemini {
        cmd.env("GEMINI_CLI_NO_RELAUNCH", "true");
    }
    cmd
}

impl GeminiSession {
    pub fn spawn(cfg: &SessionConfig, sink: Sink, on_edit: EditHook) -> Result<GeminiSession, String> {
        let agent = AcpAgent::of(cfg.provider);
        let name = agent.name();
        if cfg.helper.role == Role::Main {
            return Err(format!("A main agent can't run on {name} yet: it has no way to call the orchestra's tools. Start the main agent on Claude; its workers can run on {name}."));
        }
        let mut cmd = command(cfg, agent);
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
        let pid = child.id().ok_or_else(|| format!("{name} exited before it started"))?;
        let stdin = Arc::new(AsyncMutex::new(child.stdin.take()));
        let stdout = child.stdout.take().ok_or_else(|| format!("{name} has no stdout pipe"))?;
        let stderr = child.stderr.take().ok_or_else(|| format!("{name} has no stderr pipe"))?;

        let effort = cfg.effort.clone().filter(|_| agent.config_options()).map(|e| thought_level(&e));
        let state = Arc::new(Mutex::new(State { model: cfg.model.clone(), effort, ..State::default() }));
        let stopping = Arc::new(AtomicBool::new(false));
        let cwd = cfg.folder.display().to_string();
        let ctx = Ctx {
            stdin,
            state: state.clone(),
            mapper: Arc::new(Mutex::new(GeminiMapper::for_agent(&cfg.folder, agent))),
            replay_mapper: Arc::new(Mutex::new(GeminiMapper::for_agent(&cfg.folder, agent))),
            sink: sink.clone(),
            on_edit,
            cwd,
            agent,
            auto: cfg.mode == Mode::Auto || (cfg.mode == Mode::Steps && cfg.auto_approve),
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
                    let _ = tx.send(Err((-1, format!("{} stopped before it answered.", ctx.agent.name()))));
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

    pub async fn wait_ready(&self) -> Result<(), String> {
        let mut ready = self.ready.clone();
        let outcome = tokio::time::timeout(READY_WAIT, ready.wait_for(|r| *r != Ready::Starting)).await.map(|r| r.map(|state| state.clone()));
        match outcome {
            Ok(Ok(Ready::Failed(why))) => Err(why),
            Ok(Ok(_)) => Ok(()),
            Ok(Err(_)) => Err(format!("{} stopped before it was ready.", self.ctx.agent.name())),
            Err(_) => Err(format!("{} didn't get ready in time.", self.ctx.agent.name())),
        }
    }

    /// A message from the user: a new turn, or after the running one when there is one (Claude queues the same way).
    pub async fn send(&mut self, text: &str) -> Result<(), String> {
        self.send_with(text, vec![]).await
    }

    /// A message with pictures, as ACP image blocks (`{"type": "image", "mimeType", "data"}`) before the text.
    pub async fn send_with(&mut self, text: &str, images: Vec<Value>) -> Result<(), String> {
        let mut prompt = images;
        prompt.push(json!({"type": "text", "text": text}));
        self.wait_ready().await?;
        // No conversation yet because there was no sign-in: try again, as the user may have signed in since.
        if self.ctx.state.lock().unwrap().session_id.is_none() {
            let sink = self.ctx.sink.clone();
            if self.ctx.open_session(None, &sink).await?.is_none() {
                (self.ctx.sink)(UiEvent::TurnDone { is_error: true, result: Some(sign_in_text(self.ctx.agent, "")), cost_usd: None, tokens: None, session_cost_usd: None, session_tokens: 0, duration_ms: None, auth_hint: true, denied: 0, context_window: None });
                return Ok(());
            }
        }
        {
            let mut s = self.ctx.state.lock().unwrap();
            if s.busy {
                s.queued.push_back(prompt);
                return Ok(());
            }
        }
        self.ctx.begin_turn(prompt)
    }

    /// Whether this agent takes pictures: Antigravity says so (`promptCapabilities.image`); Gemini CLI isn't wired for them.
    pub fn takes_images(&self) -> bool {
        self.ctx.agent == AcpAgent::Antigravity
    }

    /// The thinking level from the next turn on (Antigravity's `thought_level`); None leaves the agent's own. False for an
    /// agent with no thinking level, whose chat then restarts to take it.
    pub fn set_effort(&mut self, effort: Option<&str>) -> bool {
        if !self.ctx.agent.config_options() {
            return false;
        }
        let mut s = self.ctx.state.lock().unwrap();
        s.effort = effort.map(thought_level);
        s.effort_changed = s.effort.is_some();
        true
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

    /// The conversation so far, as Gemini replayed it when this session loaded it (a new conversation has none). Lantern's
    /// own copy of a chat is read first; this is for one it doesn't have.
    pub async fn transcript(&self) -> Result<Vec<UiEvent>, String> {
        self.wait_ready().await?;
        let rest = self.ctx.replay_mapper.lock().unwrap().end_replay();
        let mut s = self.ctx.state.lock().unwrap();
        s.replayed.extend(rest);
        Ok(s.replayed.clone())
    }

    /// The model from the next turn on; None goes back to the agent's own.
    pub async fn set_model(&mut self, model: Option<&str>) -> Result<(), String> {
        let session = {
            let mut s = self.ctx.state.lock().unwrap();
            s.model = model.map(String::from);
            s.session_id.clone()
        };
        // Told to the running session at once; one that isn't open yet takes it when it is.
        if let (Some(session), Some(model)) = (session, model) {
            if self.ctx.agent.config_options() {
                self.ctx.set_option(&session, "model", model).await?;
            } else {
                self.ctx.request("session/set_model", json!({"sessionId": session, "modelId": model}), STEP_WAIT).await.map_err(|(_, why)| format!("Couldn't switch {} to {model}: {why}", self.ctx.agent.name()))?;
            }
        }
        Ok(())
    }

    /// The cards waiting for an answer, as a paired phone reads them.
    pub fn pending_permissions(&self) -> Vec<crate::permission::bridge::Pending> {
        self.ctx.state.lock().unwrap().pending.values().map(|p| p.asked.clone()).collect()
    }

    /// The user's answer to a card. False when there is no such card (it was answered, or it isn't this agent's).
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
    let name = ctx.agent.name();
    let init = ctx
        .request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                // No file or terminal service: the agent reads, writes and runs things itself, in the chat's folder.
                "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false},
                "clientInfo": {"name": "lantern", "title": "Lantern", "version": env!("CARGO_PKG_VERSION")},
            }),
            OPEN_WAIT,
        )
        .await
        .map_err(|(_, e)| format!("{name}'s ACP agent didn't start ({e}). Is this a current {name}? Update it ({}), then restart the chat.", ctx.agent.update_hint()))?;
    let version = init["agentInfo"]["version"].as_str().map(String::from);
    if let Some(v) = version.as_deref().and_then(version_of) {
        if v < ctx.agent.min_version() {
            let (a, b, c) = ctx.agent.min_version();
            return Err(format!("This {name} ({}.{}.{}) is older than the {a}.{b}.{c} Lantern needs. Update it ({}), then restart the chat.", v.0, v.1, v.2, ctx.agent.update_hint()));
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
        Some(e) => Err((e["code"].as_i64().unwrap_or(-1), e["message"].as_str().map(String::from).unwrap_or_else(|| format!("{} refused the request.", ctx.agent.name())))),
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
            let request_id = format!("{}-{}", ctx.agent.slug(), CARDS.fetch_add(1, Ordering::SeqCst) + 1);
            let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
            let asked = crate::permission::bridge::Pending { request_id: request_id.clone(), tool_name: a.tool_name.clone(), input: a.input.clone(), at };
            ctx.state.lock().unwrap().pending.insert(request_id.clone(), Pending { rpc_id: id.clone(), allow: a.allow, reject: a.reject, asked });
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
    (ctx.sink)(UiEvent::ToolFinished { parent: None, tool_use_id: id, is_error: true, output: format!("Lantern declined a request from {} because {why}. Nothing was run, changed or allowed.", ctx.agent.name()) });
}

/// A notification from the agent. What it says while no turn runs is the conversation replayed to a loaded session (the chat
/// has it already), and isn't shown.
fn notification(ctx: &Ctx, method: &str, params: &Value) {
    if method != "session/update" {
        return;
    }
    {
        let mut s = ctx.state.lock().unwrap();
        if !s.busy {
            s.last_replay = Some(Instant::now());
            if params["sessionId"].as_str() == s.session_id.as_deref() || s.session_id.is_none() {
                let events = ctx.replay_mapper.lock().unwrap().replay(&params["update"]);
                s.replayed.extend(events);
            }
            return;
        }
        if params["sessionId"].as_str() != s.session_id.as_deref() {
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
        let g = AcpAgent::Gemini;
        let all = offered(&["default", "autoEdit", "yolo", "plan"]);
        for auto in [false, true] {
            assert_eq!(approval_mode(g, auto, false, &all).unwrap(), "autoEdit");
            assert_eq!(approval_mode(g, auto, true, &all).unwrap(), "plan");
        }
        // Without autoEdit the plain mode (which asks for edits too); without plan, a read-only agent asks, and is declined.
        assert_eq!(approval_mode(g, false, false, &offered(&["default", "yolo"])).unwrap(), "default");
        assert_eq!(approval_mode(g, false, true, &offered(&["default", "autoEdit", "yolo"])).unwrap(), "default");
        // A Gemini that offers nothing but yolo is not one a chat can run on.
        assert!(approval_mode(g, false, false, &offered(&["yolo"])).is_err());
        assert!(approval_mode(g, false, false, &[]).is_err());
    }

    #[test]
    fn antigravity_runs_ask_as_accept_edits_auto_as_its_auto_and_a_read_only_agent_where_everything_asks() {
        let a = AcpAgent::Antigravity;
        // What agy 1.5.15 offers.
        let all = offered(&["default", "accept-edits", "auto", "plan"]);
        assert_eq!(approval_mode(a, false, false, &all).unwrap(), "accept-edits");
        assert_eq!(approval_mode(a, true, false, &all).unwrap(), "auto");
        // Its plan mode only says to plan first: a read-only agent is in default, where it asks (and Lantern declines).
        assert_eq!(approval_mode(a, false, true, &all).unwrap(), "default");
        assert_eq!(approval_mode(a, true, true, &all).unwrap(), "default");
        // Auto without its auto mode doesn't quietly become something else: the chat doesn't start.
        assert!(approval_mode(a, true, false, &offered(&["default", "accept-edits"])).unwrap_err().contains("agy update"));
        assert_eq!(approval_mode(a, false, false, &offered(&["default"])).unwrap(), "default");
    }

    #[test]
    fn a_decision_selects_the_option_for_this_one_action_or_refuses_it() {
        let asked = crate::permission::bridge::Pending { request_id: "gemini-1".into(), tool_name: "Bash".into(), input: json!({}), at: 0 };
        let both = Pending { rpc_id: json!(7), allow: "proceed_once".into(), reject: Some("cancel".into()), asked: asked.clone() };
        assert_eq!(outcome(&both, true), json!({"outcome": {"outcome": "selected", "optionId": "proceed_once"}}));
        assert_eq!(outcome(&both, false), json!({"outcome": {"outcome": "selected", "optionId": "cancel"}}));
        let only_allow = Pending { rpc_id: json!(7), allow: "proceed_once".into(), reject: None, asked };
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

#[cfg(test)]
mod fake_server_tests {
    use super::*;
    use crate::args::HelperConfig;
    use crate::provider::ProviderId;
    use crate::session::Session;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use tokio::sync::mpsc;

    const NOTHING: &str = ":";
    const END_TURN: &str = r#"reply "$id" '{"stopReason":"end_turn","usage":{"totalTokens":42}}'"#;
    /// What `agy acp` 1.5.15 answered `session/new` with (trimmed): its four modes, and its model and thinking level as config options.
    const AGY_NEW: &str = r#"reply "$id" '{"sessionId":"sess-1","modes":{"currentModeId":"default","availableModes":[{"id":"default"},{"id":"accept-edits"},{"id":"auto"},{"id":"plan"}]},"configOptions":[{"id":"model","type":"select","currentValue":"gemini-4-neon","options":[{"value":"gemini-4-neon","name":"Gemini 4 Neon"},{"value":"gemini-3.8-flash","name":"Gemini 3.8 Flash"}]},{"id":"thought_level","type":"select","currentValue":"high","options":[{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"},{"value":"xhigh","name":"Extra"}]}]}'"#;
    const NEW: &str = r#"reply "$id" '{"sessionId":"sess-1","modes":{"availableModes":[{"id":"default"},{"id":"autoEdit"},{"id":"yolo"},{"id":"plan"}],"currentModeId":"yolo"},"models":{"availableModels":[{"modelId":"auto","name":"Auto"},{"modelId":"gemini-2.5-pro","name":"Gemini 2.5 Pro"}],"currentModelId":"auto"}}'"#;

    /// A stand-in for `gemini --acp`: a shell script that answers what Lantern sends, and logs it.
    struct Fake {
        version: &'static str,
        new: &'static str,
        load: &'static str,
        set_mode: &'static str,
        /// What it does when a prompt arrives (shell, given `$id`): the turn's own updates and its reply.
        on_prompt: String,
        /// It starts a background command, and stays alive after its input closes (a Gemini that won't stop).
        hangs: bool,
        /// Which agent it stands in for.
        provider: ProviderId,
    }

    impl Fake {
        fn new(on_prompt: &str) -> Fake {
            Fake { version: "0.65.0", new: NEW, load: NEW, set_mode: r#"reply "$id" 'null'"#, on_prompt: on_prompt.to_string(), hangs: false, provider: ProviderId::Gemini }
        }

        /// A stand-in for `agy acp`, answering as Antigravity CLI 1.5.15 did when probed.
        fn agy(on_prompt: &str) -> Fake {
            Fake { version: "1.5.15", new: AGY_NEW, load: AGY_NEW, provider: ProviderId::Antigravity, ..Fake::new(on_prompt) }
        }

        fn script(&self, dir: &Path) -> PathBuf {
            let body = r#"#!/bin/sh
LOG=@DIR@/stdin.txt
reply() { printf '{"jsonrpc":"2.0","id":%s,"result":%s}\n' "$1" "$2"; }
fail() { printf '{"jsonrpc":"2.0","id":%s,"error":{"code":%s,"message":"%s"}}\n' "$1" "$2" "$3"; }
say() { printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":%s}}\n' "$1"; }
@START@
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG"
  id=$(printf '%s' "$line" | sed -n 's/^{"id":\([0-9]*\),.*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) reply "$id" '{"protocolVersion":1,"authMethods":[],"agentInfo":{"name":"@AGENT@","version":"@VERSION@"},"agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":true}}}' ;;
    *'"method":"session/new"'*) @NEW@ ;;
    *'"method":"session/load"'*) @LOAD@ ;;
    *'"method":"session/set_mode"'*) @SET_MODE@ ;;
    *'"method":"session/set_model"'*) reply "$id" 'null' ;;
    *'"method":"session/set_config_option"'*) reply "$id" '{"configOptions":[]}' ;;
    *'"method":"session/prompt"'*)
@ON_PROMPT@
      ;;
  esac
done
@END@
"#;
            let start = if self.hangs { format!("sleep 300 &\necho $! > {}/child.pid", dir.display()) } else { String::new() };
            let end = if self.hangs { "sleep 300" } else { "" };
            let body = body.replace("@DIR@", &dir.display().to_string()).replace("@VERSION@", self.version).replace("@AGENT@", if self.provider == ProviderId::Antigravity { "Antigravity ACP Server" } else { "gemini-cli" }).replace("@NEW@", self.new).replace("@LOAD@", self.load).replace("@SET_MODE@", self.set_mode).replace("@ON_PROMPT@", &self.on_prompt).replace("@START@", &start).replace("@END@", end);
            let p = dir.join("fake-gemini");
            std::fs::write(&p, body).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p
        }
    }

    fn config(binary: PathBuf, folder: &Path, resume: Option<&str>, role: Role) -> SessionConfig {
        SessionConfig {
            provider: ProviderId::Gemini,
            binary,
            folder: folder.to_path_buf(),
            mode: Mode::Ask,
            auto_approve: false,
            resume: resume.map(String::from),
            model: None,
            effort: None,
            advisor: None,
            subagent_model: None,
            plugins_off: false,
            helper: HelperConfig { exe: "/usr/bin/true".into(), socket: "/tmp/none.sock".into(), role, providers: vec![], project_notes: None, publish_artifacts: false },
            path_env: None,
            endpoint: None,
            config_dir: None,
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

    async fn open_as(fake: &Fake, dir: &Path, resume: Option<&str>, role: Role) -> (Session, mpsc::UnboundedReceiver<UiEvent>) {
        let (sink, rx) = channel_sink();
        let mut cfg = config(fake.script(dir), dir, resume, role);
        cfg.provider = fake.provider;
        let mut s = Session::spawn(&cfg, sink, no_edits()).unwrap();
        s.initialize().await;
        (s, rx)
    }

    async fn open(fake: &Fake, dir: &Path) -> (Session, mpsc::UnboundedReceiver<UiEvent>) {
        open_as(fake, dir, None, Role::Normal).await
    }

    /// A tool call that waits for the user: the agent asks, then reads the answer from its input and finishes the call.
    fn asks_to_run(command: &str) -> String {
        format!(
            r#"say '{{"sessionUpdate":"tool_call","toolCallId":"t1","status":"pending","title":"{command}","kind":"execute","content":[]}}'
printf '%s\n' '{{"jsonrpc":"2.0","id":900,"method":"session/request_permission","params":{{"sessionId":"sess-1","options":[{{"optionId":"proceed_always","name":"Allow for this session","kind":"allow_always"}},{{"optionId":"proceed_once","name":"Allow","kind":"allow_once"}},{{"optionId":"cancel","name":"Reject","kind":"reject_once"}}],"toolCall":{{"toolCallId":"t1","status":"pending","title":"{command}","kind":"execute","content":[]}}}}}}'
IFS= read -r answer
printf '%s\n' "$answer" >> "$LOG"
case "$answer" in
  *proceed_once*) say '{{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed","content":[{{"type":"content","content":{{"type":"text","text":"done"}}}}]}}' ;;
  *) say '{{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"failed","content":[{{"type":"content","content":{{"type":"text","text":"Tool \"run_shell_command\" was canceled by the user."}}}}]}}' ;;
esac
{END_TURN}"#
        )
    }

    /// An Antigravity card as `agy acp` 1.5.15 sent it: a string id, the command in `rawInput.CommandLine`, only Allow and
    /// Deny; a denial comes back as "user denied permission".
    const AGY_ASKS: &str = r#"say '{"sessionUpdate":"tool_call","toolCallId":"c1","name":"run_command","status":"pending","kind":"execute","title":"rm -rf build","rawInput":{"CommandLine":"rm -rf build","toolSummary":"clean"}}'
printf '%s\n' '{"jsonrpc":"2.0","id":"1","method":"session/request_permission","params":{"sessionId":"sess-1","toolCall":{"toolCallId":"c1","name":"run_command","status":"pending","kind":"execute","title":"rm -rf build","rawInput":{"CommandLine":"rm -rf build","toolSummary":"clean"}},"options":[{"optionId":"allow","name":"Allow","kind":"allow_once"},{"optionId":"deny","name":"Deny","kind":"reject_once"}]}}'
IFS= read -r answer
printf '%s\n' "$answer" >> "$LOG"
case "$answer" in
  *'"optionId":"allow"'*) say '{"sessionUpdate":"tool_call_update","toolCallId":"c1","status":"completed","kind":"execute","content":[{"type":"content","content":{"type":"text","text":"done"}}]}' ;;
  *) say '{"sessionUpdate":"tool_call_update","toolCallId":"c1","status":"failed","kind":"execute","rawOutput":"permission check failed for unsandboxed \"rm -rf build\": user denied permission to run command","content":[{"type":"content","content":{"type":"text","text":"permission check failed: user denied permission to run command"}}]}' ;;
esac
reply "$id" '{"stopReason":"end_turn","usage":{"totalTokens":42}}'"#;

    async fn open_agy(fake: &Fake, dir: &Path, change: impl FnOnce(&mut SessionConfig)) -> (Session, mpsc::UnboundedReceiver<UiEvent>) {
        let (sink, rx) = channel_sink();
        let mut cfg = config(fake.script(dir), dir, None, Role::Normal);
        cfg.provider = ProviderId::Antigravity;
        change(&mut cfg);
        let mut s = Session::spawn(&cfg, sink, no_edits()).unwrap();
        s.initialize().await;
        (s, rx)
    }

    #[tokio::test]
    async fn an_antigravity_chat_on_auto_runs_in_its_auto_mode_on_the_model_and_thinking_level_chosen() {
        let dir = tempfile::tempdir().unwrap();
        let (s, mut rx) = open_agy(&Fake::agy(NOTHING), dir.path(), |c| {
            c.mode = Mode::Auto;
            c.model = Some("gemini-3.8-flash".into());
            c.effort = Some("max".into());
        })
        .await;
        let models = match next_matching(&mut rx, |e| matches!(e, UiEvent::Models { .. })).await {
            UiEvent::Models { models } => models,
            _ => unreachable!(),
        };
        assert_eq!(models.iter().map(|m| m.value.as_str()).collect::<Vec<_>>(), ["gemini-4-neon", "gemini-3.8-flash"]);
        assert_eq!(models[0].effort_levels, ["low", "medium", "high", "xhigh"]);
        match next_matching(&mut rx, |e| matches!(e, UiEvent::SessionStarted { .. })).await {
            UiEvent::SessionStarted { model, permission_mode, claude_version, .. } => {
                assert_eq!((model.as_str(), permission_mode.as_str(), claude_version.as_str()), ("gemini-3.8-flash", "auto", "antigravity 1.5.15"));
            }
            _ => unreachable!(),
        }
        assert_eq!(requests(dir.path(), "session/set_mode")[0]["params"]["modeId"], "auto");
        let options: Vec<(String, String)> = requests(dir.path(), "session/set_config_option").iter().map(|r| (r["params"]["configId"].as_str().unwrap().to_string(), r["params"]["value"].as_str().unwrap().to_string())).collect();
        // Claude's `max` is Antigravity's `xhigh`; `session/set_model` is Gemini CLI's, not used here.
        assert_eq!(options, [("model".to_string(), "gemini-3.8-flash".to_string()), ("thought_level".to_string(), "xhigh".to_string())]);
        assert!(requests(dir.path(), "session/set_model").is_empty());
        s.stop().await;
    }

    #[tokio::test]
    async fn an_antigravity_chat_on_ask_runs_in_accept_edits_and_its_command_card_is_answered_by_its_own_string_id() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, mut rx) = open_agy(&Fake::agy(AGY_ASKS), dir.path(), |_| {}).await;
        assert_eq!(requests(dir.path(), "session/set_mode")[0]["params"]["modeId"], "accept-edits");
        s.send("clean up").await.unwrap();
        let (request_id, tool, input) = match next_matching(&mut rx, |e| matches!(e, UiEvent::PermissionRequested { .. })).await {
            UiEvent::PermissionRequested { request_id, tool_name, input } => (request_id, tool_name, input),
            _ => unreachable!(),
        };
        assert!(request_id.starts_with("antigravity-"), "{request_id}");
        assert_eq!((tool.as_str(), input["command"].as_str(), input["provider"].as_str()), ("Bash", Some("rm -rf build"), Some("antigravity")));
        // The command came from its own field and no other folder was named: it runs in the chat's.
        assert_eq!(input["cwd"].as_str(), Some(dir.path().display().to_string().as_str()));
        // A phone sees it too.
        assert_eq!(s.pending_permissions().len(), 1);
        assert!(s.respond_permission(&request_id, false).await);
        let all = wait_sent(dir.path(), |all| all.iter().any(|m| m.get("result").is_some() && m["id"] == "1")).await;
        let answer = all.iter().find(|m| m["id"] == "1").unwrap();
        assert_eq!(answer["result"], json!({"outcome": {"outcome": "selected", "optionId": "deny"}}));
        match next_matching(&mut rx, |e| matches!(e, UiEvent::ToolFinished { .. })).await {
            UiEvent::ToolFinished { is_error, output, .. } => assert!(is_error && output == "Declined.", "{output}"),
            _ => unreachable!(),
        }
        assert!(matches!(next_matching(&mut rx, |e| matches!(e, UiEvent::TurnDone { .. })).await, UiEvent::TurnDone { denied: 1, .. }));
        s.stop().await;
    }

    #[tokio::test]
    async fn an_antigravity_chat_sends_pictures_as_image_blocks_and_a_new_thinking_level_before_the_next_turn() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, mut rx) = open_agy(&Fake::agy(END_TURN), dir.path(), |_| {}).await;
        assert!(s.set_effort(Some("low")));
        s.send_with("what is this?", vec![crate::session::InputImage { media_type: "image/png".into(), data: "AAAA".into() }]).await.unwrap();
        next_matching(&mut rx, |e| matches!(e, UiEvent::TurnDone { .. })).await;
        let all = sent(dir.path());
        let level = all.iter().position(|m| m["method"] == "session/set_config_option" && m["params"]["value"] == "low").expect("the level was told");
        let prompt = all.iter().position(|m| m["method"] == "session/prompt").unwrap();
        assert!(level < prompt, "the level is told before the turn");
        assert_eq!(all[prompt]["params"]["prompt"], json!([{"type": "image", "mimeType": "image/png", "data": "AAAA"}, {"type": "text", "text": "what is this?"}]));
        s.stop().await;
    }

    #[tokio::test]
    async fn a_gemini_cli_chat_still_refuses_pictures_and_has_no_thinking_level() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, _rx) = open(&Fake::new(END_TURN), dir.path()).await;
        assert!(!s.set_effort(Some("low")));
        let err = s.send_with("x", vec![crate::session::InputImage { media_type: "image/png".into(), data: "AAAA".into() }]).await.unwrap_err();
        assert!(err.contains("can't take pictures"));
        s.stop().await;
    }

    #[tokio::test]
    async fn an_antigravity_older_than_its_acp_server_is_refused_with_how_to_update() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake { version: "1.4.9", ..Fake::agy(NOTHING) };
        let (_s, mut rx) = open_agy(&fake, dir.path(), |_| {}).await;
        match next_matching(&mut rx, |e| matches!(e, UiEvent::SessionEnded { .. })).await {
            UiEvent::SessionEnded { stderr_tail, .. } => assert!(stderr_tail.contains("This Antigravity (1.4.9) is older than the 1.5.0") && stderr_tail.contains("agy update"), "{stderr_tail}"),
            _ => unreachable!(),
        }
    }

    /// Against the real Antigravity CLI (`~/.local/bin/agy`, signed in), in an empty scratch folder: the handshake, the mode,
    /// one turn that asks to run a command, and the card DENIED, so nothing runs. Uses one small turn of the user's plan.
    /// Run with `cargo test --lib real_agy -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn real_agy_opens_in_accept_edits_raises_a_command_card_and_takes_a_denial() {
        let agy = std::env::var("HOME").map(|h| PathBuf::from(h).join(".local/bin/agy")).unwrap();
        assert!(agy.exists(), "agy isn't installed at {}", agy.display());
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = config(agy, dir.path(), None, Role::Normal);
        cfg.provider = ProviderId::Antigravity;
        cfg.effort = Some("low".into());
        let (sink, mut rx) = channel_sink();
        let mut s = Session::spawn(&cfg, sink, no_edits()).unwrap();
        s.initialize().await;
        let wait = |secs| Duration::from_secs(secs);
        let mut events = vec![];
        let started = tokio::time::timeout(wait(60), async {
            loop {
                let ev = rx.recv().await.unwrap();
                events.push(format!("{ev:?}"));
                if let UiEvent::SessionStarted { permission_mode, claude_version, model, .. } = &ev {
                    return (permission_mode.clone(), claude_version.clone(), model.clone());
                }
            }
        })
        .await
        .expect("no SessionStarted");
        println!("started: {started:?}");
        assert_eq!(started.0, "accept-edits");
        assert!(started.1.starts_with("antigravity "));
        s.send("Run the shell command `echo lantern-live-check` and tell me what it printed. If you are not allowed, just say so.").await.unwrap();
        let card = tokio::time::timeout(wait(180), async {
            loop {
                let ev = rx.recv().await.unwrap();
                events.push(format!("{ev:?}"));
                match ev {
                    UiEvent::PermissionRequested { request_id, tool_name, input } => return Some((request_id, tool_name, input)),
                    UiEvent::TurnDone { .. } => return None,
                    _ => {}
                }
            }
        })
        .await
        .expect("the turn neither asked nor ended");
        let (request_id, tool_name, input) = card.unwrap_or_else(|| panic!("no card was raised: {events:#?}"));
        println!("card: {tool_name} {input}");
        assert_eq!(tool_name, "Bash");
        assert!(input["command"].as_str().unwrap_or("").contains("echo lantern-live-check"), "{input}");
        assert_eq!(input["provider"], "antigravity");
        assert!(s.respond_permission(&request_id, false).await);
        let done = tokio::time::timeout(wait(180), async {
            loop {
                let ev = rx.recv().await.unwrap();
                events.push(format!("{ev:?}"));
                if let UiEvent::TurnDone { denied, is_error, tokens, .. } = ev {
                    return (denied, is_error, tokens);
                }
            }
        })
        .await
        .expect("the turn didn't end");
        println!("done: {done:?}\n{events:#?}");
        assert_eq!(done.0, 1, "the denial counts as denied");
        assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none(), "nothing was made in the folder");
        s.stop().await;
    }

    #[tokio::test]
    async fn the_handshake_opens_a_conversation_in_the_mode_lantern_runs_a_chat_in_and_never_signs_in() {
        let dir = tempfile::tempdir().unwrap();
        let (s, mut rx) = open(&Fake::new(NOTHING), dir.path()).await;
        let models = match next_matching(&mut rx, |e| matches!(e, UiEvent::Models { .. })).await {
            UiEvent::Models { models } => models,
            _ => unreachable!(),
        };
        assert_eq!(models.iter().map(|m| m.value.as_str()).collect::<Vec<_>>(), ["auto", "gemini-2.5-pro"]);
        match next_matching(&mut rx, |e| matches!(e, UiEvent::SessionStarted { .. })).await {
            UiEvent::SessionStarted { session_id, model, permission_mode, claude_version, .. } => {
                assert_eq!((session_id.as_str(), model.as_str(), permission_mode.as_str(), claude_version.as_str()), ("sess-1", "auto", "autoEdit", "gemini 0.65.0"));
            }
            _ => unreachable!(),
        }
        assert_eq!(s.session_id().as_deref(), Some("sess-1"));
        let all = sent(dir.path());
        let methods: Vec<&str> = all.iter().filter_map(|m| m["method"].as_str()).collect();
        // It was running in `yolo` (the user's own setting, say): the mode is set before anything else happens.
        assert_eq!(methods, ["initialize", "session/new", "session/set_mode"]);
        assert_eq!(all[0]["params"]["clientCapabilities"], json!({"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false}));
        assert_eq!(all[1]["params"], json!({"cwd": dir.path().display().to_string(), "mcpServers": []}));
        assert_eq!(all[2]["params"], json!({"sessionId": "sess-1", "modeId": "autoEdit"}));
        assert!(requests(dir.path(), "authenticate").is_empty());
        s.stop().await;
    }

    #[tokio::test]
    async fn a_session_that_cannot_be_put_in_a_mode_that_asks_does_not_start() {
        let dir = tempfile::tempdir().unwrap();
        let mut fake = Fake::new(NOTHING);
        fake.set_mode = r#"fail "$id" -32603 "Invalid or unavailable mode""#;
        let (s, mut rx) = open(&fake, dir.path()).await;
        match next_matching(&mut rx, |e| matches!(e, UiEvent::SessionEnded { .. })).await {
            UiEvent::SessionEnded { stderr_tail, .. } => assert!(stderr_tail.contains("Couldn't set Gemini's approval mode to autoEdit"), "{stderr_tail}"),
            _ => unreachable!(),
        }
        assert!(s.session_id().is_none());
    }

    #[tokio::test]
    async fn a_gemini_with_no_sign_in_says_how_to_sign_in_on_the_first_message_and_never_does_it_itself() {
        let dir = tempfile::tempdir().unwrap();
        let mut fake = Fake::new(NOTHING);
        fake.new = r#"fail "$id" -32000 "Authentication required.""#;
        let (mut s, mut rx) = open(&fake, dir.path()).await;
        s.send("hello").await.unwrap();
        match next_matching(&mut rx, |e| matches!(e, UiEvent::TurnDone { .. })).await {
            UiEvent::TurnDone { is_error, auth_hint, result, .. } => {
                assert!(is_error && auth_hint);
                assert!(result.unwrap().contains("Run `gemini` in a terminal"));
            }
            _ => unreachable!(),
        }
        assert!(requests(dir.path(), "authenticate").is_empty());
        assert!(requests(dir.path(), "session/prompt").is_empty());
        s.stop().await;
    }

    #[tokio::test]
    async fn a_turn_streams_its_text_and_ends_with_its_tokens_and_no_dollars() {
        let dir = tempfile::tempdir().unwrap();
        let prompt = format!(r#"say '{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"Hi"}}}}'
{END_TURN}"#);
        let (mut s, mut rx) = open(&Fake::new(&prompt), dir.path()).await;
        s.send("hello").await.unwrap();
        assert!(matches!(next_matching(&mut rx, |e| matches!(e, UiEvent::TextDelta { .. })).await, UiEvent::TextDelta { text, .. } if text == "Hi"));
        assert!(matches!(next_matching(&mut rx, |e| matches!(e, UiEvent::AssistantText { .. })).await, UiEvent::AssistantText { text, .. } if text == "Hi"));
        assert!(matches!(next_matching(&mut rx, |e| matches!(e, UiEvent::TurnDone { .. })).await, UiEvent::TurnDone { is_error: false, tokens: Some(42), cost_usd: None, .. }));
        let prompts = requests(dir.path(), "session/prompt");
        assert_eq!(prompts[0]["params"], json!({"sessionId": "sess-1", "prompt": [{"type": "text", "text": "hello"}]}));
        s.stop().await;
    }

    #[tokio::test]
    async fn a_card_is_answered_with_the_option_for_this_one_action_and_an_allowed_step_runs() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, mut rx) = open(&Fake::new(&asks_to_run("cargo test")), dir.path()).await;
        s.send("run the tests").await.unwrap();
        let (request_id, tool, input) = match next_matching(&mut rx, |e| matches!(e, UiEvent::PermissionRequested { .. })).await {
            UiEvent::PermissionRequested { request_id, tool_name, input } => (request_id, tool_name, input),
            _ => unreachable!(),
        };
        assert_eq!((tool.as_str(), input["command"].as_str(), input["provider"].as_str()), ("Bash", Some("cargo test"), Some("gemini")));
        assert!(s.respond_permission(&request_id, true).await);
        // Answered once: a second answer finds no card.
        assert!(!s.respond_permission(&request_id, true).await);
        assert!(matches!(next_matching(&mut rx, |e| matches!(e, UiEvent::ToolFinished { .. })).await, UiEvent::ToolFinished { is_error: false, output, .. } if output == "done"));
        let all = wait_sent(dir.path(), |all| all.iter().any(|m| m["id"] == 900)).await;
        let answer = all.iter().find(|m| m["id"] == 900).unwrap();
        assert_eq!(answer["result"], json!({"outcome": {"outcome": "selected", "optionId": "proceed_once"}}));
        s.stop().await;
    }

    #[tokio::test]
    async fn a_denied_card_picks_the_reject_option_and_the_step_counts_as_denied() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, mut rx) = open(&Fake::new(&asks_to_run("rm -rf x")), dir.path()).await;
        s.send("clean up").await.unwrap();
        let request_id = match next_matching(&mut rx, |e| matches!(e, UiEvent::PermissionRequested { .. })).await {
            UiEvent::PermissionRequested { request_id, .. } => request_id,
            _ => unreachable!(),
        };
        assert!(s.respond_permission(&request_id, false).await);
        assert!(matches!(next_matching(&mut rx, |e| matches!(e, UiEvent::ToolFinished { .. })).await, UiEvent::ToolFinished { is_error: true, output, .. } if output == "Declined."));
        assert!(matches!(next_matching(&mut rx, |e| matches!(e, UiEvent::TurnDone { .. })).await, UiEvent::TurnDone { denied: 1, .. }));
        let all = wait_sent(dir.path(), |all| all.iter().any(|m| m["id"] == 900)).await;
        assert_eq!(all.iter().find(|m| m["id"] == 900).unwrap()["result"], json!({"outcome": {"outcome": "selected", "optionId": "cancel"}}));
        s.stop().await;
    }

    #[tokio::test]
    async fn stopping_a_turn_takes_its_card_off_answers_it_cancelled_and_tells_gemini_to_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, mut rx) = open(&Fake::new(&asks_to_run("sleep 100")), dir.path()).await;
        s.send("wait").await.unwrap();
        let request_id = match next_matching(&mut rx, |e| matches!(e, UiEvent::PermissionRequested { .. })).await {
            UiEvent::PermissionRequested { request_id, .. } => request_id,
            _ => unreachable!(),
        };
        s.interrupt().await;
        assert!(matches!(next_matching(&mut rx, |e| matches!(e, UiEvent::PermissionWithdrawn { .. })).await, UiEvent::PermissionWithdrawn { request_id: r } if r == request_id));
        let all = wait_sent(dir.path(), |all| all.iter().any(|m| m["method"] == "session/cancel") && all.iter().any(|m| m["id"] == 900)).await;
        assert_eq!(all.iter().find(|m| m["id"] == 900).unwrap()["result"], json!({"outcome": {"outcome": "cancelled"}}));
        assert_eq!(all.iter().find(|m| m["method"] == "session/cancel").unwrap()["params"], json!({"sessionId": "sess-1"}));
        // The card can't be answered afterwards.
        assert!(!s.respond_permission(&request_id, true).await);
        s.stop().await;
    }

    #[tokio::test]
    async fn a_read_only_agent_is_put_in_plan_mode_and_nothing_it_asks_for_is_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let role = Role::Worker { name: "scout".into(), read_only: true };
        let (mut s, mut rx) = open_as(&Fake::new(&asks_to_run("touch x")), dir.path(), None, role).await;
        assert_eq!(requests(dir.path(), "session/set_mode")[0]["params"]["modeId"], "plan");
        s.send("go").await.unwrap();
        // No card: it is declined, said in the chat, and Gemini is answered as cancelled.
        let said = next_matching(&mut rx, |e| matches!(e, UiEvent::ToolFinished { tool_use_id, .. } if tool_use_id.starts_with("declined-"))).await;
        assert!(matches!(said, UiEvent::ToolFinished { is_error: true, output, .. } if output.contains("this agent is read-only")));
        let all = wait_sent(dir.path(), |all| all.iter().any(|m| m["id"] == 900)).await;
        assert_eq!(all.iter().find(|m| m["id"] == 900).unwrap()["result"], json!({"outcome": {"outcome": "cancelled"}}));
        s.stop().await;
    }

    #[tokio::test]
    async fn what_gemini_replays_of_a_loaded_conversation_is_not_shown_and_a_turn_after_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let mut fake = Fake::new(&format!(r#"say '{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"new"}}}}'
{END_TURN}"#));
        fake.load = r#"reply "$id" '{"modes":{"availableModes":[{"id":"autoEdit"}],"currentModeId":"autoEdit"},"models":{"availableModels":[],"currentModelId":"auto"}}'
say '{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"old history"}}'"#;
        let (mut s, mut rx) = open_as(&fake, dir.path(), Some("sess-1"), Role::Normal).await;
        assert_eq!(requests(dir.path(), "session/load")[0]["params"]["sessionId"], "sess-1");
        assert!(requests(dir.path(), "session/new").is_empty());
        // Not shown, but kept: a chat restored without Lantern's own copy reads it back.
        let back = s.transcript().await.unwrap();
        assert!(matches!(back.as_slice(), [UiEvent::AssistantText { text, .. }] if text == "old history"), "{back:?}");
        s.send("next").await.unwrap();
        let mut said = vec![];
        while let UiEvent::TextDelta { text, .. } = next_matching(&mut rx, |e| matches!(e, UiEvent::TextDelta { .. } | UiEvent::TurnDone { .. })).await {
            said.push(text);
        }
        assert_eq!(said, ["new"]);
        s.stop().await;
    }

    #[tokio::test]
    async fn a_conversation_that_is_not_there_is_started_anew_but_one_that_fails_to_load_is_not_papered_over() {
        let dir = tempfile::tempdir().unwrap();
        let mut fake = Fake::new(NOTHING);
        fake.load = r#"fail "$id" -32602 "Session not found: gone""#;
        let (s, _rx) = open_as(&fake, dir.path(), Some("gone"), Role::Normal).await;
        assert_eq!(s.session_id().as_deref(), Some("sess-1"));
        s.stop().await;

        let dir = tempfile::tempdir().unwrap();
        let mut fake = Fake::new(NOTHING);
        fake.load = r#"fail "$id" -32603 "The session file is corrupt""#;
        let (s, mut rx) = open_as(&fake, dir.path(), Some("bad"), Role::Normal).await;
        match next_matching(&mut rx, |e| matches!(e, UiEvent::SessionEnded { .. })).await {
            UiEvent::SessionEnded { stderr_tail, .. } => assert!(stderr_tail.contains("Couldn't resume the Gemini conversation"), "{stderr_tail}"),
            _ => unreachable!(),
        }
        assert!(requests(dir.path(), "session/new").is_empty());
        assert!(s.session_id().is_none());
    }

    #[tokio::test]
    async fn a_gemini_older_than_the_one_this_was_checked_against_is_refused_with_how_to_update() {
        let dir = tempfile::tempdir().unwrap();
        let mut fake = Fake::new(NOTHING);
        fake.version = "0.40.0";
        let (_s, mut rx) = open(&fake, dir.path()).await;
        match next_matching(&mut rx, |e| matches!(e, UiEvent::SessionEnded { .. })).await {
            UiEvent::SessionEnded { stderr_tail, .. } => assert!(stderr_tail.contains("older than the 0.65.0") && stderr_tail.contains("npm i -g @google/gemini-cli"), "{stderr_tail}"),
            _ => unreachable!(),
        }
        assert!(requests(dir.path(), "session/new").is_empty());
    }

    #[tokio::test]
    async fn a_message_sent_while_a_turn_runs_waits_for_it_and_a_model_switch_reaches_the_session() {
        let dir = tempfile::tempdir().unwrap();
        let prompt = format!("sleep 0.3\n{END_TURN}");
        let (mut s, mut rx) = open(&Fake::new(&prompt), dir.path()).await;
        s.send("one").await.unwrap();
        s.send("two").await.unwrap();
        next_matching(&mut rx, |e| matches!(e, UiEvent::TurnDone { .. })).await;
        next_matching(&mut rx, |e| matches!(e, UiEvent::TurnDone { .. })).await;
        let prompts = requests(dir.path(), "session/prompt");
        assert_eq!(prompts.iter().map(|p| p["params"]["prompt"][0]["text"].as_str().unwrap()).collect::<Vec<_>>(), ["one", "two"]);
        s.set_model(Some("gemini-2.5-pro")).await.unwrap();
        assert_eq!(requests(dir.path(), "session/set_model")[0]["params"], json!({"sessionId": "sess-1", "modelId": "gemini-2.5-pro"}));
        s.stop().await;
    }

    #[tokio::test]
    async fn a_chat_that_is_closed_takes_a_gemini_that_will_not_stop_and_what_it_started_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let mut fake = Fake::new(NOTHING);
        fake.hangs = true;
        let (s, _rx) = open(&fake, dir.path()).await;
        let pid: i32 = std::fs::read_to_string(dir.path().join("child.pid")).unwrap().trim().parse().unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, 0, "the command it started is running");
        s.stop().await;
        let gone = tokio::time::timeout(Duration::from_secs(5), async {
            while unsafe { libc::kill(pid, 0) } == 0 {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;
        assert!(gone.is_ok(), "the command it started was left running");
    }
}
