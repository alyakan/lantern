use super::protocol::{BridgeRequest, BridgeResponse};
use super::rules::{self, FolderRules, Rule, Scope};
use crate::ui_event::{Sink, UiEvent};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::OwnedReadHalf;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::oneshot;

/// The longest request line taken: a Write's whole content goes through it.
const MAX_REQUEST: u64 = 32 << 20;
/// How long a connection may take to send its request before it's dropped.
const REQUEST_WAIT: Duration = Duration::from_secs(10);

/// Serves the main agent's orchestra tool calls: (tool, arguments) in; whether it worked, and the text the model reads.
pub type OrchestraHandler = Arc<dyn Fn(String, serde_json::Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = BridgeResponse> + Send>> + Send + Sync>;

/// Serves the network_* tool calls of any chat: (the chat's folder key, tool, arguments) in, as OrchestraHandler answers.
pub type NetworkHandler = Arc<dyn Fn(Option<String>, String, serde_json::Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = BridgeResponse> + Send>> + Send + Sync>;

/// The team's Subagents setting: where the Lead's helpers (its built-in Agent tool) run. A team is on the canvas until the
/// user says otherwise; a chat that isn't a team's Lead never has this asked of it (its subagents run inline).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Subagents {
    /// As agents on the canvas, with a chat each.
    #[default]
    Canvas,
    /// Inline, as Claude Code's own Agent tool runs them.
    Inline,
}

/// What a Lead reads when its Agent call is turned down because the team's Subagents are on the canvas.
pub const CANVAS_REFUSAL: &str = "Not run inline: the team's Subagents setting is the canvas: helpers are agents with a chat of their own. Start this one with spawn_agent instead, using the same task as its brief (isolation \"shared\" if it only reads), then carry on or end your turn; you'll get a note when it finishes a turn.";

/// A prompt waiting for the user's answer, as any client may be shown it (a phone that connects after its card appeared).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Pending {
    pub request_id: String,
    pub tool_name: String,
    pub input: Value,
    /// When it was asked (ms since the epoch).
    pub at: u64,
}

/// A pending prompt and where its answer goes.
struct Waiting {
    tx: oneshot::Sender<BridgeResponse>,
    asked: Pending,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Unix-socket server that turns helper requests into UI permission cards, or answers them by a rule.
pub struct PermissionBridge {
    pub socket_path: PathBuf,
    pending: Mutex<HashMap<String, Waiting>>,
    counter: AtomicU64,
    /// The accept loop, stopped by `close`.
    accept: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// "This chat" rules: kept here, so they last as long as the chat does.
    chat_rules: Mutex<Vec<Rule>>,
    /// The chat's folder, by its rule key (see `rules::folder_key`), once its claude has started in it.
    folder: Mutex<Option<String>>,
    /// The rules for folders, shared by every chat.
    folder_rules: Arc<FolderRules>,
    /// Set only on the main agent's chat: any other chat's orchestra calls are refused.
    orchestra: Mutex<Option<OrchestraHandler>>,
    /// Who may ask anything at all: this chat's own helper (see `CallerAuth`).
    auth: CallerAuth,
    /// Answers the network_* tools (see network.rs); set on every chat.
    network: Mutex<Option<NetworkHandler>>,
    /// The team's Subagents setting, for a chat that is its Lead (see `Subagents`).
    subagents: Mutex<Subagents>,
    /// Set only while this chat's claude runs as a read-only agent: where its git tool runs (see read_git.rs). Every other
    /// chat's git calls are refused, whatever its helper offered.
    read_git: Mutex<Option<crate::read_git::Scope>>,
}

/// Whether the process with this pid, on the other end of the socket, is this chat's own helper. Every request is asked
/// it first: a permission card, an answer to AskUserQuestion, a reproduce request, a network or orchestra call. Who
/// connects is asked of the OS, because anything the helper could be handed to prove itself (a secret in its arguments,
/// its environment or a file) any other process of the user's could read too.
pub type CallerAuth = Arc<dyn Fn(u32) -> bool + Send + Sync>;

/// The helper of the claude whose pid `claude` holds (0: none is running): a process that claude started itself (not
/// through a shell or anything else in between) and that runs `exe`, the program the helper is (`lantern
/// --permission-helper`). A shell's single command can sit as close to claude as a direct child, which is why both are
/// asked. Anything else is refused, whatever it sends.
pub fn helper_of(claude: Arc<std::sync::atomic::AtomicU32>, exe: PathBuf) -> CallerAuth {
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    Arc::new(move |caller| {
        let parent = claude.load(Ordering::SeqCst);
        parent != 0 && crate::process::is_child_of(caller, parent) && crate::process::runs_program(caller, &exe)
    })
}

const NOT_READ_ONLY: &str = "git is only available to a read-only agent: this chat is not one, so it has no git tool.";
const NOT_AUTHORIZED: &str = "Not authorized: only this chat's own Lantern helper may ask.";

impl PermissionBridge {
    /// `auth` says which process may ask (see `CallerAuth`); every other one is refused.
    pub fn start(socket_path: PathBuf, sink: Sink, folder_rules: Arc<FolderRules>, auth: CallerAuth) -> std::io::Result<Arc<Self>> {
        let _ = std::fs::remove_file(&socket_path);
        let std_listener = std::os::unix::net::UnixListener::bind(&socket_path)?;
        // Only this user's processes may connect, whatever the directory's permissions are.
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))?;
        }
        std_listener.set_nonblocking(true)?;
        let bridge = Arc::new(Self {
            socket_path,
            pending: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(0),
            accept: Mutex::new(None),
            chat_rules: Mutex::new(Vec::new()),
            folder: Mutex::new(None),
            folder_rules,
            orchestra: Mutex::new(None),
            auth,
            network: Mutex::new(None),
            subagents: Mutex::new(Subagents::default()),
            read_git: Mutex::new(None),
        });
        let b = bridge.clone();
        let accept = tauri::async_runtime::spawn(async move {
            let Ok(listener) = UnixListener::from_std(std_listener) else { return };
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        let (b, sink) = (b.clone(), sink.clone());
                        tokio::spawn(async move { b.handle(stream, sink).await });
                    }
                    // Usually out of file descriptors: back off and keep serving, or every later prompt is denied.
                    Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
                }
            }
        });
        *bridge.accept.lock().unwrap() = Some(accept);
        Ok(bridge)
    }

    async fn handle(&self, stream: UnixStream, sink: Sink) {
        // Who is calling, as the OS says (None where it can't).
        let peer = stream.peer_cred().ok().and_then(|c| c.pid()).and_then(|p| u32::try_from(p).ok());
        let (read, mut write) = stream.into_split();
        // Anyone else is answered no before a word they send is read: no card, no rule, no tool.
        if !peer.is_some_and(|pid| (self.auth)(pid)) {
            let resp = BridgeResponse { allow: false, message: Some(NOT_AUTHORIZED.into()), updated_input: None, failed: true };
            if let Ok(json) = serde_json::to_string(&resp) {
                let _ = write.write_all(format!("{json}\n").as_bytes()).await;
            }
            return;
        }
        let mut reader = BufReader::new(read.take(MAX_REQUEST));
        let mut line = String::new();
        match tokio::time::timeout(REQUEST_WAIT, reader.read_line(&mut line)).await {
            Ok(Ok(n)) if n > 0 => {}
            _ => return,
        }
        let Ok(req) = serde_json::from_str::<BridgeRequest>(&line) else { return };
        // An orchestra call is no permission prompt: it never becomes a card, and it is answered here.
        if req.orchestra {
            let orchestra = self.orchestra.lock().unwrap().clone();
            let resp = match orchestra {
                Some(handle) => handle(req.tool_name, req.input).await,
                None => BridgeResponse { allow: false, message: Some("This chat is not the Lead of a team.".into()), updated_input: None, failed: false },
            };
            if let Ok(json) = serde_json::to_string(&resp) {
                let _ = write.write_all(format!("{json}\n").as_bytes()).await;
            }
            return;
        }
        // A read-only agent's git call is run here, from its argument list: no shell, no card. Anyone else is refused.
        if req.git {
            let scope = self.read_git.lock().unwrap().clone();
            let resp = match scope {
                Some(scope) if req.tool_name == "git" => {
                    let result = tokio::task::spawn_blocking(move || crate::read_git::call(&scope, &req.input)).await.unwrap_or_else(|e| Err(e.to_string()));
                    let (allow, text) = match result {
                        Ok(text) => (true, text),
                        Err(text) => (false, text),
                    };
                    BridgeResponse { allow, message: Some(text), updated_input: None, failed: false }
                }
                _ => BridgeResponse { allow: false, message: Some(NOT_READ_ONLY.into()), updated_input: None, failed: false },
            };
            if let Ok(json) = serde_json::to_string(&resp) {
                let _ = write.write_all(format!("{json}\n").as_bytes()).await;
            }
            return;
        }
        // A network call reads Network Monitor for this chat's folder: no card either.
        if req.network {
            let handler = self.network.lock().unwrap().clone();
            let resp = match handler {
                Some(handle) => handle(self.folder(), req.tool_name, req.input).await,
                None => BridgeResponse { allow: false, message: Some("Lantern's network tools aren't ready in this chat.".into()), updated_input: None, failed: false },
            };
            if let Ok(json) = serde_json::to_string(&resp) {
                let _ = write.write_all(format!("{json}\n").as_bytes()).await;
            }
            return;
        }
        // A review_target call sets what the Changes pane compares: the window is told, and no card is shown.
        if req.review {
            let resp = match super::helper::ReviewTargetArgs::parse(&req.input) {
                Ok(target) => {
                    let says = target.says();
                    sink(UiEvent::ReviewTarget { pr: target.pr, base: target.base });
                    BridgeResponse { allow: true, message: Some(says), updated_input: None, failed: false }
                }
                Err(e) => BridgeResponse { allow: false, message: Some(e), updated_input: None, failed: false },
            };
            if let Ok(json) = serde_json::to_string(&resp) {
                let _ = write.write_all(format!("{json}\n").as_bytes()).await;
            }
            return;
        }
        // The Lead's helper run inline: answered by the team's Subagents setting, with no card. Only a Lead is ever asked
        // (see build_args), and this bridge is the one that has an orchestra.
        if crate::args::INLINE_AGENT_TOOLS.contains(&req.tool_name.as_str()) && self.orchestra.lock().unwrap().is_some() {
            let resp = match self.subagents() {
                Subagents::Canvas => BridgeResponse { allow: false, message: Some(CANVAS_REFUSAL.into()), updated_input: None, failed: false },
                Subagents::Inline => BridgeResponse { allow: true, message: None, updated_input: None, failed: false },
            };
            if let Ok(json) = serde_json::to_string(&resp) {
                let _ = write.write_all(format!("{json}\n").as_bytes()).await;
            }
            return;
        }
        // The helper sends nothing after its request, so its read half only tells us when it has gone.
        let mut read = reader.into_inner().into_inner();
        let id = format!("perm-{}", self.counter.fetch_add(1, Ordering::SeqCst) + 1);
        // Looked at again right before the answer, so a link swapped in while this was looking is caught where that's cheap.
        // That narrows the window; it doesn't close it, since the command runs after the answer (see rules::matches).
        let matched = self.rule_for(&req.tool_name, &req.input);
        let matched = matched.filter(|(_, rule)| self.rule_for(&req.tool_name, &req.input).is_some_and(|(_, again)| again == *rule));
        if let Some((scope, rule)) = matched {
            // A rule answers it: no card, and the tool gets its input as Claude sent it, not the resolved paths matched on.
            sink(UiEvent::PermissionAutoAllowed { request_id: id, tool_name: req.tool_name, input: req.input, scope, rule });
            let resp = BridgeResponse { allow: true, message: None, updated_input: None, failed: false };
            if let Ok(json) = serde_json::to_string(&resp) {
                let _ = write.write_all(format!("{json}\n").as_bytes()).await;
            }
            return;
        }
        let (tx, rx) = oneshot::channel();
        let asked = Pending { request_id: id.clone(), tool_name: req.tool_name.clone(), input: req.input.clone(), at: now_ms() };
        self.pending.lock().unwrap().insert(id.clone(), Waiting { tx, asked });
        sink(UiEvent::PermissionRequested { request_id: id.clone(), tool_name: req.tool_name, input: req.input });
        tokio::select! {
            // A dropped sender (cancel_all) closes the connection; the helper then denies.
            resp = rx => {
                if let Ok(resp) = resp {
                    if let Ok(json) = serde_json::to_string(&resp) {
                        let _ = write.write_all(format!("{json}\n").as_bytes()).await;
                    }
                }
            }
            // The helper is gone (its claude dropped the call), so nobody can take the answer: the card goes.
            _ = closed(&mut read) => {
                self.pending.lock().unwrap().remove(&id);
                sink(UiEvent::PermissionWithdrawn { request_id: id });
            }
        }
    }

    /// Lets this chat's network_* calls through to `handler`.
    pub fn set_network(&self, handler: NetworkHandler) {
        *self.network.lock().unwrap() = Some(handler);
    }

    /// This chat's claude runs as a read-only agent whose git tool runs in `scope`, or (None) as anything else.
    pub fn set_read_git(&self, scope: Option<crate::read_git::Scope>) {
        *self.read_git.lock().unwrap() = scope;
    }

    /// Makes this the main agent's bridge: its helper's orchestra tool calls go to `handler`.
    pub fn set_orchestra(&self, handler: OrchestraHandler) {
        *self.orchestra.lock().unwrap() = Some(handler);
    }

    /// Returns false if the request is unknown or already answered. `message` goes back to Claude (a deny reason,
    /// or the user's note on a reproduce request).
    /// `updated_input`: on allow, the tool's input as it should run (AskUserQuestion's, with the user's answers).
    pub fn respond(&self, request_id: &str, allow: bool, message: Option<String>, updated_input: Option<serde_json::Value>) -> bool {
        match self.pending.lock().unwrap().remove(request_id) {
            Some(waiting) => waiting.tx.send(BridgeResponse { allow, message, updated_input, failed: false }).is_ok(),
            None => false,
        }
    }

    /// The prompts waiting for an answer, the oldest first.
    pub fn pending(&self) -> Vec<Pending> {
        let mut all: Vec<Pending> = self.pending.lock().unwrap().values().map(|w| w.asked.clone()).collect();
        all.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.request_id.cmp(&b.request_id)));
        all
    }

    /// Denies every pending request (used when the session restarts or stops).
    pub fn cancel_all(&self) {
        self.pending.lock().unwrap().clear();
    }

    /// The chat is in this folder from now on: its folder rules apply.
    pub fn set_folder(&self, folder: &Path) {
        *self.folder.lock().unwrap() = Some(rules::folder_key(folder));
    }

    pub fn folder(&self) -> Option<String> {
        self.folder.lock().unwrap().clone()
    }

    pub fn chat_rules(&self) -> Vec<Rule> {
        self.chat_rules.lock().unwrap().clone()
    }

    /// A new conversation starts in this chat, so its "this chat" rules go with the old one. The team's Subagents setting
    /// is the team's, not the conversation's: it stays.
    pub fn clear_chat_rules(&self) {
        self.chat_rules.lock().unwrap().clear();
    }

    /// Where the Lead's helpers run from now on.
    pub fn set_subagents(&self, subagents: Subagents) {
        *self.subagents.lock().unwrap() = subagents;
    }

    pub fn subagents(&self) -> Subagents {
        *self.subagents.lock().unwrap()
    }

    /// Makes a rule, if it's one `rules::validate` accepts. A folder rule needs the chat to have a folder.
    pub fn add_rule(&self, scope: Scope, rule: Rule) -> Result<(), String> {
        let rule = rules::validate(&rule)?;
        match scope {
            Scope::Chat => {
                let mut chat = self.chat_rules.lock().unwrap();
                if !chat.contains(&rule) {
                    chat.push(rule);
                }
            }
            Scope::Folder => self.folder_rules.add(&self.folder().ok_or("Open a folder first.")?, rule),
        }
        Ok(())
    }

    pub fn remove_chat_rule(&self, rule: &Rule) {
        self.chat_rules.lock().unwrap().retain(|r| r != rule);
    }

    /// The rule that allows this request, if any: this chat's first, then the chat folder's.
    fn rule_for(&self, tool: &str, input: &Value) -> Option<(Scope, Rule)> {
        let input = rules::for_matching(tool, input);
        if let Some(rule) = self.chat_rules.lock().unwrap().iter().find(|r| rules::matches(r, tool, &input)) {
            return Some((Scope::Chat, rule.clone()));
        }
        let folder = self.folder()?;
        self.folder_rules.for_folder(&folder).into_iter().find(|r| rules::matches(r, tool, &input)).map(|r| (Scope::Folder, r))
    }

    /// Stops accepting helpers and removes the socket (the chat is closing). The caller denies pending requests first.
    pub async fn close(&self) {
        let accept = self.accept.lock().unwrap().take();
        if let Some(accept) = accept {
            accept.abort();
            let _ = accept.await;
        }
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

/// Resolves when the helper closes its end of the connection.
async fn closed(read: &mut OwnedReadHalf) {
    let mut buf = [0u8; 64];
    loop {
        match read.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permission::helper::ask_bridge;
    use serde_json::json;
    use std::time::Duration;
    use tokio::sync::mpsc;

    fn setup() -> (Arc<PermissionBridge>, mpsc::UnboundedReceiver<UiEvent>, tempfile::TempDir) {
        setup_with(this_process())
    }

    /// A bridge that lets in whom `auth` accepts.
    fn setup_with(auth: CallerAuth) -> (Arc<PermissionBridge>, mpsc::UnboundedReceiver<UiEvent>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        let bridge = PermissionBridge::start(dir.path().join("b.sock"), Arc::new(move |ev| { let _ = tx.send(ev); }), Arc::new(FolderRules::load(None)), auth).unwrap();
        (bridge, rx, dir)
    }

    fn request() -> BridgeRequest {
        BridgeRequest::permission("Bash".into(), json!({"command": "npm test"}), Some("toolu_1".into()))
    }

    fn ask_in_background(bridge: &PermissionBridge) -> tokio::task::JoinHandle<BridgeResponse> {
        ask_tool_in_background(bridge, "Bash", json!({"command": "npm test"}))
    }

    fn ask_tool_in_background(bridge: &PermissionBridge, tool: &str, input: Value) -> tokio::task::JoinHandle<BridgeResponse> {
        let socket = bridge.socket_path.display().to_string();
        let req = BridgeRequest::permission(tool.into(), input, None);
        tokio::task::spawn_blocking(move || ask_bridge(Some(&socket), &req))
    }

    fn prefix_rule(text: &str) -> Rule {
        Rule { tool: "Bash".into(), matcher: rules::Matcher::Prefix { text: text.into() } }
    }

    async fn next_event(rx: &mut mpsc::UnboundedReceiver<UiEvent>) -> UiEvent {
        tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap().unwrap()
    }

    async fn next_request_id(rx: &mut mpsc::UnboundedReceiver<UiEvent>) -> String {
        match next_event(rx).await {
            UiEvent::PermissionRequested { request_id, tool_name, input } => {
                assert_eq!(tool_name, "Bash");
                assert_eq!(input["command"], "npm test");
                request_id
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn allow_round_trip() {
        let (bridge, mut rx, _dir) = setup();
        let helper = ask_in_background(&bridge);
        let id = next_request_id(&mut rx).await;
        assert!(bridge.respond(&id, true, None, None));
        assert_eq!(helper.await.unwrap(), BridgeResponse { allow: true, message: None, updated_input: None, failed: false });
    }

    #[tokio::test]
    async fn deny_round_trip() {
        let (bridge, mut rx, _dir) = setup();
        let helper = ask_in_background(&bridge);
        let id = next_request_id(&mut rx).await;
        assert!(bridge.respond(&id, false, None, None));
        assert!(!helper.await.unwrap().allow);
    }

    #[tokio::test]
    async fn a_pending_prompt_can_be_listed_with_what_it_asks_until_it_is_answered() {
        let (bridge, mut rx, _dir) = setup();
        assert!(bridge.pending().is_empty());
        let helper = ask_in_background(&bridge);
        let id = next_request_id(&mut rx).await;
        let listed = bridge.pending();
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].request_id.as_str(), listed[0].tool_name.as_str(), listed[0].input["command"].as_str()), (id.as_str(), "Bash", Some("npm test")));
        assert!(listed[0].at > 0);
        assert!(bridge.respond(&id, true, None, None));
        assert!(bridge.pending().is_empty());
        helper.await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn when_two_clients_answer_at_once_exactly_one_answer_counts() {
        for _ in 0..20 {
            let (bridge, mut rx, _dir) = setup();
            let helper = ask_in_background(&bridge);
            let id = next_request_id(&mut rx).await;
            let answers: Vec<_> = [true, false]
                .into_iter()
                .map(|allow| {
                    let (bridge, id) = (bridge.clone(), id.clone());
                    tokio::spawn(async move { (allow, bridge.respond(&id, allow, None, None)) })
                })
                .collect();
            let mut won = Vec::new();
            for a in answers {
                let (allow, ok) = a.await.unwrap();
                if ok {
                    won.push(allow);
                }
            }
            assert_eq!(won.len(), 1, "exactly one answer is taken");
            assert_eq!(helper.await.unwrap().allow, won[0], "and it is the one the helper gets");
        }
    }

    #[tokio::test]
    async fn cancel_all_denies_pending() {
        let (bridge, mut rx, _dir) = setup();
        let helper = ask_in_background(&bridge);
        let id = next_request_id(&mut rx).await;
        bridge.cancel_all();
        let r = helper.await.unwrap();
        assert!(!r.allow);
        assert!(r.message.unwrap().contains("denied"));
        assert!(!bridge.respond(&id, true, None, None), "a cancelled request can't be answered");
    }

    #[tokio::test]
    async fn a_helper_that_goes_away_withdraws_its_prompt() {
        let (bridge, mut rx, _dir) = setup();
        let mut helper = UnixStream::connect(&bridge.socket_path).await.unwrap();
        helper.write_all(format!("{}\n", serde_json::to_string(&request()).unwrap()).as_bytes()).await.unwrap();
        let id = next_request_id(&mut rx).await;
        drop(helper);
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap().unwrap() {
            UiEvent::PermissionWithdrawn { request_id } => assert_eq!(request_id, id),
            other => panic!("unexpected {other:?}"),
        }
        assert!(!bridge.respond(&id, true, None, None), "a withdrawn prompt can't be answered");
    }

    #[tokio::test]
    async fn an_approval_always_shows_its_card_whatever_rules_there_are_and_a_cancelled_one_is_never_a_yes() {
        let (bridge, mut rx, dir) = setup();
        bridge.set_folder(dir.path());
        // No rule can be made for it, in either scope, so none can answer it.
        for tool in [crate::permission::helper::APPROVAL, "mcp__lantern__request_approval"] {
            for scope in [Scope::Chat, Scope::Folder] {
                assert!(bridge.add_rule(scope, Rule { tool: tool.into(), matcher: rules::Matcher::Any }).is_err(), "{tool}");
            }
        }
        assert!(bridge.chat_rules().is_empty());
        let input = json!({"action": "Merge PR #144", "details": "CI is green. <b>bold</b> **not markdown**"});
        let asked = ask_tool_in_background(&bridge, crate::permission::helper::APPROVAL, input.clone());
        let id = match next_event(&mut rx).await {
            UiEvent::PermissionRequested { request_id, tool_name, input: shown } => {
                assert_eq!((tool_name.as_str(), shown), ("Approval", input));
                request_id
            }
            other => panic!("unexpected {other:?}"),
        };
        // The chat is closed or the turn interrupted: the helper is told no, and the card can't be answered after.
        bridge.cancel_all();
        assert!(!asked.await.unwrap().allow);
        assert!(!bridge.respond(&id, true, None, None));
        // Answered by the user: the answer and their note come back as given.
        let asked = ask_tool_in_background(&bridge, "Approval", json!({"action": "Push tag v1"}));
        let id = match next_event(&mut rx).await {
            UiEvent::PermissionRequested { request_id, .. } => request_id,
            other => panic!("unexpected {other:?}"),
        };
        assert!(bridge.respond(&id, true, Some("go ahead".into()), None));
        assert_eq!(asked.await.unwrap(), BridgeResponse { allow: true, message: Some("go ahead".into()), updated_input: None, failed: false });
    }

    fn orchestra_call() -> BridgeRequest {
        BridgeRequest { tool_name: "list_agents".into(), input: json!({}), tool_use_id: None, orchestra: true, network: false, review: false, git: false }
    }

    #[tokio::test]
    async fn a_network_call_is_answered_with_the_chats_folder_and_never_shows_a_card() {
        let (bridge, mut rx, dir) = setup();
        bridge.set_folder(dir.path());
        let seen = Arc::new(Mutex::new(None));
        let saw = seen.clone();
        bridge.set_network(Arc::new(move |folder, tool, _| {
            *saw.lock().unwrap() = Some((folder, tool));
            Box::pin(async { BridgeResponse { allow: true, message: Some("3 requests".into()), updated_input: None, failed: false } })
        }));
        let socket = bridge.socket_path.display().to_string();
        let call = BridgeRequest { tool_name: "network_requests".into(), input: json!({}), tool_use_id: None, orchestra: false, network: true, review: false, git: false };
        let reply = tokio::task::spawn_blocking(move || ask_bridge(Some(&socket), &call)).await.unwrap();
        assert_eq!(reply.message.as_deref(), Some("3 requests"));
        assert_eq!(seen.lock().unwrap().clone(), Some((Some(rules::folder_key(dir.path())), "network_requests".to_string())));
        assert!(tokio::time::timeout(Duration::from_millis(100), rx.recv()).await.is_err(), "no card");
    }

    fn git_call(input: Value) -> BridgeRequest {
        BridgeRequest { tool_name: "git".into(), input, tool_use_id: None, orchestra: false, network: false, review: false, git: true }
    }

    /// A folder with a repository in it, and one commit.
    fn project_with_a_commit(dir: &Path) -> PathBuf {
        let root = std::fs::canonicalize(dir).unwrap().join("project");
        std::fs::create_dir_all(&root).unwrap();
        for list in [&["init", "-q"][..], &["add", "."], &["commit", "-q", "--allow-empty", "-m", "first commit"]] {
            let out = std::process::Command::new("git").arg("-C").arg(&root).args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]).args(list).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        }
        root
    }

    #[tokio::test]
    async fn a_git_call_is_refused_for_any_chat_that_is_not_a_read_only_agent_and_runs_nothing() {
        // The default chat, whatever its helper offered: the app decides from how it started this chat's claude.
        let (bridge, mut rx, dir) = setup();
        let project = project_with_a_commit(dir.path());
        bridge.set_folder(&project);
        let socket = bridge.socket_path.display().to_string();
        let target = dir.path().join("written.txt");
        for input in [json!({"args": ["log", "--oneline"]}), json!({"args": ["diff", format!("--output={}", target.display())]}), json!({"args": ["log"], "repo": project.display().to_string()})] {
            let (socket, req) = (socket.clone(), git_call(input));
            let reply = tokio::task::spawn_blocking(move || ask_bridge(Some(&socket), &req)).await.unwrap();
            assert!(!reply.allow && !reply.failed, "{reply:?}");
            assert!(reply.message.unwrap().contains("only available to a read-only agent"));
        }
        assert!(!target.exists());
        // It stops being one when the chat's claude is started as something else.
        bridge.set_read_git(Some(crate::read_git::Scope { folder: project.clone(), path_env: None }));
        bridge.set_read_git(None);
        let socket2 = socket.clone();
        let reply = tokio::task::spawn_blocking(move || ask_bridge(Some(&socket2), &git_call(json!({"args": ["log"]})))).await.unwrap();
        assert!(!reply.allow);
        assert!(tokio::time::timeout(Duration::from_millis(100), rx.recv()).await.is_err(), "a card was shown");
    }

    #[tokio::test]
    async fn a_read_only_agents_git_call_runs_read_only_git_in_its_folder_and_shows_no_card() {
        let (bridge, mut rx, dir) = setup();
        let project = project_with_a_commit(dir.path());
        bridge.set_read_git(Some(crate::read_git::Scope { folder: project.clone(), path_env: None }));
        let socket = bridge.socket_path.display().to_string();
        let ask = |input: Value| {
            let (socket, req) = (socket.clone(), git_call(input));
            async move { tokio::task::spawn_blocking(move || ask_bridge(Some(&socket), &req)).await.unwrap() }
        };
        let reply = ask(json!({"args": ["log", "--oneline", "-5"]})).await;
        assert!(reply.allow && reply.message.as_deref().unwrap().contains("first commit"), "{reply:?}");
        // What would write, run a program or leave the project is refused with its reason, and nothing happens.
        let target = dir.path().join("written.txt");
        for (input, why) in [
            (json!({"args": ["diff", format!("--output={}", target.display())]}), "refused"),
            (json!({"args": ["branch", "created"]}), "listing form"),
            (json!({"args": ["config", "user.name", "x"]}), "is not available"),
            (json!({"args": ["-c", "core.pager=sh", "log"]}), "subcommand"),
            (json!({"args": "log"}), "array of strings"),
            (json!({"args": ["log"], "repo": dir.path().display().to_string()}), "not in this project's repository"),
        ] {
            let reply = ask(input.clone()).await;
            assert!(!reply.allow, "{input}");
            assert!(reply.message.as_deref().unwrap().contains(why), "{input}: {reply:?}");
        }
        assert!(!target.exists());
        let branches = ask(json!({"args": ["branch", "--list"]})).await;
        assert!(!branches.message.unwrap().contains("created"));
        assert!(tokio::time::timeout(Duration::from_millis(100), rx.recv()).await.is_err(), "a card was shown");
    }

    #[tokio::test]
    async fn a_review_target_call_tells_the_window_what_to_compare_and_never_shows_a_card() {
        let (bridge, mut rx, _dir) = setup();
        let socket = bridge.socket_path.display().to_string();
        let call = |input: Value| BridgeRequest { tool_name: "review_target".into(), input, tool_use_id: None, orchestra: false, network: false, review: true, git: false };
        let ask = |req: BridgeRequest| {
            let socket = socket.clone();
            async move { tokio::task::spawn_blocking(move || ask_bridge(Some(&socket), &req)).await.unwrap() }
        };
        let reply = ask(call(json!({"pr": 512}))).await;
        assert!(reply.allow && reply.message.unwrap().contains("#512"));
        assert_eq!(next_event(&mut rx).await, UiEvent::ReviewTarget { pr: Some(512), base: None });
        let reply = ask(call(json!({"base": "feat/core"}))).await;
        assert!(reply.allow);
        assert_eq!(next_event(&mut rx).await, UiEvent::ReviewTarget { pr: None, base: Some("feat/core".into()) });
        // What the app can't use is refused, and the window hears nothing.
        let reply = ask(call(json!({"base": "--output=x"}))).await;
        assert!(!reply.allow && !reply.failed);
        assert!(tokio::time::timeout(Duration::from_millis(100), rx.recv()).await.is_err());
    }

    /// Accepts the test's own process, which is what connects in these tests (the helper runs in-process).
    fn this_process() -> CallerAuth {
        Arc::new(|pid| pid == std::process::id())
    }

    #[tokio::test]
    async fn the_socket_is_for_this_user_only() {
        use std::os::unix::fs::PermissionsExt;
        let (bridge, _rx, _dir) = setup();
        assert_eq!(std::fs::metadata(&bridge.socket_path).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[tokio::test]
    async fn a_request_from_a_process_that_is_not_the_chats_helper_is_refused_before_anything_sees_it() {
        // The chat's claude is some other process: this one (a stand-in for any other process of the user's) is not its child.
        let (bridge, mut rx, dir) = setup_with(Arc::new(|pid| crate::process::descends_from(pid, 1_999_999)));
        bridge.set_folder(dir.path());
        let reached = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (seen, seen_net) = (reached.clone(), reached.clone());
        bridge.set_orchestra(Arc::new(move |_, _| {
            seen.store(true, Ordering::SeqCst);
            Box::pin(async { BridgeResponse { allow: true, message: Some("ran".into()), updated_input: None, failed: false } })
        }));
        bridge.set_network(Arc::new(move |_, _, _| {
            seen_net.store(true, Ordering::SeqCst);
            Box::pin(async { BridgeResponse { allow: true, message: Some("ran".into()), updated_input: None, failed: false } })
        }));
        // Even a request a rule would allow.
        bridge.add_rule(Scope::Chat, prefix_rule("npm test")).unwrap();
        let socket = bridge.socket_path.display().to_string();
        let network = BridgeRequest { tool_name: "network_requests".into(), input: json!({}), tool_use_id: None, orchestra: false, network: true, review: false, git: false };
        let reproduce = BridgeRequest::permission("reproduce".into(), json!({"steps": "x"}), None);
        let question = BridgeRequest::permission("AskUserQuestion".into(), json!({"questions": []}), None);
        let review = BridgeRequest { tool_name: "review_target".into(), input: json!({"pr": 1}), tool_use_id: None, orchestra: false, network: false, review: true, git: false };
        bridge.set_read_git(Some(crate::read_git::Scope { folder: dir.path().to_path_buf(), path_env: None }));
        for req in [orchestra_call(), network, request(), reproduce, question, review, git_call(json!({"args": ["status"]}))] {
            let socket = socket.clone();
            let reply = tokio::task::spawn_blocking(move || ask_bridge(Some(&socket), &req)).await.unwrap();
            // Refused: told so, or (when the bridge hangs up before it has read the request, which it does, so the client's
            // write can hit a closed socket) simply failed. Either way it was denied and nothing ran.
            assert!(!reply.allow, "an unauthorized call was allowed");
            assert!(reply.failed || reply.message.as_deref().is_some_and(|m| m.contains("Not authorized")), "{reply:?}");
        }
        assert!(!reached.load(Ordering::SeqCst), "an unauthorized call ran a tool");
        assert!(tokio::time::timeout(Duration::from_millis(100), rx.recv()).await.is_err(), "a card or an auto-allow was shown");
    }

    /// The real shape of it: a client in another process is let in only when the process the bridge trusts started it
    /// itself (claude starting its helper), and not when something in between did (a command run in a shell).
    #[tokio::test]
    async fn only_a_client_started_directly_by_the_trusted_process_is_accepted() {
        use std::process::{Command, Stdio};
        // The trusted process is this one: its own child is let in; one started through a shell is not.
        let me = std::process::id();
        let (bridge, _rx, _dir) = setup_with(Arc::new(move |pid| crate::process::is_child_of(pid, me)));
        let socket = bridge.socket_path.display().to_string();
        let request = serde_json::to_string(&orchestra_call()).unwrap();
        let answer = |out: std::process::Output| serde_json::from_slice(&out.stdout).unwrap_or(BridgeResponse { allow: false, message: Some("no answer".into()), updated_input: None, failed: false });
        // `nc` started by this test itself, like a helper started by claude.
        let direct = {
            let (socket, request) = (socket.clone(), request.clone());
            move || -> BridgeResponse {
                let mut child = Command::new("nc").args(["-U", "-w", "2", &socket]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
                std::io::Write::write_all(&mut child.stdin.take().unwrap(), format!("{request}\n").as_bytes()).unwrap();
                answer(child.wait_with_output().unwrap())
            }
        };
        // The same through a shell: a command the main agent ran, a grandchild.
        let through_shell = {
            let (socket, request) = (socket.clone(), request.clone());
            move || -> BridgeResponse {
                answer(Command::new("sh").arg("-c").arg(format!("printf '%s\\n' '{request}' | nc -U -w 2 '{socket}'")).stdin(Stdio::null()).output().unwrap())
            }
        };
        let handler: OrchestraHandler = Arc::new(|_, _| Box::pin(async { BridgeResponse { allow: true, message: Some("ran".into()), updated_input: None, failed: false } }));
        bridge.set_orchestra(handler.clone());
        let accepted = tokio::task::spawn_blocking(direct.clone()).await.unwrap();
        assert_eq!(accepted.message.as_deref(), Some("ran"));
        let refused = tokio::task::spawn_blocking(through_shell).await.unwrap();
        assert!(!refused.allow && refused.message.unwrap().contains("Not authorized"), "a command run in a shell passed for the helper");
        // The trusted process is another one: nothing of this test's is let in.
        let sleeper = Command::new("sleep").arg("30").stdin(Stdio::null()).spawn().unwrap();
        let other = sleeper.id();
        let (bridge2, _rx2, _dir2) = setup_with(Arc::new(move |pid| crate::process::is_child_of(pid, other)));
        let direct = {
            let (socket, request) = (bridge2.socket_path.display().to_string(), request.clone());
            move || -> BridgeResponse {
                let mut child = Command::new("nc").args(["-U", "-w", "2", &socket]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
                std::io::Write::write_all(&mut child.stdin.take().unwrap(), format!("{request}\n").as_bytes()).unwrap();
                answer(child.wait_with_output().unwrap())
            }
        };
        bridge2.set_orchestra(handler);
        let refused = tokio::task::spawn_blocking(direct).await.unwrap();
        assert!(!refused.allow && refused.message.unwrap().contains("Not authorized"), "a process outside the main agent's tree was let in");
        let mut sleeper = sleeper;
        let _ = sleeper.kill();
        let _ = sleeper.wait();
    }

    #[tokio::test]
    async fn an_orchestra_call_is_served_by_the_handler_and_never_shows_a_card() {
        let (bridge, mut rx, _dir) = setup();
        bridge.set_orchestra(
            Arc::new(|tool, input| Box::pin(async move { BridgeResponse { allow: true, message: Some(format!("{tool} {input}")), updated_input: None, failed: false } })),
        );
        let socket = bridge.socket_path.display().to_string();
        let reply = tokio::task::spawn_blocking(move || ask_bridge(Some(&socket), &orchestra_call())).await.unwrap();
        assert_eq!(reply, BridgeResponse { allow: true, message: Some("list_agents {}".into()), updated_input: None, failed: false });
        assert!(tokio::time::timeout(Duration::from_millis(200), rx.recv()).await.is_err(), "a card was shown");
    }

    fn main_agent_bridge() -> (Arc<PermissionBridge>, mpsc::UnboundedReceiver<UiEvent>, tempfile::TempDir) {
        let (bridge, rx, dir) = setup();
        bridge.set_orchestra(Arc::new(|_, _| Box::pin(async { BridgeResponse { allow: true, message: None, updated_input: None, failed: false } })));
        (bridge, rx, dir)
    }

    fn agent_input() -> Value {
        json!({"description": "Find the callers", "prompt": "List every caller of fetchJson.", "subagent_type": "Explore"})
    }

    #[tokio::test]
    async fn the_leads_inline_helper_is_refused_with_how_to_start_an_agent_and_no_card_by_default() {
        let (bridge, mut rx, _dir) = main_agent_bridge();
        assert_eq!(bridge.subagents(), Subagents::Canvas);
        for tool in ["Agent", "Task"] {
            let reply = ask_tool_in_background(&bridge, tool, agent_input()).await.unwrap();
            assert_eq!(reply, BridgeResponse { allow: false, message: Some(CANVAS_REFUSAL.into()), updated_input: None, failed: false }, "{tool}");
        }
        assert!(CANVAS_REFUSAL.contains("spawn_agent") && CANVAS_REFUSAL.contains("same task as its brief"));
        assert!(tokio::time::timeout(Duration::from_millis(200), rx.recv()).await.is_err(), "a card was shown");
    }

    #[tokio::test]
    async fn with_subagents_inline_the_helper_runs_without_a_card_and_other_tools_still_ask() {
        let (bridge, mut rx, _dir) = main_agent_bridge();
        bridge.set_subagents(Subagents::Inline);
        let reply = ask_tool_in_background(&bridge, "Agent", agent_input()).await.unwrap();
        assert_eq!(reply, BridgeResponse { allow: true, message: None, updated_input: None, failed: false });
        assert!(tokio::time::timeout(Duration::from_millis(200), rx.recv()).await.is_err(), "a card was shown");
        // The setting is about helpers only.
        let bash = ask_in_background(&bridge);
        next_request_id(&mut rx).await;
        bridge.cancel_all();
        assert!(!bash.await.unwrap().allow);
    }

    #[tokio::test]
    async fn the_setting_is_the_leads_alone_and_a_new_conversation_keeps_it() {
        // A chat with no orchestra (an ordinary chat, whose subagents run inline as Claude Code runs them) is asked as usual.
        let (bridge, mut rx, _dir) = setup();
        bridge.set_subagents(Subagents::Canvas);
        let helper = ask_tool_in_background(&bridge, "Agent", agent_input());
        match next_event(&mut rx).await {
            UiEvent::PermissionRequested { request_id, .. } => assert!(bridge.respond(&request_id, true, None, None)),
            other => panic!("unexpected {other:?}"),
        }
        assert!(helper.await.unwrap().allow);
        // Starting a new conversation clears the chat's rules, not the team's setting.
        bridge.set_subagents(Subagents::Inline);
        bridge.clear_chat_rules();
        assert_eq!(bridge.subagents(), Subagents::Inline);
    }

    #[tokio::test]
    async fn a_chat_that_is_not_the_main_agent_refuses_orchestra_calls() {
        let (bridge, mut rx, _dir) = setup();
        let socket = bridge.socket_path.display().to_string();
        let reply = tokio::task::spawn_blocking(move || ask_bridge(Some(&socket), &orchestra_call())).await.unwrap();
        assert!(!reply.allow);
        assert!(reply.message.unwrap().contains("not the Lead"));
        assert!(tokio::time::timeout(Duration::from_millis(200), rx.recv()).await.is_err());
    }

    #[tokio::test]
    async fn a_slow_orchestra_call_does_not_hold_up_a_permission_prompt() {
        let (bridge, mut rx, _dir) = setup();
        bridge.set_orchestra(
            Arc::new(|_, _| {
                Box::pin(async {
                    tokio::time::sleep(Duration::from_millis(600)).await;
                    BridgeResponse { allow: true, message: Some("late".into()), updated_input: None, failed: false }
                })
            }),
        );
        let socket = bridge.socket_path.display().to_string();
        let slow = tokio::task::spawn_blocking({
            let socket = socket.clone();
            move || ask_bridge(Some(&socket), &orchestra_call())
        });
        let helper = ask_in_background(&bridge);
        let id = next_request_id(&mut rx).await;
        assert!(bridge.respond(&id, true, None, None));
        assert!(helper.await.unwrap().allow);
        assert!(!slow.is_finished(), "the prompt was answered while the slow call was still running");
        assert_eq!(slow.await.unwrap().message.as_deref(), Some("late"));
    }

    #[tokio::test]
    async fn an_oversized_request_shows_no_prompt() {
        let (bridge, mut rx, _dir) = setup();
        let mut helper = UnixStream::connect(&bridge.socket_path).await.unwrap();
        // Past the cap, with no line end: the bridge stops reading and hangs up, so the write fails.
        let _ = helper.write_all(&vec![b'x'; MAX_REQUEST as usize + 1]).await;
        assert!(tokio::time::timeout(Duration::from_millis(500), rx.recv()).await.is_err());
    }

    #[tokio::test]
    async fn closing_stops_the_accept_loop_and_removes_the_socket() {
        let (bridge, _rx, _dir) = setup();
        let path = bridge.socket_path.clone();
        bridge.close().await;
        assert!(!path.exists());
        // The accept loop held a clone of the bridge; once it's stopped only ours is left.
        assert_eq!(Arc::strong_count(&bridge), 1);
    }

    #[tokio::test]
    async fn a_chat_rule_answers_its_request_without_a_card() {
        let (bridge, mut rx, _dir) = setup();
        bridge.add_rule(Scope::Chat, prefix_rule("npm test")).unwrap();
        let helper = ask_in_background(&bridge);
        match next_event(&mut rx).await {
            UiEvent::PermissionAutoAllowed { request_id, tool_name, input, scope, rule } => {
                assert_eq!((request_id.as_str(), tool_name.as_str(), input["command"].as_str()), ("perm-1", "Bash", Some("npm test")));
                assert_eq!((scope, rule), (Scope::Chat, prefix_rule("npm test")));
            }
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(helper.await.unwrap(), BridgeResponse { allow: true, message: None, updated_input: None, failed: false });
        assert!(rx.try_recv().is_err(), "no card came up");
    }

    #[tokio::test]
    async fn a_request_the_rule_does_not_match_still_gets_a_card() {
        let (bridge, mut rx, _dir) = setup();
        bridge.add_rule(Scope::Chat, prefix_rule("npm test")).unwrap();
        let helper = ask_tool_in_background(&bridge, "Bash", json!({"command": "npm test; rm -rf ~"}));
        let id = match next_event(&mut rx).await {
            UiEvent::PermissionRequested { request_id, .. } => request_id,
            other => panic!("unexpected {other:?}"),
        };
        assert!(bridge.respond(&id, false, None, None));
        assert!(!helper.await.unwrap().allow);
    }

    #[tokio::test]
    async fn a_folder_rule_applies_in_its_folder_only() {
        let (bridge, mut rx, dir) = setup();
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        bridge.set_folder(&a);
        bridge.add_rule(Scope::Folder, prefix_rule("npm test")).unwrap();
        let helper = ask_in_background(&bridge);
        assert!(matches!(next_event(&mut rx).await, UiEvent::PermissionAutoAllowed { scope: Scope::Folder, .. }));
        assert!(helper.await.unwrap().allow);
        bridge.set_folder(&b);
        let helper = ask_in_background(&bridge);
        assert!(matches!(next_event(&mut rx).await, UiEvent::PermissionRequested { .. }), "another folder has its own rules");
        bridge.cancel_all();
        assert!(!helper.await.unwrap().allow);
    }

    #[tokio::test]
    async fn a_folder_rule_needs_a_folder_and_a_valid_rule() {
        let (bridge, _rx, dir) = setup();
        assert!(bridge.add_rule(Scope::Folder, prefix_rule("npm test")).is_err(), "no folder open");
        bridge.set_folder(dir.path());
        assert!(bridge.add_rule(Scope::Folder, prefix_rule("npm test")).is_ok());
        assert!(bridge.add_rule(Scope::Chat, prefix_rule("*")).is_err());
        assert!(bridge.add_rule(Scope::Chat, Rule { tool: "ExitPlanMode".into(), matcher: rules::Matcher::Any }).is_err());
        assert!(bridge.chat_rules().is_empty(), "nothing invalid is kept");
    }

    #[tokio::test]
    async fn clearing_the_chat_rules_brings_the_cards_back() {
        let (bridge, mut rx, _dir) = setup();
        bridge.add_rule(Scope::Chat, prefix_rule("npm test")).unwrap();
        bridge.clear_chat_rules();
        let helper = ask_in_background(&bridge);
        let id = next_request_id(&mut rx).await;
        assert!(bridge.respond(&id, true, None, None));
        assert!(helper.await.unwrap().allow);
    }

    #[tokio::test]
    async fn a_folder_rule_does_not_pass_a_symlink_out_of_its_folder() {
        let (bridge, mut rx, dir) = setup();
        let folder = std::fs::canonicalize(dir.path()).unwrap().join("proj");
        let outside = std::fs::canonicalize(dir.path()).unwrap().join("outside");
        std::fs::create_dir_all(folder.join("real")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(folder.join("real"), folder.join("alias")).unwrap();
        std::os::unix::fs::symlink(&outside, folder.join("out")).unwrap();
        bridge.set_folder(&folder);
        bridge.add_rule(Scope::Folder, Rule { tool: "Read".into(), matcher: rules::Matcher::Dir { path: folder.display().to_string() } }).unwrap();

        // Inside the folder, through a link that stays in it: allowed, and the tool gets the path it asked for.
        let through = folder.join("alias/x.ts").display().to_string();
        let helper = ask_tool_in_background(&bridge, "Read", json!({"file_path": through}));
        match next_event(&mut rx).await {
            UiEvent::PermissionAutoAllowed { input, .. } => assert_eq!(input["file_path"], through),
            other => panic!("unexpected {other:?}"),
        }
        assert!(helper.await.unwrap().allow);

        // Through a link that leaves it: a card, as before the rule.
        let escape = folder.join("out/secret.txt").display().to_string();
        let helper = ask_tool_in_background(&bridge, "Read", json!({"file_path": escape}));
        let id = match next_event(&mut rx).await {
            UiEvent::PermissionRequested { request_id, .. } => request_id,
            other => panic!("unexpected {other:?}"),
        };
        assert!(bridge.respond(&id, false, None, None));
        assert!(!helper.await.unwrap().allow);
    }
}
