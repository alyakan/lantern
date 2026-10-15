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

/// Where the user wants the main agent's helpers to run, once they have said so for the chat.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentChoice {
    /// As workers on the canvas, with a chat each.
    Canvas,
    /// Inline, as Claude Code's own Agent tool runs them.
    Inline,
}

/// What a main agent reads when its Agent call is turned down because the user wants helpers on the canvas. The card's
/// "Run on canvas" button sends the same words (CANVAS_REFUSAL in PermissionCard.tsx).
pub const CANVAS_REFUSAL: &str = "Not run inline: the user wants helpers on the canvas, as workers with a chat of their own. Start this one with spawn_agent instead, using the same task as its brief (isolation \"shared\" if it only reads), then carry on or end your turn; you'll get a note when it finishes a turn.";

/// Unix-socket server that turns helper requests into UI permission cards, or answers them by a rule.
pub struct PermissionBridge {
    pub socket_path: PathBuf,
    pending: Mutex<HashMap<String, oneshot::Sender<BridgeResponse>>>,
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
    /// The main agent's answer to "where should this helper run?", kept for the chat (see `AgentChoice`).
    agent_choice: Mutex<Option<AgentChoice>>,
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
            agent_choice: Mutex::new(None),
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
                None => BridgeResponse { allow: false, message: Some("This chat is not the main agent of an orchestra.".into()), updated_input: None, failed: false },
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
        // The main agent's helper run inline, once the user has said where helpers go for this chat: answered without a card.
        // Only a main agent is ever asked (see build_args), and this bridge is the one that has an orchestra.
        if crate::args::INLINE_AGENT_TOOLS.contains(&req.tool_name.as_str()) && self.orchestra.lock().unwrap().is_some() {
            let resp = match self.agent_choice() {
                Some(AgentChoice::Canvas) => Some(BridgeResponse { allow: false, message: Some(CANVAS_REFUSAL.into()), updated_input: None, failed: false }),
                Some(AgentChoice::Inline) => Some(BridgeResponse { allow: true, message: None, updated_input: None, failed: false }),
                None => None,
            };
            if let Some(resp) = resp {
                if let Ok(json) = serde_json::to_string(&resp) {
                    let _ = write.write_all(format!("{json}\n").as_bytes()).await;
                }
                return;
            }
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
        self.pending.lock().unwrap().insert(id.clone(), tx);
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

    /// Makes this the main agent's bridge: its helper's orchestra tool calls go to `handler`.
    pub fn set_orchestra(&self, handler: OrchestraHandler) {
        *self.orchestra.lock().unwrap() = Some(handler);
    }

    /// Returns false if the request is unknown or already answered. `message` goes back to Claude (a deny reason,
    /// or the user's note on a reproduce request).
    /// `updated_input`: on allow, the tool's input as it should run (AskUserQuestion's, with the user's answers).
    pub fn respond(&self, request_id: &str, allow: bool, message: Option<String>, updated_input: Option<serde_json::Value>) -> bool {
        match self.pending.lock().unwrap().remove(request_id) {
            Some(tx) => tx.send(BridgeResponse { allow, message, updated_input, failed: false }).is_ok(),
            None => false,
        }
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

    /// A new conversation starts in this chat, so its "this chat" rules go with the old one, and so does where it wanted
    /// its helpers to run.
    pub fn clear_chat_rules(&self) {
        self.chat_rules.lock().unwrap().clear();
        *self.agent_choice.lock().unwrap() = None;
    }

    /// Where the main agent's helpers run from now on in this chat (None: ask each time).
    pub fn set_agent_choice(&self, choice: Option<AgentChoice>) {
        *self.agent_choice.lock().unwrap() = choice;
    }

    pub fn agent_choice(&self) -> Option<AgentChoice> {
        *self.agent_choice.lock().unwrap()
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

    fn orchestra_call() -> BridgeRequest {
        BridgeRequest { tool_name: "list_agents".into(), input: json!({}), tool_use_id: None, orchestra: true, network: false, review: false }
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
        let call = BridgeRequest { tool_name: "network_requests".into(), input: json!({}), tool_use_id: None, orchestra: false, network: true, review: false };
        let reply = tokio::task::spawn_blocking(move || ask_bridge(Some(&socket), &call)).await.unwrap();
        assert_eq!(reply.message.as_deref(), Some("3 requests"));
        assert_eq!(seen.lock().unwrap().clone(), Some((Some(rules::folder_key(dir.path())), "network_requests".to_string())));
        assert!(tokio::time::timeout(Duration::from_millis(100), rx.recv()).await.is_err(), "no card");
    }

    #[tokio::test]
    async fn a_review_target_call_tells_the_window_what_to_compare_and_never_shows_a_card() {
        let (bridge, mut rx, _dir) = setup();
        let socket = bridge.socket_path.display().to_string();
        let call = |input: Value| BridgeRequest { tool_name: "review_target".into(), input, tool_use_id: None, orchestra: false, network: false, review: true };
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
        let network = BridgeRequest { tool_name: "network_requests".into(), input: json!({}), tool_use_id: None, orchestra: false, network: true, review: false };
        let reproduce = BridgeRequest::permission("reproduce".into(), json!({"steps": "x"}), None);
        let question = BridgeRequest::permission("AskUserQuestion".into(), json!({"questions": []}), None);
        let review = BridgeRequest { tool_name: "review_target".into(), input: json!({"pr": 1}), tool_use_id: None, orchestra: false, network: false, review: true };
        for req in [orchestra_call(), network, request(), reproduce, question, review] {
            let socket = socket.clone();
            let reply = tokio::task::spawn_blocking(move || ask_bridge(Some(&socket), &req)).await.unwrap();
            assert!(!reply.allow && reply.message.unwrap().contains("Not authorized"));
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
    async fn the_main_agents_inline_helper_asks_with_a_card_until_the_user_says_where_helpers_go() {
        let (bridge, mut rx, _dir) = main_agent_bridge();
        let helper = ask_tool_in_background(&bridge, "Agent", agent_input());
        match next_event(&mut rx).await {
            UiEvent::PermissionRequested { request_id, tool_name, input } => {
                assert_eq!((tool_name.as_str(), &input["description"]), ("Agent", &json!("Find the callers")));
                assert!(bridge.respond(&request_id, false, Some("no".into()), None));
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(!helper.await.unwrap().allow);
    }

    #[tokio::test]
    async fn once_the_user_chose_the_canvas_an_inline_helper_is_refused_with_how_to_start_a_worker_and_no_card() {
        let (bridge, mut rx, _dir) = main_agent_bridge();
        bridge.set_agent_choice(Some(AgentChoice::Canvas));
        for tool in ["Agent", "Task"] {
            let reply = ask_tool_in_background(&bridge, tool, agent_input()).await.unwrap();
            assert_eq!(reply, BridgeResponse { allow: false, message: Some(CANVAS_REFUSAL.into()), updated_input: None, failed: false }, "{tool}");
        }
        assert!(CANVAS_REFUSAL.contains("spawn_agent") && CANVAS_REFUSAL.contains("same task as its brief"));
        assert!(tokio::time::timeout(Duration::from_millis(200), rx.recv()).await.is_err(), "a card was shown");
    }

    #[tokio::test]
    async fn once_the_user_chose_inline_the_helper_runs_without_a_card_and_other_tools_still_ask() {
        let (bridge, mut rx, _dir) = main_agent_bridge();
        bridge.set_agent_choice(Some(AgentChoice::Inline));
        let reply = ask_tool_in_background(&bridge, "Agent", agent_input()).await.unwrap();
        assert_eq!(reply, BridgeResponse { allow: true, message: None, updated_input: None, failed: false });
        assert!(tokio::time::timeout(Duration::from_millis(200), rx.recv()).await.is_err(), "a card was shown");
        // The choice is about helpers only.
        let bash = ask_in_background(&bridge);
        next_request_id(&mut rx).await;
        bridge.cancel_all();
        assert!(!bash.await.unwrap().allow);
    }

    #[tokio::test]
    async fn the_choice_is_the_main_agents_alone_and_a_new_conversation_forgets_it() {
        // A chat with no orchestra (an ordinary chat that has its own ask rule for Agent) is asked as usual.
        let (bridge, mut rx, _dir) = setup();
        bridge.set_agent_choice(Some(AgentChoice::Canvas));
        let helper = ask_tool_in_background(&bridge, "Agent", agent_input());
        match next_event(&mut rx).await {
            UiEvent::PermissionRequested { request_id, .. } => assert!(bridge.respond(&request_id, true, None, None)),
            other => panic!("unexpected {other:?}"),
        }
        assert!(helper.await.unwrap().allow);
        // And starting over clears it.
        bridge.clear_chat_rules();
        assert_eq!(bridge.agent_choice(), None);
    }

    #[tokio::test]
    async fn a_chat_that_is_not_the_main_agent_refuses_orchestra_calls() {
        let (bridge, mut rx, _dir) = setup();
        let socket = bridge.socket_path.display().to_string();
        let reply = tokio::task::spawn_blocking(move || ask_bridge(Some(&socket), &orchestra_call())).await.unwrap();
        assert!(!reply.allow);
        assert!(reply.message.unwrap().contains("not the main agent"));
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
