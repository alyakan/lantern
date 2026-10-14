use super::protocol::{decision_json, BridgeRequest, BridgeResponse};
use serde_json::{json, Value};

/// The name the app shows for a reproduce request (not a real tool, so it can't clash with one).
pub const REPRODUCE: &str = "Reproduce";
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;

/// The tools only the main agent has (see orchestra.rs). Each returns at once: this helper answers one message at a
/// time, so a call that waited would hold up the permission prompts behind it.
pub const ORCHESTRA_TOOLS: &[&str] = &["spawn_agent", "list_agents", "read_agent", "message_agent", "stop_agent", "propose_merge"];

fn orchestra_tool_list() -> Vec<Value> {
    let id = json!({"type": "string", "description": "The worker's id, as spawn_agent or list_agents gave it (w1, w2…)."});
    vec![
        json!({
            "name": "spawn_agent",
            "description": "Start a worker agent with a chat of its own. Returns at once with its id; it runs on its own and you get a note when it finishes a turn. Its brief is its whole task: write it for someone who has not seen this conversation.",
            "inputSchema": {"type": "object", "properties": {
                "name": {"type": "string", "description": "A short name for the worker (a few words), shown on the canvas and used for its branch."},
                "brief": {"type": "string", "description": "The task: goal, files or areas involved, constraints, how to verify, what done looks like."},
                "isolation": {"type": "string", "enum": ["worktree", "shared"], "description": "worktree (default): its own git worktree and branch. shared: your folder, only for work that writes nothing."},
                "provider": {"type": "string", "description": "Which agent provider runs it, from the providers your instructions list; omit to use yours. Only a listed one is available."},
                "model": {"type": "string", "description": "A model for it, as the provider that runs it names models (for claude: sonnet, opus, haiku…); omit to use yours, or that provider's default when it isn't yours."}
            }, "required": ["name", "brief"]}
        }),
        json!({
            "name": "list_agents",
            "description": "Every worker you started: id, name, status, branch, turns and its latest message.",
            "inputSchema": {"type": "object", "properties": {}}
        }),
        json!({
            "name": "read_agent",
            "description": "A worker's conversation, as plain entries. Without a cursor it returns the latest entries; with one, the entries from that index on (the reply says which cursor reads the next page).",
            "inputSchema": {"type": "object", "properties": {
                "id": id,
                "cursor": {"type": "integer", "description": "Index of the first entry to return (0 is the start)."},
                "limit": {"type": "integer", "description": "How many entries (default 30, at most 100)."}
            }, "required": ["id"]}
        }),
        json!({
            "name": "message_agent",
            "description": "Send a worker an instruction or an answer. It appears in the worker's chat as from the main agent.",
            "inputSchema": {"type": "object", "properties": {"id": id, "text": {"type": "string"}}, "required": ["id", "text"]}
        }),
        json!({
            "name": "stop_agent",
            "description": "Stop a worker. Its worktree and branch are kept.",
            "inputSchema": {"type": "object", "properties": {"id": id}, "required": ["id"]}
        }),
        json!({
            "name": "propose_merge",
            "description": "Ask the user to merge a worker's branch into the main checkout. Only the user can approve it; you get a note with their answer.",
            "inputSchema": {"type": "object", "properties": {"id": id, "summary": {"type": "string", "description": "What the branch does and what you checked, in plain language."}}, "required": ["id", "summary"]}
        }),
    ]
}

/// Answers one MCP JSON-RPC message. Returns None for notifications (no `id`).
pub fn handle_message(msg: &Value, ask: &dyn Fn(BridgeRequest) -> BridgeResponse) -> Option<Value> {
    handle_message_as(msg, ask, false)
}

/// `orchestrator`: this is the main agent's helper (`LANTERN_ROLE=main`), which also offers the orchestra tools. That only
/// decides what is listed: the app lets a call through when the OS says the helper is the main agent's own process
/// (see PermissionBridge), so a helper that claims the role without being its helper gets nowhere.
pub fn handle_message_as(msg: &Value, ask: &dyn Fn(BridgeRequest) -> BridgeResponse, orchestrator: bool) -> Option<Value> {
    let id = msg.get("id")?.clone();
    let result = match msg["method"].as_str().unwrap_or("") {
        "initialize" => json!({
            "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "lantern", "version": env!("CARGO_PKG_VERSION")}
        }),
        "tools/list" => {
            let mut tools = base_tools();
            if orchestrator {
                tools.extend(orchestra_tool_list());
            }
            json!({"tools": tools})
        }
        // Matched before the fallback below, which treats any other tool name as an `approve` call.
        "tools/call" if ORCHESTRA_TOOLS.contains(&msg["params"]["name"].as_str().unwrap_or("")) => {
            let tool = msg["params"]["name"].as_str().unwrap_or("");
            if orchestrator {
                let resp = ask(BridgeRequest { tool_name: tool.into(), input: msg["params"]["arguments"].clone(), tool_use_id: None, orchestra: true });
                let text = resp.message.unwrap_or_else(|| if resp.allow { "Done.".into() } else { "That didn't work.".into() });
                json!({"isError": !resp.allow, "content": [{"type": "text", "text": text}]})
            } else {
                json!({"isError": true, "content": [{"type": "text", "text": format!("{tool} is only available to the main agent.")}]})
            }
        }
        "tools/call" if msg["params"]["name"] == "reproduce" => {
            let resp = ask(BridgeRequest::permission(REPRODUCE.into(), msg["params"]["arguments"].clone(), None));
            let note = resp.message.filter(|m| !m.trim().is_empty()).map(|m| format!(" Their note: {m}")).unwrap_or_default();
            let text = if resp.allow { format!("The user reproduced the problem.{note}") } else { format!("The user could not reproduce the problem.{note}") };
            json!({"content": [{"type": "text", "text": text}]})
        }
        "tools/call" => {
            let args = &msg["params"]["arguments"];
            let req = BridgeRequest::permission(
                args["tool_name"].as_str().unwrap_or("").to_string(),
                args["input"].clone(),
                args["tool_use_id"].as_str().map(String::from),
            );
            let resp = ask(req.clone());
            json!({"content": [{"type": "text", "text": decision_json(&req.input, &resp).to_string()}]})
        }
        // MCP's keep-alive: answered with nothing.
        "ping" => json!({}),
        // A request this server doesn't have: the client is told so, rather than given an empty result.
        _ => return Some(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "Method not found"}})),
    };
    Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

fn base_tools() -> Vec<Value> {
    vec![
        json!({
            "name": "approve",
            "description": "Ask the Lantern user to allow or deny a tool call",
            "inputSchema": {
                "type": "object",
                "properties": {"tool_name": {"type": "string"}, "input": {"type": "object"}, "tool_use_id": {"type": "string"}},
                "required": ["tool_name", "input"]
            }
        }),
        json!({
            "name": "reproduce",
            "description": "Debug mode: ask the user to reproduce the bug now, with your diagnostic logging in place. Waits until they have, and returns whether they could and anything they noted (e.g. pasted logs). Call it instead of ending your turn to ask them.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "steps": {"type": "string", "description": "Markdown: exactly what to do to trigger the bug, and where the logs will show up."}
                },
                "required": ["steps"]
            }
        }),
    ]
}

/// Sends the request to the app and waits for the user's answer. Any failure means deny.
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
    })
}

/// The `--permission-helper` main loop: newline-delimited JSON-RPC on stdin/stdout.
pub fn run_helper(input: impl BufRead, output: impl Write, socket: Option<&str>) -> io::Result<()> {
    run_helper_as(input, output, socket, false)
}

/// `orchestrator`: the main agent's helper (`LANTERN_ROLE=main`), which also serves the orchestra tools.
pub fn run_helper_as(mut input: impl BufRead, mut output: impl Write, socket: Option<&str>, orchestrator: bool) -> io::Result<()> {
    let ask = |req: BridgeRequest| ask_bridge(socket, &req);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        if input.read_until(b'\n', &mut buf)? == 0 {
            return Ok(());
        }
        // Bytes that aren't a JSON message are skipped: a bad line must not end the helper, or every later prompt is denied.
        let Ok(msg) = serde_json::from_slice::<Value>(&buf) else { continue };
        if let Some(reply) = handle_message_as(&msg, &ask, orchestrator) {
            writeln!(output, "{reply}")?;
            output.flush()?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn allow_all(_: BridgeRequest) -> BridgeResponse {
        BridgeResponse { allow: true, message: None, updated_input: None }
    }

    fn call(tool: &str, input: Value) -> Value {
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
               "params": {"name": "approve", "arguments": {"tool_name": tool, "input": input, "tool_use_id": "toolu_1"}}})
    }

    fn decision(reply: &Value) -> Value {
        serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
    }

    #[test]
    fn initialize_echoes_protocol_version() {
        let r = handle_message(&json!({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": "2025-11-25"}}), &allow_all).unwrap();
        assert_eq!(r["id"], 0);
        assert_eq!(r["result"]["protocolVersion"], "2025-11-25");
        assert_eq!(r["result"]["serverInfo"]["name"], "lantern");
        assert!(r["result"]["capabilities"]["tools"].is_object());
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
            BridgeResponse { allow: true, message: None, updated_input: None }
        })
        .unwrap();
        assert_eq!(decision(&r), json!({"behavior": "allow", "updatedInput": {"command": "npm test"}}));
        let req = seen.borrow().clone().unwrap();
        assert_eq!(req.tool_name, "Bash");
        assert_eq!(req.tool_use_id.as_deref(), Some("toolu_1"));
    }

    #[test]
    fn deny_has_default_message() {
        let r = handle_message(&call("Bash", json!({"command": "rm -rf x"})), &|_| BridgeResponse { allow: false, message: None, updated_input: None }).unwrap();
        assert_eq!(decision(&r), json!({"behavior": "deny", "message": "The user denied this action."}));
    }

    #[test]
    fn reproduce_asks_the_user_and_reports_back_with_their_note() {
        let seen = std::cell::RefCell::new(None);
        let msg = json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "reproduce", "arguments": {"steps": "1. Open settings"}}});
        let r = handle_message(&msg, &|req| {
            *seen.borrow_mut() = Some(req);
            BridgeResponse { allow: true, message: Some("[lantern-debug] token=null".into()), updated_input: None }
        })
        .unwrap();
        assert_eq!(r["result"]["content"][0]["text"], "The user reproduced the problem. Their note: [lantern-debug] token=null");
        let req = seen.borrow().clone().unwrap();
        assert_eq!((req.tool_name.as_str(), req.input["steps"].as_str()), (REPRODUCE, Some("1. Open settings")));
        let r = handle_message(&msg, &|_| BridgeResponse { allow: false, message: None, updated_input: None }).unwrap();
        assert_eq!(r["result"]["content"][0]["text"], "The user could not reproduce the problem.");
        let tools = handle_message(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}), &allow_all).unwrap();
        assert_eq!(tools["result"]["tools"][1]["name"], "reproduce");
    }

    fn tool_names(reply: &Value) -> Vec<String> {
        reply["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn only_the_main_agents_helper_lists_the_orchestra_tools() {
        let list = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"});
        assert_eq!(tool_names(&handle_message_as(&list, &allow_all, false).unwrap()), ["approve", "reproduce"]);
        let names = tool_names(&handle_message_as(&list, &allow_all, true).unwrap());
        assert_eq!(&names[..2], ["approve", "reproduce"]);
        assert_eq!(names[2..], *ORCHESTRA_TOOLS);
    }

    #[test]
    fn spawn_agent_takes_an_optional_provider_and_leaves_the_choice_of_one_to_the_app() {
        let list = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"});
        let tools = handle_message_as(&list, &allow_all, true).unwrap();
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
            BridgeResponse { allow: true, message: Some("Started w1.".into()), updated_input: None }
        }, true)
        .unwrap();
        assert_eq!(r["result"]["content"][0]["text"], "Started w1.");
        assert_eq!(r["result"]["isError"], false);
        let req = seen.borrow().clone().unwrap();
        assert!(req.orchestra);
        assert_eq!((req.tool_name.as_str(), req.input["brief"].as_str()), ("spawn_agent", Some("Build it")));
        // A failure reaches the model as a tool error with the reason.
        let r = handle_message_as(&msg, &|_| BridgeResponse { allow: false, message: Some("At most 6 workers.".into()), updated_input: None }, true).unwrap();
        assert_eq!((r["result"]["isError"].clone(), r["result"]["content"][0]["text"].clone()), (json!(true), json!("At most 6 workers.")));
    }

    #[test]
    fn a_helper_that_is_not_the_main_agents_refuses_orchestra_calls_instead_of_treating_them_as_permission_prompts() {
        let called = std::cell::Cell::new(false);
        let msg = json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "spawn_agent", "arguments": {"name": "x", "brief": "y"}}});
        let r = handle_message_as(&msg, &|_| {
            called.set(true);
            BridgeResponse { allow: true, message: None, updated_input: None }
        }, false)
        .unwrap();
        assert!(!called.get());
        assert_eq!(r["result"]["isError"], true);
    }

    #[test]
    fn a_permission_prompt_cannot_pose_as_an_orchestra_call() {
        // `approve` always builds its request from the arguments with `orchestra` false, whatever they claim.
        let seen = std::cell::RefCell::new(None);
        let msg = json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "approve", "arguments": {"tool_name": "spawn_agent", "input": {}, "orchestra": true}}});
        handle_message_as(&msg, &|req| {
            *seen.borrow_mut() = Some(req);
            BridgeResponse { allow: true, message: None, updated_input: None }
        }, true);
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
}
