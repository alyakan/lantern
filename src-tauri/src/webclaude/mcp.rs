//! The connector's MCP side: JSON-RPC as claude.ai's servers send it (Streamable HTTP, one JSON reply per request), and
//! the eight tools web Claude gets. Nothing here runs anything on the Mac: sending work makes a card that waits for the
//! user's Run, or that the app runs on its own when the user turned auto-run on (see store.rs); the rest reads.

use super::store::{self, Kind, Store};
use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;

pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// One chat as web Claude sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatLine {
    pub slot: String,
    pub title: Option<String>,
    pub folder: Option<String>,
    /// "needs_you", "working", "idle", "asleep" or "ended".
    pub status: String,
    /// Its conversation (Lantern's id), once it has one.
    pub conversation: Option<String>,
}

/// What the connector reads of the Mac.
pub trait Mac: Send + Sync + 'static {
    /// The projects a chat may start in, as (folder, name).
    fn projects(&self) -> BoxFut<Vec<(String, String)>>;
    fn chats(&self) -> Vec<ChatLine>;
    /// Everything the chat open in `slot` kept, as events (None: no such chat is open).
    fn chat_events(&self, slot: &str) -> Option<Vec<crate::ui_event::UiEvent>>;
}

pub const PROTOCOLS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "Lantern is the user's Mac app that runs Claude Code chats on the user's projects. Use it to hand design work from a canvas to the code: send_to_lantern puts a card in Lantern with your message, and nothing runs until the user taps Run there, unless they let your work run on its own (its answer says which): tell the user whether it is waiting or running. Name the canvas by its claude.ai link when you have it (the chat in Lantern reads the design from it). Work that isn't about a design can be sent too: leave the canvas out and name the project. Work goes on in the chat already working on that canvas or project, which knows what was done and costs less than a new chat finding its way again; set new_chat only for work unrelated to what that chat has been doing. A project can have several of your chats at once (list_chats gives each an id): when the work belongs with one that isn't the one you used last, name it with chat. Then call check with the id to see how it went (always check before saying where a request stands, or before sending it again): when the chat is done its last message comes back, with the files it changed. A chat that works on your canvas is yours to follow: every turn it finishes (also those the user starts there themselves) leaves its last message in the outbox, and read_chat reads all of it, step by step. Chats in Lantern can leave you questions and notes (preview links to what they built): read_outbox shows them, and answer replies to a question (also after the user's Run). Lantern can't start a message to you, but wait holds your turn until it has something, so the user needn't come back to tell you Lantern finished: after send_to_lantern or answer, call wait with the id, and call it again (with the `after` it gives) while it says still_working; then carry on with what came back (send the next step, answer a question, or tell the user how it went). To follow a chat on your canvas that the user works in themselves, wait with the canvas. While a request waits for the user's Run, stop waiting after a few tries and tell the user it needs their Run. Look at the outbox too when the user asks what Lantern did or said.";

/// How long one wait holds the call by default, and at most (seconds): claude.ai drops a tool call that takes too long.
const WAIT_DEFAULT: u64 = 50;
const WAIT_MAX: u64 = 300;
const WAIT_TICK: std::time::Duration = std::time::Duration::from_millis(500);

fn tools() -> Value {
    json!([
        {
            "name": "list_projects",
            "description": "The projects on the user's Mac that Lantern can start a chat in, with the design canvases already linked to each.",
            "inputSchema": {"type": "object", "properties": {}},
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "list_chats",
            "description": "The chats open in Lantern: their title, project, what they are doing, and the canvas a chat works on when it was started from here. Your own chats (the ones your work went to) have an id: pass it to send_to_lantern's chat to send work there.",
            "inputSchema": {"type": "object", "properties": {"project": {"type": "string", "description": "Only this project's chats (its name from list_projects)."}}},
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "send_to_lantern",
            "description": "Send work to Lantern: about a design canvas, or for a project when there is no design. It shows the user a card and waits for their Run, unless they let web Claude's work run on its own (the answer says which). On Run, it goes on in the chat already working on that canvas (or, with no design, the project's chat web Claude used last), or a new chat in the project when there is none or new_chat is set. Returns an id: call check with it before saying how the work went or sending more about it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "canvas": {"type": "string", "description": "The canvas's claude.ai link (best), or its exact title. Leave it out when the work isn't about a design (then name the project); never put a project's name here."},
                    "canvas_title": {"type": "string", "description": "The canvas's title, for the user's card."},
                    "message": {"type": "string", "description": "What the chat should do or answer, complete on its own: the chat sees this message and the canvas, not this conversation."},
                    "project": {"type": "string", "description": "The project's name from list_projects. Needed when there is no canvas. With a canvas, leave it out when the canvas is linked already, or to let the user pick."},
                    "new_chat": {"type": "boolean", "description": "Start a chat of its own instead of going on in the chat already on this canvas or project. Only for work unrelated to what that chat has been doing: a follow-up costs less where the work was done."},
                    "chat": {"type": "string", "description": "The id of one of your chats from list_chats: the work goes on in that one (when the project has several and it isn't the one you used last). Leave it out for the usual chat."}
                },
                "required": ["message"]
            },
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "openWorldHint": false}
        },
        {
            "name": "check",
            "description": "How a request is going: waiting for the user's Run, declined, working, done (with the chat's last message and the files it changed) or failed.",
            "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]},
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "read_outbox",
            "description": "What Lantern's chats left for you, oldest first: their questions (answer them with answer), notes, preview links, and the last message of every turn a chat on your canvas finished, with the files it changed (`asked` is the user's own message, for a turn they started there themselves).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "canvas": {"type": "string", "description": "Only this canvas's items (link or title)."},
                    "after": {"type": "string", "description": "Only items after this item id (the last one you read)."}
                }
            },
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "read_chat",
            "description": "Read the Lantern chat working on a canvas, or the one a request went to: everything in it, numbered, as Lantern kept it. The user's and your messages, Claude's words, each step with what it printed (cut when long), each edit with its diff, and where turns ended. Returns the newest page; pass `before` with the first number you got to read further back, or `after` with the last one to read what came since.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "canvas": {"type": "string", "description": "The canvas's claude.ai link or title."},
                    "id": {"type": "string", "description": "Or the id of a request you sent (for work with no design)."},
                    "before": {"type": "integer", "description": "Only entries before this number."},
                    "after": {"type": "integer", "description": "Only entries after this number."}
                }
            },
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "wait",
            "description": "Wait for Lantern without the user coming back: returns as soon as the request is done, failed or declined, or a chat leaves something new in the outbox (a question, a note, a finished turn), or after `seconds` with still_working. Pass the request's id, or a canvas to follow its chat. Call it again with the `after` it returns while it says still_working.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "A request you sent (send_to_lantern or answer)."},
                    "canvas": {"type": "string", "description": "Or a canvas (link or title): wait for its chat's next outbox item."},
                    "after": {"type": "string", "description": "The outbox item id the last wait returned: only what comes after it counts."},
                    "seconds": {"type": "integer", "description": "How long to wait at most (default 50, at most 300). Leave it out."}
                }
            },
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "answer",
            "description": "Answer a question a Lantern chat left in the outbox. Like send_to_lantern, it waits for the user's Run, then goes to the chat that asked.",
            "inputSchema": {"type": "object", "properties": {"question_id": {"type": "string"}, "text": {"type": "string"}}, "required": ["question_id", "text"]},
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "openWorldHint": false}
        }
    ])
}

fn rpc_ok(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn rpc_err(id: &Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn text_result(value: Value) -> Value {
    json!({"content": [{"type": "text", "text": serde_json::to_string_pretty(&value).unwrap_or_default()}], "structuredContent": value, "isError": false})
}

fn tool_error(message: &str) -> Value {
    json!({"content": [{"type": "text", "text": message}], "isError": true})
}

/// One JSON-RPC message. None for a notification (no reply is sent).
pub async fn handle(store: &Store, mac: &dyn Mac, grant: &str, msg: &Value, now: u64) -> Option<Value> {
    let id = msg.get("id")?.clone();
    let method = msg["method"].as_str().unwrap_or("");
    Some(match method {
        "initialize" => {
            let asked = msg["params"]["protocolVersion"].as_str().unwrap_or("");
            let version = PROTOCOLS.iter().find(|v| **v == asked).copied().unwrap_or(PROTOCOLS[0]);
            rpc_ok(&id, json!({
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": "lantern", "title": "Lantern", "version": env!("CARGO_PKG_VERSION")},
                "instructions": INSTRUCTIONS
            }))
        }
        "ping" => rpc_ok(&id, json!({})),
        "tools/list" => rpc_ok(&id, json!({"tools": tools()})),
        "tools/call" => {
            let name = msg["params"]["name"].as_str().unwrap_or("");
            let args = msg["params"].get("arguments").cloned().unwrap_or_else(|| json!({}));
            let result = match call(store, mac, grant, name, &args, now).await {
                Ok(v) => text_result(v),
                Err(e) => tool_error(&e),
            };
            rpc_ok(&id, result)
        }
        "resources/list" => rpc_ok(&id, json!({"resources": []})),
        "prompts/list" => rpc_ok(&id, json!({"prompts": []})),
        _ => rpc_err(&id, -32601, "Lantern has no such method."),
    })
}

fn arg<'a>(args: &'a Value, name: &str) -> Option<&'a str> {
    args.get(name).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn need<'a>(args: &'a Value, name: &str) -> Result<&'a str, String> {
    arg(args, name).ok_or_else(|| format!("`{name}` is needed."))
}

/// A request's canvas as web Claude sees it: none for work with no design.
fn shown(canvas: &str) -> Option<&str> {
    (!canvas.is_empty()).then_some(canvas)
}

fn name_of(projects: &[(String, String)], folder: &str) -> String {
    projects.iter().find(|(f, _)| f == folder).map(|(_, n)| n.clone()).unwrap_or_else(|| folder.rsplit('/').next().unwrap_or(folder).to_string())
}

fn request_view(r: &store::Request, projects: &[(String, String)]) -> Value {
    let (state, reason) = match &r.status {
        store::Status::Waiting => ("waiting_for_run", None),
        store::Status::Declined => ("declined", None),
        store::Status::Working => ("working", None),
        store::Status::Done => ("done", None),
        store::Status::Failed { reason } => ("failed", Some(reason.clone())),
    };
    let mut v = json!({
        "id": r.id,
        "state": state,
        "canvas": shown(&r.canvas),
        "project": r.folder.as_deref().map(|f| name_of(projects, f)),
        "chat": r.chat_title,
    });
    if let Some(reason) = reason {
        v["reason"] = json!(reason);
    }
    if let Some(reply) = &r.reply {
        v["reply"] = json!(reply);
    }
    if !r.files.is_empty() {
        v["files_changed"] = json!(r.files);
    }
    v
}

fn out_view(o: &store::OutItem) -> Value {
    let mut v = json!({"id": o.id, "kind": o.kind, "canvas": shown(&o.canvas), "chat": o.chat_title, "text": o.text, "at_ms": o.at});
    if let Some(a) = &o.asked {
        v["asked"] = json!(a);
    }
    if !o.files.is_empty() {
        v["files_changed"] = json!(o.files);
    }
    if let Some(p) = &o.preview {
        v["preview_url"] = json!(p);
    }
    if o.kind == store::OutKind::Question {
        v["answered"] = json!(o.answered);
    }
    v
}

/// Holds the call until the request settles or its canvas's chat leaves something new, or until time is up.
/// It only reads the store, twice a second, so a long wait costs nothing on either side.
async fn wait(store: &Store, mac: &dyn Mac, args: &Value) -> Result<Value, String> {
    let id = arg(args, "id");
    let request = match id {
        Some(id) => Some(store.request(id).ok_or("Lantern has no request with that id.")?),
        None => None,
    };
    // A request's own canvas is what its chat posts to (work with no design posts with no canvas).
    let canvas: Option<String> = arg(args, "canvas").map(str::to_string).or_else(|| request.as_ref().map(|r| r.canvas.clone()));
    let only = |items: Vec<store::OutItem>| -> Vec<store::OutItem> {
        match &canvas {
            Some(c) if c.is_empty() => items.into_iter().filter(|o| o.canvas.is_empty()).collect(),
            _ => items,
        }
    };
    let filter = canvas.as_deref().filter(|c| !c.is_empty());
    // Without `after`, only what comes from now on counts.
    let mark = match arg(args, "after") {
        Some(a) => Some(a.to_string()),
        None => store.outbox(filter, None, usize::MAX).last().map(|o| o.id.clone()),
    };
    let seconds = args.get("seconds").and_then(Value::as_u64).unwrap_or(WAIT_DEFAULT).clamp(1, WAIT_MAX);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(seconds);
    loop {
        if !store.enabled() {
            return Err("The user turned the Lantern connector off.".into());
        }
        let settled = match id.and_then(|id| store.request(id)) {
            Some(r) => !matches!(r.status, store::Status::Waiting | store::Status::Working),
            None => false,
        };
        let items = only(store.outbox(filter, mark.as_deref(), 30));
        let timed_out = tokio::time::Instant::now() >= deadline;
        if settled || !items.is_empty() || timed_out {
            let after = items.last().map(|o| o.id.clone()).or(mark);
            let mut v = json!({
                "state": if settled || !items.is_empty() { "ready" } else { "still_working" },
                "items": items.iter().map(out_view).collect::<Vec<_>>(),
                "after": after,
            });
            if let Some(r) = id.and_then(|id| store.request(id)) {
                v["request"] = request_view(&r, &mac.projects().await);
                if !settled && r.status == store::Status::Waiting && !store.auto_run() {
                    v["note"] = json!("It still waits for the user's Run in Lantern.");
                }
            }
            if !settled && items.is_empty() {
                v["note"] = v.get("note").cloned().unwrap_or_else(|| json!("Nothing yet: call wait again with this `after`."));
            }
            return Ok(v);
        }
        tokio::time::sleep(WAIT_TICK.min(deadline - tokio::time::Instant::now())).await;
    }
}

async fn call(store: &Store, mac: &dyn Mac, grant: &str, name: &str, args: &Value, now: u64) -> Result<Value, String> {
    match name {
        "list_projects" => {
            let projects = mac.projects().await;
            let links = store.links();
            Ok(json!({"projects": projects.iter().map(|(folder, name)| json!({
                "name": name,
                "folder": folder,
                "canvases": links.iter().filter(|l| &l.folder == folder).map(|l| json!({"canvas": l.canvas, "title": l.title})).collect::<Vec<_>>()
            })).collect::<Vec<_>>()}))
        }
        "list_chats" => {
            let projects = mac.projects().await;
            let only = arg(args, "project").map(str::to_lowercase);
            let links = store.links();
            let chats: Vec<Value> = mac.chats().into_iter().filter_map(|c| {
                let project = c.folder.as_deref().map(|f| name_of(&projects, f));
                if only.as_ref().is_some_and(|o| project.as_deref().map(str::to_lowercase).as_ref() != Some(o)) {
                    return None;
                }
                // Work with no design is keyed by its project: it shows no canvas.
                let canvas = store.canvas_of_slot(&c.slot).filter(|k| !k.starts_with("project:")).and_then(|k| links.iter().find(|l| l.key == k).map(|l| l.canvas.clone()).or(Some(k)));
                let mut v = json!({"title": c.title, "project": project, "status": c.status, "canvas": canvas});
                // Only web Claude's own chats can be sent to, so only they have an id.
                if let Some(id) = c.conversation.as_deref().filter(|id| store.owns(id)) {
                    v["id"] = json!(id);
                }
                Some(v)
            }).collect();
            Ok(json!({"chats": chats}))
        }
        "send_to_lantern" => {
            let canvas = arg(args, "canvas").unwrap_or("");
            let message = need(args, "message")?;
            let projects = mac.projects().await;
            if canvas.trim().is_empty() && arg(args, "project").is_none() && arg(args, "chat").is_none() {
                return Err(format!("Name the design canvas this is about, or, when the work has no design, the project it is for. Lantern's projects: {}.", projects.iter().map(|(_, n)| n.as_str()).collect::<Vec<_>>().join(", ")));
            }
            let mut folder = match arg(args, "project") {
                None => None,
                Some(p) => {
                    let lower = p.to_lowercase();
                    let found = projects.iter().find(|(f, n)| f == p || n.to_lowercase() == lower).map(|(f, _)| f.clone());
                    Some(found.ok_or_else(|| format!("Lantern has no project called \"{p}\". Its projects: {}.", projects.iter().map(|(_, n)| n.as_str()).collect::<Vec<_>>().join(", ")))?)
                }
            };
            let title = match arg(args, "canvas_title") {
                Some(t) => t.to_string(),
                None if canvas.trim().is_empty() => format!("Work for {}", folder.as_deref().map(|f| name_of(&projects, f)).unwrap_or_default()),
                None => canvas.to_string(),
            };
            let new_chat = args.get("new_chat").and_then(Value::as_bool).unwrap_or(false);
            let place = match arg(args, "chat") {
                Some(_) if new_chat => return Err("Give either chat (one of your chats) or new_chat, not both.".into()),
                Some(id) => {
                    if !store.owns(id) {
                        return Err("That isn't one of your chats in Lantern: list_chats gives an id only to the chats your work went to.".into());
                    }
                    // The work runs where that chat is: a project named for it must be that chat's.
                    let chat_folder = mac.chats().into_iter().find(|c| c.conversation.as_deref() == Some(id)).and_then(|c| c.folder);
                    if let (Some(f), Some(cf)) = (&folder, &chat_folder) {
                        if f != cf {
                            return Err("That chat is in another project.".into());
                        }
                    }
                    folder = folder.or(chat_folder);
                    store::Place::Chat(id.to_string())
                }
                None if new_chat => store::Place::NewChat,
                None => store::Place::Usual,
            };
            let r = store.propose_to(Kind::Send, canvas, &title, message, folder, place, grant, now)?;
            let mut v = request_view(&r, &projects);
            v["note"] = json!(if store.auto_run() {
                "Lantern runs this on its own (the user turned that on): it starts in a moment, unless it has no project to run in, which the user then picks. Call wait with this id to hear back when it's done."
            } else {
                "Waiting for the user to tap Run in Lantern (on the Mac or the phone). Call wait with this id to hear back when it's done."
            });
            Ok(v)
        }
        "check" => {
            let id = need(args, "id")?;
            let r = store.request(id).ok_or("Lantern has no request with that id.")?;
            Ok(request_view(&r, &mac.projects().await))
        }
        "read_outbox" => {
            let items = store.outbox(arg(args, "canvas"), arg(args, "after"), 30);
            Ok(json!({"items": items.iter().map(out_view).collect::<Vec<_>>()}))
        }
        "wait" => wait(store, mac, args).await,
        "read_chat" => {
            let number = |name: &str| args.get(name).and_then(Value::as_u64).map(|n| n as usize);
            let slot = store.readable_chat(arg(args, "canvas"), arg(args, "id"))?;
            let events = mac.chat_events(&slot).ok_or("That chat isn't open in Lantern any more.")?;
            let all = super::transcript::entries(&events);
            let (entries, earlier, later) = super::transcript::page(&all, number("before"), number("after"));
            let line = mac.chats().into_iter().find(|c| c.slot == slot);
            let projects = mac.projects().await;
            Ok(json!({
                "chat": line.as_ref().and_then(|c| c.title.clone()),
                "project": line.as_ref().and_then(|c| c.folder.as_deref()).map(|f| name_of(&projects, f)),
                "status": line.map(|c| c.status),
                "total": all.len(),
                "earlier": earlier,
                "later": later,
                "entries": entries,
            }))
        }
        "answer" => {
            let r = store.propose_answer(need(args, "question_id")?, need(args, "text")?, grant, now)?;
            let mut v = request_view(&r, &mac.projects().await);
            v["note"] = json!(if store.auto_run() {
                "Lantern sends this to the chat that asked on its own (the user turned that on). Call wait with this id to hear back."
            } else {
                "Waiting for the user to tap Run in Lantern; then it goes to the chat that asked. Call wait with this id to hear back."
            });
            Ok(v)
        }
        _ => Err(format!("Lantern has no tool \"{name}\".")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeMac;
    impl Mac for FakeMac {
        fn projects(&self) -> BoxFut<Vec<(String, String)>> {
            Box::pin(async { vec![("/dev/rayak".into(), "rayak".into()), ("/dev/lantern".into(), "lantern".into())] })
        }
        fn chats(&self) -> Vec<ChatLine> {
            vec![
                ChatLine { slot: "s1".into(), title: Some("Header".into()), folder: Some("/dev/rayak".into()), status: "idle".into(), conversation: Some("aaaa-1111".into()) },
                ChatLine { slot: "s2".into(), title: Some("Footer".into()), folder: Some("/dev/rayak".into()), status: "idle".into(), conversation: Some("bbbb-2222".into()) },
            ]
        }
        fn chat_events(&self, slot: &str) -> Option<Vec<crate::ui_event::UiEvent>> {
            (slot == "s1").then(|| vec![
                crate::ui_event::UiEvent::UserText { text: "Make it blue".into(), at: None, sent_by: Some("desktop".into()), images: 0 },
                crate::ui_event::UiEvent::AssistantText { parent: None, block_id: "b".into(), text: "It's blue.".into() },
            ])
        }
    }

    async fn rpc(store: &Store, method: &str, params: Value) -> Value {
        handle(store, &FakeMac, "g", &json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}), 100).await.unwrap()
    }

    async fn tool(store: &Store, name: &str, args: Value) -> Value {
        rpc(store, "tools/call", json!({"name": name, "arguments": args})).await["result"].clone()
    }

    #[tokio::test]
    async fn it_says_hello_in_the_clients_protocol_and_lists_eight_tools() {
        let s = Store::load(None);
        let init = rpc(&s, "initialize", json!({"protocolVersion": "2025-03-26"})).await;
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert!(init["result"]["instructions"].as_str().unwrap().contains("Run"));
        let unknown = rpc(&s, "initialize", json!({"protocolVersion": "1999"})).await;
        assert_eq!(unknown["result"]["protocolVersion"], PROTOCOLS[0]);
        let names: Vec<String> = rpc(&s, "tools/list", json!({})).await["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, ["list_projects", "list_chats", "send_to_lantern", "check", "read_outbox", "read_chat", "wait", "answer"]);
        assert!(handle(&s, &FakeMac, "g", &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}), 1).await.is_none());
        assert_eq!(rpc(&s, "nope", json!({})).await["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn sending_makes_a_card_in_the_named_project_and_check_follows_it() {
        let s = Store::load(None);
        let r = tool(&s, "send_to_lantern", json!({"canvas": "https://claude.ai/artifact/abc", "canvas_title": "Rayak", "message": "Build it", "project": "Rayak"})).await;
        assert_eq!(r["isError"], false);
        let v = &r["structuredContent"];
        assert_eq!((v["state"].as_str(), v["project"].as_str()), (Some("waiting_for_run"), Some("rayak")));
        assert_eq!(s.cards(100).len(), 1);
        let c = tool(&s, "check", json!({"id": v["id"]})).await;
        assert_eq!(c["structuredContent"]["state"], "waiting_for_run");
        let bad = tool(&s, "send_to_lantern", json!({"canvas": "x", "message": "m", "project": "nope"})).await;
        assert_eq!(bad["isError"], true);
        assert!(bad["content"][0]["text"].as_str().unwrap().contains("rayak, lantern"));
        assert_eq!(tool(&s, "send_to_lantern", json!({"canvas": "x"})).await["isError"], true);
        assert_eq!(tool(&s, "check", json!({"id": "nope"})).await["isError"], true);
    }

    #[tokio::test]
    async fn work_with_no_design_needs_a_project_and_shows_no_canvas() {
        let s = Store::load(None);
        let none = tool(&s, "send_to_lantern", json!({"message": "Make the header sticky"})).await;
        assert_eq!(none["isError"], true);
        assert!(none["content"][0]["text"].as_str().unwrap().contains("project"));
        let r = tool(&s, "send_to_lantern", json!({"message": "Make the header sticky", "project": "rayak"})).await;
        assert_eq!(r["isError"], false, "{r}");
        let v = &r["structuredContent"];
        assert_eq!((v["canvas"].clone(), v["project"].as_str()), (Value::Null, Some("rayak")));
        assert!(matches!(&s.cards(100)[0], store::Card::Run { title, canvas, .. } if title == "Work for rayak" && canvas.is_empty()));
        assert!(!s.request(v["id"].as_str().unwrap()).unwrap().new_chat, "follow-ups go on in the project's chat");
        let own = tool(&s, "send_to_lantern", json!({"message": "Something unrelated", "project": "rayak", "new_chat": true})).await;
        assert!(s.request(own["structuredContent"]["id"].as_str().unwrap()).unwrap().new_chat);
    }

    #[tokio::test]
    async fn projects_and_chats_show_the_canvases_they_work_on() {
        let s = Store::load(None);
        let r = s.propose(Kind::Send, "https://claude.ai/artifact/abc", "Rayak", "m", Some("/dev/rayak".into()), "g", 1).unwrap();
        s.decide_run(&r.id, true, None).unwrap();
        s.started(&r.id, "s1", None);
        let p = tool(&s, "list_projects", json!({})).await;
        assert_eq!(p["structuredContent"]["projects"][0]["canvases"][0]["title"], "Rayak");
        let c = tool(&s, "list_chats", json!({"project": "rayak"})).await;
        assert_eq!(c["structuredContent"]["chats"][0]["canvas"], "https://claude.ai/artifact/abc");
        assert_eq!(tool(&s, "list_chats", json!({"project": "lantern"})).await["structuredContent"]["chats"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn only_web_claude_s_own_chats_have_an_id_and_can_be_picked() {
        let s = Store::load(None);
        let r = s.propose(Kind::Send, "", "x", "m", Some("/dev/rayak".into()), "g", 1).unwrap();
        s.decide_run(&r.id, true, None).unwrap();
        s.started(&r.id, "s1", None);
        s.holds("s1", "aaaa-1111");
        let chats = tool(&s, "list_chats", json!({"project": "rayak"})).await["structuredContent"]["chats"].clone();
        assert_eq!((chats[0]["id"].as_str(), chats[1].get("id")), (Some("aaaa-1111"), None), "the user's own chat has none");
        // Picked by its id, the work runs in that chat's project without naming it.
        let sent = tool(&s, "send_to_lantern", json!({"message": "Add it to the build", "chat": "aaaa-1111"})).await;
        assert_eq!(sent["isError"], false, "{sent}");
        let req = s.request(sent["structuredContent"]["id"].as_str().unwrap()).unwrap();
        assert_eq!((req.chat.as_deref(), req.folder.as_deref()), (Some("aaaa-1111"), Some("/dev/rayak")));
        assert_eq!(tool(&s, "send_to_lantern", json!({"message": "m", "chat": "bbbb-2222"})).await["isError"], true, "not its chat");
        assert_eq!(tool(&s, "send_to_lantern", json!({"message": "m", "chat": "aaaa-1111", "new_chat": true})).await["isError"], true);
        assert_eq!(tool(&s, "send_to_lantern", json!({"message": "m", "chat": "aaaa-1111", "project": "lantern"})).await["isError"], true, "another project");
    }

    #[tokio::test]
    async fn read_chat_reads_the_whole_chat_on_a_canvas_and_nothing_else() {
        let s = Store::load(None);
        assert_eq!(tool(&s, "read_chat", json!({"canvas": "https://claude.ai/artifact/abc"})).await["isError"], true, "no chat on it yet");
        let r = s.propose(Kind::Send, "https://claude.ai/artifact/abc", "Rayak", "m", Some("/dev/rayak".into()), "g", 1).unwrap();
        s.decide_run(&r.id, true, None).unwrap();
        s.started(&r.id, "s1", None);
        for args in [json!({"canvas": "https://claude.ai/artifact/abc"}), json!({"id": r.id})] {
            let v = &tool(&s, "read_chat", args).await["structuredContent"];
            assert_eq!((v["chat"].as_str(), v["project"].as_str(), v["total"].as_u64(), v["earlier"].as_bool()), (Some("Header"), Some("rayak"), Some(2), Some(false)));
            assert_eq!((v["entries"][0]["from"].as_str(), v["entries"][1]["text"].as_str()), (Some("user"), Some("It's blue.")));
        }
        let later = &tool(&s, "read_chat", json!({"canvas": "https://claude.ai/artifact/abc", "after": 1})).await["structuredContent"];
        assert_eq!(later["entries"].as_array().unwrap().len(), 1);
        assert_eq!(tool(&s, "read_chat", json!({"canvas": "Another canvas"})).await["isError"], true);
    }

    fn done() -> crate::ui_event::UiEvent {
        crate::ui_event::UiEvent::TurnDone { is_error: false, result: None, cost_usd: None, tokens: None, session_cost_usd: None, session_tokens: 0, duration_ms: None, auth_hint: false, denied: 0, context_window: None }
    }

    #[tokio::test(start_paused = true)]
    async fn wait_holds_until_the_chat_is_done_then_hands_back_its_reply() {
        let s = Store::load(None);
        s.set_enabled(true);
        let canvas = "https://claude.ai/artifact/abc";
        let r = s.propose(Kind::Send, canvas, "Rayak", "m", Some("/dev/rayak".into()), "g", 1).unwrap();
        s.decide_run(&r.id, true, None).unwrap();
        s.started(&r.id, "s1", None);

        let nothing = &tool(&s, "wait", json!({"id": r.id, "seconds": 5})).await["structuredContent"];
        assert_eq!((nothing["state"].as_str(), nothing["request"]["state"].as_str()), (Some("still_working"), Some("working")));
        assert!(nothing["note"].as_str().unwrap().contains("again"));

        let finish = async {
            tokio::time::sleep(std::time::Duration::from_secs(20)).await;
            s.on_event("s1", &crate::ui_event::UiEvent::AssistantText { parent: None, block_id: "b".into(), text: "The header is blue.".into() }, 2);
            s.on_event("s1", &done(), 2);
        };
        let started = tokio::time::Instant::now();
        let (got, ()) = tokio::join!(tool(&s, "wait", json!({"id": r.id})), finish);
        let got = &got["structuredContent"];
        assert!(started.elapsed() < std::time::Duration::from_secs(25), "it returns when the turn ends, not at its time limit");
        assert_eq!((got["state"].as_str(), got["request"]["state"].as_str(), got["request"]["reply"].as_str()), (Some("ready"), Some("done"), Some("The header is blue.")));
        assert_eq!(got["items"][0]["text"], "The header is blue.");
        assert_eq!(got["after"], got["items"][0]["id"]);

        // Following the canvas from there: only what comes after counts, and the user's own next turn comes back too.
        let next = async {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            s.on_event("s1", &crate::ui_event::UiEvent::UserText { text: "Make it red".into(), at: None, sent_by: Some("desktop".into()), images: 0 }, 3);
            s.on_event("s1", &crate::ui_event::UiEvent::AssistantText { parent: None, block_id: "c".into(), text: "Red now.".into() }, 3);
            s.on_event("s1", &done(), 3);
        };
        let (followed, ()) = tokio::join!(tool(&s, "wait", json!({"canvas": canvas, "after": got["after"]})), next);
        let followed = &followed["structuredContent"];
        assert_eq!((followed["state"].as_str(), followed["items"].as_array().unwrap().len(), followed["items"][0]["asked"].as_str()), (Some("ready"), 1, Some("Make it red")));

        s.set_enabled(false);
        assert_eq!(tool(&s, "wait", json!({"canvas": canvas})).await["isError"], true, "the connector off ends a wait");
    }

    #[tokio::test(start_paused = true)]
    async fn wait_says_when_work_still_needs_the_users_run() {
        let s = Store::load(None);
        s.set_enabled(true);
        let r = tool(&s, "send_to_lantern", json!({"message": "Make the header sticky", "project": "rayak"})).await;
        assert!(r["structuredContent"]["note"].as_str().unwrap().contains("wait"));
        let v = &tool(&s, "wait", json!({"id": r["structuredContent"]["id"], "seconds": 999})).await["structuredContent"];
        assert_eq!((v["state"].as_str(), v["request"]["state"].as_str()), (Some("still_working"), Some("waiting_for_run")));
        assert!(v["note"].as_str().unwrap().contains("Run"));
        assert_eq!(tool(&s, "wait", json!({"id": "nope"})).await["isError"], true);
    }
}
