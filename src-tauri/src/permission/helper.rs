use super::protocol::{decision_json, BridgeRequest, BridgeResponse};
use serde_json::{json, Value};

/// The name the app shows for a reproduce request (not a real tool, so it can't clash with one).
pub const REPRODUCE: &str = "Reproduce";
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;

/// Answers one MCP JSON-RPC message. Returns None for notifications (no `id`).
pub fn handle_message(msg: &Value, ask: &dyn Fn(BridgeRequest) -> BridgeResponse) -> Option<Value> {
    let id = msg.get("id")?.clone();
    let result = match msg["method"].as_str().unwrap_or("") {
        "initialize" => json!({
            "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "lantern", "version": env!("CARGO_PKG_VERSION")}
        }),
        "tools/list" => json!({"tools": [{
            "name": "approve",
            "description": "Ask the Lantern user to allow or deny a tool call",
            "inputSchema": {
                "type": "object",
                "properties": {"tool_name": {"type": "string"}, "input": {"type": "object"}, "tool_use_id": {"type": "string"}},
                "required": ["tool_name", "input"]
            }
        }, {
            "name": "reproduce",
            "description": "Debug mode: ask the user to reproduce the bug now, with your diagnostic logging in place. Waits until they have, and returns whether they could and anything they noted (e.g. pasted logs). Call it instead of ending your turn to ask them.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "steps": {"type": "string", "description": "Markdown: exactly what to do to trigger the bug, and where the logs will show up."}
                },
                "required": ["steps"]
            }
        }]}),
        "tools/call" if msg["params"]["name"] == "reproduce" => {
            let resp = ask(BridgeRequest { tool_name: REPRODUCE.into(), input: msg["params"]["arguments"].clone(), tool_use_id: None });
            let note = resp.message.filter(|m| !m.trim().is_empty()).map(|m| format!(" Their note: {m}")).unwrap_or_default();
            let text = if resp.allow { format!("The user reproduced the problem.{note}") } else { format!("The user could not reproduce the problem.{note}") };
            json!({"content": [{"type": "text", "text": text}]})
        }
        "tools/call" => {
            let args = &msg["params"]["arguments"];
            let req = BridgeRequest {
                tool_name: args["tool_name"].as_str().unwrap_or("").to_string(),
                input: args["input"].clone(),
                tool_use_id: args["tool_use_id"].as_str().map(String::from),
            };
            let resp = ask(req.clone());
            json!({"content": [{"type": "text", "text": decision_json(&req.input, &resp).to_string()}]})
        }
        _ => json!({}),
    };
    Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
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
pub fn run_helper(input: impl BufRead, mut output: impl Write, socket: Option<&str>) -> io::Result<()> {
    let ask = |req: BridgeRequest| ask_bridge(socket, &req);
    for line in input.lines() {
        let line = line?;
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        if let Some(reply) = handle_message(&msg, &ask) {
            writeln!(output, "{reply}")?;
            output.flush()?;
        }
    }
    Ok(())
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

    #[test]
    fn unknown_requests_get_empty_result() {
        let r = handle_message(&json!({"jsonrpc": "2.0", "id": "x", "method": "server/discover"}), &allow_all).unwrap();
        assert_eq!(r["result"], json!({}));
    }

    #[test]
    fn missing_socket_denies() {
        let req = BridgeRequest { tool_name: "Bash".into(), input: json!({}), tool_use_id: None };
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
}
