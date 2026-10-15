use super::catalogue::{self, Offer};
use super::protocol::{decision_json, BridgeRequest, BridgeResponse};
use serde_json::{json, Value};

/// The name the app shows for a reproduce request (not a real tool, so it can't clash with one).
pub const REPRODUCE: &str = "Reproduce";
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;

/// Tools every chat has that only say or show something, so they run without asking: Step by step's own instructions
/// (`steps_guide`), and what the Changes pane compares while reviewing (`review_target`).
pub const LANTERN_TOOLS: &[&str] = &["steps_guide", "review_target"];

/// The tools only a Team's lead has (see orchestra.rs). Each returns at once: this helper answers one message at a
/// time, so a call that waited would hold up the permission prompts behind it.
pub const ORCHESTRA_TOOLS: &[&str] = &["spawn_agent", "list_agents", "read_agent", "message_agent", "stop_agent", "propose_merge"];

/// A tool call's result as the model reads it.
fn result_json(text: String, is_error: bool) -> Value {
    json!({"isError": is_error, "content": [{"type": "text", "text": text}]})
}

/// What the app answered a tool call with: its message when it gave one, else a line that says what to do about it.
fn app_result(tool: &str, resp: BridgeResponse) -> Value {
    let text = resp.message.unwrap_or_else(|| {
        if resp.allow {
            format!("{tool} finished; Lantern had nothing to add.")
        } else {
            format!("{tool} failed inside Lantern without a reason; try once more, then tell the user.")
        }
    });
    result_json(text, !resp.allow)
}

/// One MCP server session: which tools this helper's chat has, and the protocol revision negotiated with its client.
pub struct Server {
    offer: Offer,
    version: &'static str,
}

impl Server {
    pub fn new(offer: Offer) -> Self {
        Self { offer, version: catalogue::negotiate(None) }
    }

    /// Answers one MCP JSON-RPC message. Returns None for notifications (no `id`). `initialize` settles the revision the
    /// tool list is then described in. A caller that claims the lead role without being its helper gets nowhere: the app
    /// lets an orchestra call through only when the OS says the helper is that chat's own process (see PermissionBridge).
    pub fn handle(&mut self, msg: &Value, ask: &dyn Fn(BridgeRequest) -> BridgeResponse) -> Option<Value> {
        let id = msg.get("id")?.clone();
        let result = match msg["method"].as_str().unwrap_or("") {
            "initialize" => {
                self.version = catalogue::negotiate(msg["params"]["protocolVersion"].as_str());
                json!({
                    "protocolVersion": self.version,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "lantern", "version": env!("CARGO_PKG_VERSION")},
                    "instructions": catalogue::instructions(self.offer)
                })
            }
            "tools/list" => json!({"tools": catalogue::tool_list(self.offer, self.version)}),
            "tools/call" => self.call(&msg["params"], ask),
            // MCP's keep-alive: answered with nothing.
            "ping" => json!({}),
            // A request this server doesn't have: the client is told so, rather than given an empty result.
            _ => return Some(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "Method not found"}})),
        };
        Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
    }

    fn call(&self, params: &Value, ask: &dyn Fn(BridgeRequest) -> BridgeResponse) -> Value {
        let tool = params["name"].as_str().unwrap_or("");
        let args = &params["arguments"];
        match tool {
            // The CLI's permission prompt: the one call whose arguments are a request to the user.
            "approve" => {
                let req = BridgeRequest::permission(args["tool_name"].as_str().unwrap_or("").to_string(), args["input"].clone(), args["tool_use_id"].as_str().map(String::from));
                let resp = ask(req.clone());
                json!({"content": [{"type": "text", "text": decision_json(&req.input, &resp).to_string()}]})
            }
            t if ORCHESTRA_TOOLS.contains(&t) => {
                if self.offer.orchestrator {
                    app_result(t, ask(BridgeRequest { tool_name: t.into(), input: args.clone(), tool_use_id: None, orchestra: true, network: false, review: false }))
                } else {
                    result_json(format!("{t} is only available to a Team's lead."), true)
                }
            }
            "steps_guide" => match steps_guide_text(args["flavour"].as_str().unwrap_or("")) {
                Ok(text) => result_json(text, false),
                Err(text) => result_json(text, true),
            },
            // The app is told what the pane should compare, and answers once the window has it.
            "review_target" => match ReviewTargetArgs::parse(args) {
                Ok(target) => {
                    let resp = ask(BridgeRequest { tool_name: tool.into(), input: args.clone(), tool_use_id: None, orchestra: false, network: false, review: true });
                    if resp.allow && resp.message.is_none() {
                        result_json(target.says(), false)
                    } else {
                        app_result(tool, resp)
                    }
                }
                Err(text) => result_json(text, true),
            },
            // Answered by the app at once (it reads Network Monitor on loopback), for any chat.
            t if crate::network::TOOLS.contains(&t) => app_result(t, ask(BridgeRequest { tool_name: t.into(), input: args.clone(), tool_use_id: None, orchestra: false, network: true, review: false })),
            "reproduce" if self.offer.steps => {
                let resp = ask(BridgeRequest::permission(REPRODUCE.into(), args.clone(), None));
                if resp.failed {
                    return result_json("Lantern couldn't show the reproduce card. Ask the user in your message to reproduce it and end your turn.".into(), true);
                }
                let note = resp.message.filter(|m| !m.trim().is_empty()).map(|m| format!(" Their note: {m}")).unwrap_or_default();
                let text = if resp.allow { format!("The user reproduced the problem.{note}") } else { format!("The user could not reproduce the problem.{note}") };
                json!({"content": [{"type": "text", "text": text}]})
            }
            "reproduce" => result_json("reproduce only works in Step by step's Debug flavour. Ask the user to reproduce it in your message and end your turn.".into(), true),
            other => {
                let listed: Vec<String> = catalogue::tool_list(self.offer, self.version).iter().filter_map(|t| t["name"].as_str()).filter(|n| *n != "approve").map(String::from).collect();
                result_json(format!("Lantern has no tool \"{other}\". Its tools here are: {}.", listed.join(", ")), true)
            }
        }
    }
}

/// Answers one MCP JSON-RPC message in a fresh session (a chat that isn't a Team's lead, and isn't in Step by step).
pub fn handle_message(msg: &Value, ask: &dyn Fn(BridgeRequest) -> BridgeResponse) -> Option<Value> {
    handle_message_as(msg, ask, Offer::default())
}

/// One message in a fresh session of a helper that offers `offer` (see `Server`).
pub fn handle_message_as(msg: &Value, ask: &dyn Fn(BridgeRequest) -> BridgeResponse, offer: Offer) -> Option<Value> {
    Server::new(offer).handle(msg, ask)
}

/// What steps_guide answers: the rules every flavour shares, then the asked flavour's section (or every flavour's). Err
/// when there is no such flavour.
pub fn steps_guide_text(flavour: &str) -> Result<String, String> {
    use crate::args::{flavour_guide, steps_rules, EXPLAIN, FLAVOURS};
    let one = (!flavour.trim().is_empty()).then(|| flavour_guide(flavour)).flatten();
    if !flavour.trim().is_empty() && one.is_none() {
        return Err(format!("There is no flavour {flavour:?}. Step by step's flavours are {}, and its option is {EXPLAIN}.", FLAVOURS.join(", ")));
    }
    let sections: Vec<String> = match one {
        Some(g) => vec![g.text],
        None => FLAVOURS.iter().chain([&EXPLAIN]).filter_map(|f| flavour_guide(f)).map(|g| g.text).collect(),
    };
    Ok(format!("{}\n\n{}", steps_rules(), sections.join("\n\n")))
}

/// What a review_target call names: a pull request, or the checked-out branch against `base` (None: Lantern finds it).
#[derive(Debug, Clone, PartialEq)]
pub struct ReviewTargetArgs {
    pub pr: Option<u64>,
    pub base: Option<String>,
}

impl ReviewTargetArgs {
    /// Checks a call's arguments. The helper does it before asking the app, and the app again before it shows anything.
    pub fn parse(args: &Value) -> Result<Self, String> {
        let pr = match &args["pr"] {
            Value::Null => None,
            v => Some(v.as_u64().filter(|n| (1..10_000_000).contains(n)).ok_or("`pr` is a pull request's number, or null for a local branch.")?),
        };
        let base = match &args["base"] {
            Value::Null => None,
            Value::String(s) if s.trim().is_empty() => None,
            Value::String(s) if s.len() <= 200 && !s.starts_with('-') && !s.contains("..") && s.chars().all(|c| c.is_ascii_alphanumeric() || "._/-".contains(c)) => Some(s.trim().to_string()),
            _ => return Err("`base` is a branch name, such as feat/core or origin/main.".into()),
        };
        Ok(Self { pr, base })
    }

    /// What the model reads back: what the Changes pane shows now.
    pub fn says(&self) -> String {
        match (self.pr, &self.base) {
            (Some(n), _) => format!("The Changes pane shows pull request #{n}'s changes now."),
            (None, Some(b)) => format!("The Changes pane shows the checked-out branch's changes since {b} now."),
            (None, None) => "The Changes pane shows the checked-out branch's changes now, against the branch Lantern finds it was built on.".into(),
        }
    }
}

/// Sends the request to the app and waits for the user's answer. Any failure means deny (and says `failed`).
pub fn ask_bridge(socket: Option<&str>, req: &BridgeRequest) -> BridgeResponse {
    let attempt = || -> io::Result<BridgeResponse> {
        let path = socket.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "LANTERN_SOCKET is not set"))?;
        let mut stream = UnixStream::connect(path)?;
        writeln!(stream, "{}", serde_json::to_string(req)?)?;
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line)?;
        serde_json::from_str(&line).map_err(io::Error::other)
    };
    attempt().unwrap_or_else(|e| BridgeResponse {
        allow: false,
        message: Some(format!("Lantern could not show the permission prompt ({e}), so the action was denied.")),
        updated_input: None,
        failed: true,
    })
}

/// The `--permission-helper` main loop: newline-delimited JSON-RPC on stdin/stdout.
pub fn run_helper(input: impl BufRead, output: impl Write, socket: Option<&str>) -> io::Result<()> {
    run_helper_as(input, output, socket, Offer::default())
}

/// `offer`: which tools this helper's chat has (`LANTERN_ROLE`, `LANTERN_STEPS`: see `Offer::from_env`).
pub fn run_helper_as(mut input: impl BufRead, mut output: impl Write, socket: Option<&str>, offer: Offer) -> io::Result<()> {
    let ask = |req: BridgeRequest| ask_bridge(socket, &req);
    let mut server = Server::new(offer);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        if input.read_until(b'\n', &mut buf)? == 0 {
            return Ok(());
        }
        // Bytes that aren't a JSON message are skipped: a bad line must not end the helper, or every later prompt is denied.
        let Ok(msg) = serde_json::from_slice::<Value>(&buf) else { continue };
        if let Some(reply) = server.handle(&msg, &ask) {
            writeln!(output, "{reply}")?;
            output.flush()?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const LEAD: Offer = Offer { orchestrator: true, steps: false };
    const STEPS: Offer = Offer { orchestrator: false, steps: true };

    fn allow_all(_: BridgeRequest) -> BridgeResponse {
        BridgeResponse { allow: true, message: None, updated_input: None, failed: false }
    }

    fn call(tool: &str, input: Value) -> Value {
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
               "params": {"name": "approve", "arguments": {"tool_name": tool, "input": input, "tool_use_id": "toolu_1"}}})
    }

    fn decision(reply: &Value) -> Value {
        serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
    }

    #[test]
    fn initialize_echoes_a_protocol_version_lantern_implements_and_answers_another_with_its_latest() {
        let init = |v: Value| handle_message(&json!({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": v}}), &allow_all).unwrap();
        let r = init(json!("2025-06-18"));
        assert_eq!(r["id"], 0);
        assert_eq!(r["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(r["result"]["serverInfo"]["name"], "lantern");
        assert!(r["result"]["capabilities"]["tools"].is_object());
        assert_eq!(init(json!("2099-01-01"))["result"]["protocolVersion"], "2025-11-25");
        assert_eq!(init(json!(null))["result"]["protocolVersion"], "2025-11-25");
    }

    #[test]
    fn initialize_carries_instructions_for_this_chats_tools() {
        let init = |offer| handle_message_as(&json!({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {}}), &allow_all, offer).unwrap()["result"]["instructions"].as_str().unwrap().to_string();
        let plain = init(Offer::default());
        assert!(plain.contains("[Lantern: ") && plain.contains("network_summarize") && !plain.contains("reproduce") && !plain.contains("spawn_agent"));
        assert!(init(STEPS).contains("reproduce") && !init(STEPS).contains("spawn_agent"));
        assert!(init(LEAD).contains("spawn_agent") && !init(LEAD).contains("reproduce"));
    }

    #[test]
    fn titles_and_annotations_follow_the_version_negotiated_at_initialize() {
        let mut server = Server::new(Offer::default());
        let list = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"});
        let init = |v: &str| json!({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": v}});
        server.handle(&init("2024-11-05"), &allow_all);
        let old = server.handle(&list, &allow_all).unwrap();
        assert!(old["result"]["tools"][0].get("annotations").is_none() && old["result"]["tools"][0].get("title").is_none());
        server.handle(&init("2025-06-18"), &allow_all);
        let new = server.handle(&list, &allow_all).unwrap();
        assert!(new["result"]["tools"][0]["annotations"].is_object() && new["result"]["tools"][0]["title"].is_string());
    }

    #[test]
    fn notifications_get_no_reply() {
        assert!(handle_message(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}), &allow_all).is_none());
    }

    #[test]
    fn lists_the_approve_tool() {
        let r = handle_message(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}), &allow_all).unwrap();
        assert_eq!(r["result"]["tools"][0]["name"], "approve");
    }

    #[test]
    fn allow_returns_updated_input() {
        let seen = std::cell::RefCell::new(None);
        let r = handle_message(&call("Bash", json!({"command": "npm test"})), &|req| {
            *seen.borrow_mut() = Some(req);
            BridgeResponse { allow: true, message: None, updated_input: None, failed: false }
        })
        .unwrap();
        assert_eq!(decision(&r), json!({"behavior": "allow", "updatedInput": {"command": "npm test"}}));
        let req = seen.borrow().clone().unwrap();
        assert_eq!(req.tool_name, "Bash");
        assert_eq!(req.tool_use_id.as_deref(), Some("toolu_1"));
    }

    #[test]
    fn deny_has_default_message() {
        let r = handle_message(&call("Bash", json!({"command": "rm -rf x"})), &|_| BridgeResponse { allow: false, message: None, updated_input: None, failed: false }).unwrap();
        assert_eq!(decision(&r), json!({"behavior": "deny", "message": "The user denied this action."}));
    }

    #[test]
    fn reproduce_asks_the_user_and_reports_back_with_their_note() {
        let seen = std::cell::RefCell::new(None);
        let msg = json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "reproduce", "arguments": {"steps": "1. Open settings"}}});
        let r = handle_message_as(&msg, &|req| {
            *seen.borrow_mut() = Some(req);
            BridgeResponse { allow: true, message: Some("[lantern-debug] token=null".into()), updated_input: None, failed: false }
        }, STEPS)
        .unwrap();
        assert_eq!(r["result"]["content"][0]["text"], "The user reproduced the problem. Their note: [lantern-debug] token=null");
        let req = seen.borrow().clone().unwrap();
        assert_eq!((req.tool_name.as_str(), req.input["steps"].as_str()), (REPRODUCE, Some("1. Open settings")));
        let r = handle_message_as(&msg, &|_| BridgeResponse { allow: false, message: None, updated_input: None, failed: false }, STEPS).unwrap();
        assert_eq!(r["result"]["content"][0]["text"], "The user could not reproduce the problem.");
        assert!(r["result"].get("isError").is_none());
        let tools = handle_message_as(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}), &allow_all, STEPS).unwrap();
        assert!(tool_names(&tools).contains(&"reproduce".to_string()));
    }

    #[test]
    fn reproduce_outside_step_by_step_is_an_error_that_says_what_to_do_instead_and_asks_no_one() {
        let called = std::cell::Cell::new(false);
        let msg = json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "reproduce", "arguments": {"steps": "x"}}});
        let r = handle_message(&msg, &|_| {
            called.set(true);
            BridgeResponse { allow: true, message: None, updated_input: None, failed: false }
        })
        .unwrap();
        assert!(!called.get());
        assert_eq!(r["result"]["isError"], true);
        assert_eq!(r["result"]["content"][0]["text"], "reproduce only works in Step by step's Debug flavour. Ask the user to reproduce it in your message and end your turn.");
        let tools = handle_message(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}), &allow_all).unwrap();
        assert!(!tool_names(&tools).contains(&"reproduce".to_string()));
    }

    #[test]
    fn a_reproduce_card_that_could_not_be_shown_is_an_error_not_a_user_who_could_not_reproduce() {
        let msg = json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "reproduce", "arguments": {"steps": "x"}}});
        let r = handle_message_as(&msg, &|_| BridgeResponse { allow: false, message: Some("Lantern could not show the permission prompt (x).".into()), updated_input: None, failed: true }, STEPS).unwrap();
        assert_eq!(r["result"]["isError"], true);
        assert_eq!(r["result"]["content"][0]["text"], "Lantern couldn't show the reproduce card. Ask the user in your message to reproduce it and end your turn.");
        // Through the real client: a socket that isn't there is a failure, a user's "no" is not.
        let socket_down = |req: BridgeRequest| ask_bridge(Some("/nonexistent/lantern.sock"), &req);
        assert!(socket_down(BridgeRequest::permission("Reproduce".into(), json!({}), None)).failed);
    }

    #[test]
    fn an_unknown_tool_is_an_error_naming_the_tools_there_are_and_only_approve_is_a_permission_prompt() {
        let called = std::cell::Cell::new(false);
        let msg = json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "frobnicate", "arguments": {"tool_name": "Bash", "input": {}}}});
        let r = handle_message(&msg, &|_| {
            called.set(true);
            BridgeResponse { allow: true, message: None, updated_input: None, failed: false }
        })
        .unwrap();
        assert!(!called.get(), "an unknown tool name reached the permission path");
        assert_eq!(r["result"]["isError"], true);
        let text = r["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.starts_with("Lantern has no tool \"frobnicate\". Its tools here are: steps_guide, review_target, network_requests"), "{text}");
        assert!(!text.contains("approve") && !text.contains("spawn_agent") && text.ends_with("network_summarize."), "{text}");
        let tools = handle_message(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}), &allow_all).unwrap();
        let approve = tools["result"]["tools"].as_array().unwrap().iter().find(|t| t["name"] == "approve").unwrap().clone();
        assert_eq!(approve["description"], "Internal: Claude Code's permission prompt. Lantern calls it for the CLI; never call it yourself.");
    }

    #[test]
    fn an_answer_with_no_words_tells_the_model_what_to_do() {
        let msg = json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "network_watches", "arguments": {}}});
        let r = handle_message(&msg, &|_| BridgeResponse { allow: false, message: None, updated_input: None, failed: false }).unwrap();
        assert_eq!((r["result"]["isError"].clone(), r["result"]["content"][0]["text"].clone()), (json!(true), json!("network_watches failed inside Lantern without a reason; try once more, then tell the user.")));
    }

    fn tool_names(reply: &Value) -> Vec<String> {
        reply["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn only_the_main_agents_helper_lists_the_orchestra_tools() {
        let list = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"});
        let every_chats: Vec<&str> = ["approve", "steps_guide", "review_target"].into_iter().chain(crate::network::TOOLS.iter().copied()).collect();
        assert_eq!(tool_names(&handle_message_as(&list, &allow_all, Offer::default()).unwrap()), every_chats);
        let names = tool_names(&handle_message_as(&list, &allow_all, LEAD).unwrap());
        assert_eq!(names[..every_chats.len()], every_chats);
        assert_eq!(names[every_chats.len()..], *ORCHESTRA_TOOLS);
    }

    #[test]
    fn a_network_call_from_any_chat_goes_to_the_app_flagged_and_comes_back_as_the_tool_result() {
        let seen = std::cell::RefCell::new(None);
        let msg = json!({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "network_watch", "arguments": {"label": "Users", "url": "/users"}}});
        let r = handle_message_as(&msg, &|req| {
            *seen.borrow_mut() = Some(req);
            BridgeResponse { allow: true, message: Some("Watching.".into()), updated_input: None, failed: false }
        }, Offer::default())
        .unwrap();
        assert_eq!((r["result"]["isError"].clone(), r["result"]["content"][0]["text"].clone()), (json!(false), json!("Watching.")));
        let req = seen.borrow().clone().unwrap();
        assert!(req.network && !req.orchestra);
        assert_eq!((req.tool_name.as_str(), req.input["url"].as_str()), ("network_watch", Some("/users")));
    }

    #[test]
    fn spawn_agent_takes_an_optional_provider_and_leaves_the_choice_of_one_to_the_app() {
        let list = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"});
        let tools = handle_message_as(&list, &allow_all, LEAD).unwrap();
        let spawn = tools["result"]["tools"].as_array().unwrap().iter().find(|t| t["name"] == "spawn_agent").unwrap().clone();
        assert_eq!(spawn["inputSchema"]["required"], json!(["name", "brief"]));
        // No list of names in the schema: which providers exist is up to the app, which answers a wrong one with the right ones.
        assert_eq!(spawn["inputSchema"]["properties"]["provider"]["type"], "string");
        assert!(spawn["inputSchema"]["properties"]["provider"].get("enum").is_none());
        assert!(spawn["inputSchema"]["properties"]["model"]["description"].as_str().unwrap().contains("provider"));
    }

    #[test]
    fn an_orchestra_call_goes_to_the_app_flagged_and_its_result_comes_back_as_the_tool_result() {
        let seen = std::cell::RefCell::new(None);
        let msg = json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "spawn_agent", "arguments": {"name": "login", "brief": "Build it"}}});
        let r = handle_message_as(&msg, &|req| {
            *seen.borrow_mut() = Some(req);
            BridgeResponse { allow: true, message: Some("Started w1.".into()), updated_input: None, failed: false }
        }, LEAD)
        .unwrap();
        assert_eq!(r["result"]["content"][0]["text"], "Started w1.");
        assert_eq!(r["result"]["isError"], false);
        let req = seen.borrow().clone().unwrap();
        assert!(req.orchestra);
        assert_eq!((req.tool_name.as_str(), req.input["brief"].as_str()), ("spawn_agent", Some("Build it")));
        // A failure reaches the model as a tool error with the reason.
        let r = handle_message_as(&msg, &|_| BridgeResponse { allow: false, message: Some("At most 6 workers.".into()), updated_input: None, failed: false }, LEAD).unwrap();
        assert_eq!((r["result"]["isError"].clone(), r["result"]["content"][0]["text"].clone()), (json!(true), json!("At most 6 workers.")));
    }

    #[test]
    fn a_helper_that_is_not_the_main_agents_refuses_orchestra_calls_instead_of_treating_them_as_permission_prompts() {
        let called = std::cell::Cell::new(false);
        let msg = json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "spawn_agent", "arguments": {"name": "x", "brief": "y"}}});
        let r = handle_message_as(&msg, &|_| {
            called.set(true);
            BridgeResponse { allow: true, message: None, updated_input: None, failed: false }
        }, Offer::default())
        .unwrap();
        assert!(!called.get());
        assert_eq!(r["result"]["isError"], true);
        assert_eq!(r["result"]["content"][0]["text"], "spawn_agent is only available to a Team's lead.");
    }

    #[test]
    fn a_permission_prompt_cannot_pose_as_an_orchestra_call() {
        // `approve` always builds its request from the arguments with `orchestra` false, whatever they claim.
        let seen = std::cell::RefCell::new(None);
        let msg = json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "approve", "arguments": {"tool_name": "spawn_agent", "input": {}, "orchestra": true}}});
        handle_message_as(&msg, &|req| {
            *seen.borrow_mut() = Some(req);
            BridgeResponse { allow: true, message: None, updated_input: None, failed: false }
        }, LEAD);
        assert!(!seen.borrow().clone().unwrap().orchestra);
    }

    #[test]
    fn unknown_requests_are_refused_and_ping_is_answered() {
        let r = handle_message(&json!({"jsonrpc": "2.0", "id": "x", "method": "server/discover"}), &allow_all).unwrap();
        assert_eq!((r["id"].clone(), r["error"]["code"].clone()), (json!("x"), json!(-32601)));
        assert!(r.get("result").is_none());
        let r = handle_message(&json!({"jsonrpc": "2.0", "id": 4, "method": "ping"}), &allow_all).unwrap();
        assert_eq!(r["result"], json!({}));
    }

    #[test]
    fn missing_socket_denies() {
        let req = BridgeRequest::permission("Bash".into(), json!({}), None);
        let r = ask_bridge(None, &req);
        assert!(!r.allow);
        assert!(r.message.unwrap().contains("denied"));
    }

    #[test]
    fn run_helper_replies_only_to_requests() {
        let input = [
            r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}"#,
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            "not json",
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
        ]
        .join("\n");
        let mut out = Vec::new();
        run_helper(input.as_bytes(), &mut out, None).unwrap();
        let replies: Vec<Value> = String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(replies.len(), 2);
        assert_eq!(replies[1]["id"], 1);
    }

    #[test]
    fn a_line_that_is_not_utf8_does_not_end_the_helper() {
        let input = b"\xff\xfe junk\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n";
        let mut out = Vec::new();
        run_helper(&input[..], &mut out, None).unwrap();
        let replies: Vec<Value> = String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0]["id"], 1);
    }

    fn tool_call(name: &str, arguments: Value) -> Value {
        let msg = json!({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": name, "arguments": arguments}});
        handle_message(&msg, &allow_all).unwrap()["result"].clone()
    }

    #[test]
    fn every_chat_lists_lanterns_own_tools() {
        let list = handle_message(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}), &allow_all).unwrap();
        let names: Vec<_> = list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
        assert!(names.contains(&"steps_guide".into()) && names.contains(&"review_target".into()), "{names:?}");
    }

    #[test]
    fn steps_guide_gives_the_shared_rules_and_one_flavour_or_all() {
        let text = |r: Value| r["content"][0]["text"].as_str().unwrap().to_string();
        let review = text(tool_call("steps_guide", json!({"flavour": "review"})));
        assert!(review.contains("You work one page at a time") && review.contains("# File N of M") && !review.contains("# Evidence N"));
        let all = text(tool_call("steps_guide", json!({})));
        assert!(all.contains("# File N of M") && all.contains("# Evidence N") && all.contains("# Overview") && all.contains("Explain as you go:"));
        let unknown = tool_call("steps_guide", json!({"flavour": "Teach"}));
        assert_eq!(unknown["isError"], true);
        assert!(text(unknown).contains("Step by step's flavours are Build, Review, Debug, Design, and its option is Explain as you go"));
        let explain = text(tool_call("steps_guide", json!({"flavour": "Learn"})));
        assert!(explain.contains("explain the why") && !explain.contains("# Evidence N"), "Learn is the option's old name");
    }

    #[test]
    fn steps_guides_design_section_has_the_shape_of_the_map() {
        let text = tool_call("steps_guide", json!({"flavour": "Design"}))["content"][0]["text"].as_str().unwrap().to_string();
        for part in ["```architecture", "\"layers\"", "\"nodes\"", "\"edges\"", "\"status\"", "\"layer\""] {
            assert!(text.contains(part), "{part}");
        }
    }

    #[test]
    fn review_target_goes_through_the_app_and_says_what_the_pane_shows() {
        let seen = std::cell::RefCell::new(Vec::new());
        let call = |args: Value| {
            let msg = json!({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "review_target", "arguments": args}});
            handle_message(&msg, &|req| {
                seen.borrow_mut().push(req);
                BridgeResponse { allow: true, message: None, updated_input: None, failed: false }
            })
            .unwrap()["result"]
                .clone()
        };
        let text = |r: &Value| r["content"][0]["text"].as_str().unwrap().to_string();
        assert!(text(&call(json!({"pr": 512}))).contains("#512"));
        assert!(text(&call(json!({"pr": null, "base": "feat/core"}))).contains("since feat/core"));
        assert!(text(&call(json!({}))).contains("built on"));
        let sent = seen.borrow().clone();
        assert_eq!(sent.len(), 3);
        assert!(sent.iter().all(|r| r.review && !r.network && !r.orchestra && r.tool_name == "review_target"));
        assert_eq!(sent[1].input["base"], "feat/core");
        // What isn't a pull request or a branch never reaches the app.
        for bad in [json!({"pr": "512"}), json!({"pr": 0}), json!({"base": "--output=x"}), json!({"base": "main..x"})] {
            let r = call(bad.clone());
            assert_eq!(r["isError"], true, "{bad}");
        }
        assert_eq!(seen.borrow().len(), 3);
        // And the app's own refusal is the model's error.
        let msg = json!({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "review_target", "arguments": {"pr": 5}}});
        let r = handle_message(&msg, &|_| BridgeResponse { allow: false, message: Some("No window.".into()), updated_input: None, failed: false }).unwrap();
        assert_eq!((r["result"]["isError"].clone(), r["result"]["content"][0]["text"].clone()), (json!(true), json!("No window.")));
    }
}
