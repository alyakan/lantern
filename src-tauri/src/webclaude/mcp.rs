//! The connector's MCP side: JSON-RPC as claude.ai's servers send it (Streamable HTTP, one JSON reply per request), and
//! the seven tools web Claude gets. Nothing here runs anything on the Mac: sending work makes a card that waits for the
//! user's Run (see store.rs); the rest reads.

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

const INSTRUCTIONS: &str = "Lantern is the user's Mac app that runs Claude Code chats on the user's projects. Use it to hand design work from a canvas to the code: send_to_lantern puts a card in Lantern with your message; nothing runs until the user taps Run there, so tell the user it is waiting. Name the canvas by its claude.ai link when you have it (the chat in Lantern reads the design from it). Work that isn't about a design can be sent too: leave the canvas out and name the project. Then call check with the id to see how it went (always check before saying where a request stands, or before sending it again): when the chat is done its last message comes back, with the files it changed. A chat that works on your canvas is yours to follow: every turn it finishes (also those the user starts there themselves) leaves its last message in the outbox, and read_chat reads all of it, step by step. Chats in Lantern can leave you questions and notes (preview links to what they built): read_outbox shows them, and answer replies to a question (also after the user's Run). Lantern can't reach you on its own, so look at the outbox when the user asks what Lantern did or said.";

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
            "description": "The chats open in Lantern: their title, project, what they are doing, and the canvas a chat works on when it was started from here.",
            "inputSchema": {"type": "object", "properties": {"project": {"type": "string", "description": "Only this project's chats (its name from list_projects)."}}},
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "send_to_lantern",
            "description": "Send work to Lantern: about a design canvas, or for a project when there is no design. It shows the user a card; nothing happens until the user taps Run. On Run, work on a canvas goes to the chat already working on that canvas, or a new chat in the canvas's project; work with no design always starts a new chat in its project. Returns an id: call check with it before saying how the work went or sending more about it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "canvas": {"type": "string", "description": "The canvas's claude.ai link (best), or its exact title. Leave it out when the work isn't about a design (then name the project); never put a project's name here."},
                    "canvas_title": {"type": "string", "description": "The canvas's title, for the user's card."},
                    "message": {"type": "string", "description": "What the chat should do or answer, complete on its own: the chat sees this message and the canvas, not this conversation."},
                    "project": {"type": "string", "description": "The project's name from list_projects. Needed when there is no canvas. With a canvas, leave it out when the canvas is linked already, or to let the user pick."}
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
                Some(json!({"title": c.title, "project": project, "status": c.status, "canvas": canvas}))
            }).collect();
            Ok(json!({"chats": chats}))
        }
        "send_to_lantern" => {
            let canvas = arg(args, "canvas").unwrap_or("");
            let message = need(args, "message")?;
            let projects = mac.projects().await;
            if canvas.trim().is_empty() && arg(args, "project").is_none() {
                return Err(format!("Name the design canvas this is about, or, when the work has no design, the project it is for. Lantern's projects: {}.", projects.iter().map(|(_, n)| n.as_str()).collect::<Vec<_>>().join(", ")));
            }
            let folder = match arg(args, "project") {
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
            let r = store.propose(Kind::Send, canvas, &title, message, folder, grant, now)?;
            let mut v = request_view(&r, &projects);
            v["note"] = json!("Waiting for the user to tap Run in Lantern (on the Mac or the phone). Call check with this id to follow it.");
            Ok(v)
        }
        "check" => {
            let id = need(args, "id")?;
            let r = store.request(id).ok_or("Lantern has no request with that id.")?;
            Ok(request_view(&r, &mac.projects().await))
        }
        "read_outbox" => {
            let items = store.outbox(arg(args, "canvas"), arg(args, "after"), 30);
            Ok(json!({"items": items.iter().map(|o| {
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
            }).collect::<Vec<_>>()}))
        }
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
            v["note"] = json!("Waiting for the user to tap Run in Lantern; then it goes to the chat that asked. Call check with this id to follow it.");
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
            vec![ChatLine { slot: "s1".into(), title: Some("Header".into()), folder: Some("/dev/rayak".into()), status: "idle".into() }]
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
    async fn it_says_hello_in_the_clients_protocol_and_lists_seven_tools() {
        let s = Store::load(None);
        let init = rpc(&s, "initialize", json!({"protocolVersion": "2025-03-26"})).await;
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert!(init["result"]["instructions"].as_str().unwrap().contains("Run"));
        let unknown = rpc(&s, "initialize", json!({"protocolVersion": "1999"})).await;
        assert_eq!(unknown["result"]["protocolVersion"], PROTOCOLS[0]);
        let names: Vec<String> = rpc(&s, "tools/list", json!({})).await["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, ["list_projects", "list_chats", "send_to_lantern", "check", "read_outbox", "read_chat", "answer"]);
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
}
