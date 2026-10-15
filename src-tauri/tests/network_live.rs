//! The network tools end to end: a real `claude` calls them through Lantern's own helper binary and bridge, which read
//! the Network Monitor that's running on this Mac. Run by hand, with Network Monitor open and some JSON traffic captured:
//!
//!     cargo test --test network_live -- --ignored --nocapture
//!
//! It costs a small haiku run.

use lantern_lib::network::{Api, Monitor, Store};
use lantern_lib::permission::bridge::{helper_of, PermissionBridge};
use lantern_lib::permission::protocol::BridgeResponse;
use lantern_lib::permission::rules::{folder_key, FolderRules};
use std::sync::Arc;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Network Monitor running with JSON traffic captured, and the claude CLI"]
async fn claude_watches_reads_and_summarizes_a_captured_response() {
    let dir = tempfile::tempdir().unwrap();
    // Only the helper of the claude started below is let in.
    let claude_pid = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let monitor = Arc::new(Monitor::new(Store::load(Some(dir.path().join("network.json"))), Box::new(Api::new(Api::default_info().unwrap()))));
    let bridge = PermissionBridge::start(dir.path().join("b.sock"), Arc::new(|_| {}), Arc::new(FolderRules::load(None)), helper_of(claude_pid.clone(), env!("CARGO_BIN_EXE_lantern").into())).unwrap();
    bridge.set_folder(dir.path());
    let m = monitor.clone();
    bridge.set_network(Arc::new(move |folder, tool, input| {
        let m = m.clone();
        Box::pin(async move {
            let result = tokio::task::spawn_blocking(move || m.call(folder.as_deref(), &tool, &input)).await.unwrap();
            let (allow, text) = match result {
                Ok(t) => (true, t),
                Err(t) => (false, t),
            };
            eprintln!("[{}] {}", if allow { "ok" } else { "error" }, text.lines().next().unwrap_or(""));
            BridgeResponse { allow, message: Some(text), updated_input: None, failed: false }
        })
    }));

    let mcp = serde_json::json!({"mcpServers": {"lantern": {"type": "stdio", "command": env!("CARGO_BIN_EXE_lantern"), "args": ["--permission-helper"], "env": {"LANTERN_SOCKET": bridge.socket_path.display().to_string()}}}});
    let tools: Vec<String> = lantern_lib::network::TOOLS.iter().map(|t| format!("mcp__lantern__{t}")).collect();
    let prompt = "Use the mcp__lantern__network_* tools (load them with ToolSearch if you need to). 1) List the captured requests to httpbin.org. 2) Save a watch labelled \"Slideshow\" for URLs containing httpbin.org/json. 3) Read the newest completed httpbin.org/json request. 4) Save a short markdown summary of its response with network_summarize. Then reply with just DONE.";
    let out = tokio::process::Command::new("claude")
        .args(["-p", prompt, "--model", "haiku", "--strict-mcp-config", "--mcp-config", &mcp.to_string(), "--allowedTools", &tools.join(","), "--output-format", "text"])
        .current_dir(dir.path())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    claude_pid.store(out.id().unwrap_or(0), std::sync::atomic::Ordering::SeqCst);
    let out = out.wait_with_output().await.unwrap();
    eprintln!("claude said: {}", String::from_utf8_lossy(&out.stdout).trim());

    // What the app's follower does every 2 seconds: read the responses of what the watch matched.
    monitor.poll();
    let view = monitor.view(&folder_key(dir.path()));
    eprintln!("watches: {:?}", view.watches);
    let summarized: Vec<_> = view.items.iter().filter_map(|i| i.summary.as_ref()).collect();
    for s in &summarized {
        eprintln!("summary of {} {}:\n{}", s.method, s.url, s.text);
    }
    assert!(view.watches.iter().any(|w| w.label == "Slideshow"), "{view:?}");
    assert!(view.items.iter().any(|i| i.tx.url.contains("httpbin.org/json") && i.has_response), "{view:?}");
    assert!(summarized.iter().any(|s| s.url.contains("httpbin.org/json")), "{view:?}");
}
