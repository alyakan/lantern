//! The permission bridge's caller check end to end: a real `claude`, started the way Lantern starts it (build_args, with
//! Lantern's own helper binary), asks for a permission, an answer to AskUserQuestion and a reproduce, and each reaches
//! the bridge, which lets in only that claude's own helper. A request from any other process is refused. Run by hand:
//!
//!     cargo test --test helper_live -- --ignored --nocapture
//!
//! It costs a small haiku run.

use lantern_lib::args::{HelperConfig, Mode, Role};
use lantern_lib::permission::bridge::{helper_of, PermissionBridge};
use lantern_lib::permission::helper::ask_bridge;
use lantern_lib::permission::protocol::BridgeRequest;
use lantern_lib::permission::rules::FolderRules;
use lantern_lib::provider::ProviderId;
use lantern_lib::session::{Session, SessionConfig};
use lantern_lib::ui_event::UiEvent;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the claude CLI, and costs a small haiku run"]
async fn a_real_claudes_helper_gets_through_and_nothing_else_does() {
    let dir = tempfile::tempdir().unwrap();
    let folder = std::fs::canonicalize(dir.path()).unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<UiEvent>();
    let claude_pid = Arc::new(AtomicU32::new(0));
    let exe = std::path::PathBuf::from(env!("CARGO_BIN_EXE_lantern"));
    let sink_tx = tx.clone();
    let bridge = PermissionBridge::start(
        folder.join("b.sock"),
        Arc::new(move |ev| {
            let _ = sink_tx.send(ev);
        }),
        Arc::new(FolderRules::load(None)),
        helper_of(claude_pid.clone(), exe.clone()),
    )
    .unwrap();
    bridge.set_folder(&folder);

    let claude = which("claude");
    let cfg = SessionConfig {
        provider: ProviderId::Claude,
        binary: claude,
        folder: folder.clone(),
        // Step by step, with Ask's permissions: the one mode that has the reproduce tool.
        mode: Mode::Steps,
        auto_approve: false,
        resume: None,
        model: Some("haiku".into()),
        effort: None,
        advisor: None,
        subagent_model: None,
        helper: HelperConfig { exe: exe.display().to_string(), socket: bridge.socket_path.display().to_string(), role: Role::Normal, providers: vec![] },
        path_env: std::env::var("PATH").ok(),
    };
    let mut session = Session::spawn(&cfg, Arc::new(move |ev| { let _ = tx.send(ev); }), Arc::new(|_: &str, _: Option<String>| {})).unwrap();
    claude_pid.store(session.pid(), Ordering::SeqCst);
    session.initialize().await;
    session
        .send("This is a test of the app's tools; do exactly these three things in order, one tool call each, and nothing else. 1) Run the Bash command: python3 -c \"open('out.txt','w').write('hi')\" 2) Use the AskUserQuestion tool to ask me one question, \"Which colour?\", with the options \"Red\" and \"Blue\". 3) Call the mcp__lantern__reproduce tool with steps \"Click the button\" and where \"the console\" (load it with ToolSearch first if you need to). Then reply with just DONE.")
        .await
        .unwrap();

    let mut seen = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
    loop {
        let ev = match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(ev)) => ev,
            _ => break,
        };
        match ev {
            UiEvent::PermissionRequested { request_id, tool_name, input } => {
                eprintln!("asked: {tool_name} {input}");
                let updated = (tool_name == "AskUserQuestion").then(|| {
                    let mut answered = input.clone();
                    let q = input["questions"][0]["question"].as_str().unwrap_or("Which colour?").to_string();
                    answered["answers"] = serde_json::json!({ q: "Red" });
                    answered
                });
                let note = tool_name.eq_ignore_ascii_case("reproduce").then(|| "Done; the console said OK.".to_string());
                assert!(bridge.respond(&request_id, true, note, updated));
                seen.push(tool_name);
            }
            UiEvent::ToolStarted { name, summary, .. } => eprintln!("tool: {name} {summary}"),
            UiEvent::TurnDone { .. } => break,
            _ => {}
        }
    }

    // A process that isn't that claude's helper (this test) is refused, whatever it asks.
    let socket = bridge.socket_path.display().to_string();
    let stranger = tokio::task::spawn_blocking(move || ask_bridge(Some(&socket), &BridgeRequest::permission("Bash".into(), serde_json::json!({"command": "ls"}), None))).await.unwrap();
    eprintln!("stranger: {stranger:?}");
    session.stop().await;
    bridge.close().await;

    eprintln!("requests that reached the bridge: {seen:?}");
    assert!(seen.iter().any(|t| t == "Bash"), "{seen:?}");
    assert!(seen.iter().any(|t| t == "AskUserQuestion"), "{seen:?}");
    assert!(seen.iter().any(|t| t.eq_ignore_ascii_case("reproduce")), "{seen:?}");
    assert!(folder.join("out.txt").is_file(), "the allowed command didn't run");
    assert!(!stranger.allow && stranger.message.unwrap_or_default().contains("Not authorized"));
}

fn which(name: &str) -> std::path::PathBuf {
    let out = std::process::Command::new("/bin/zsh").args(["-lc", &format!("command -v {name}")]).output().unwrap();
    std::path::PathBuf::from(String::from_utf8_lossy(&out.stdout).trim())
}

/// What Claude Code makes of the helper's `initialize` reply: it accepts the instructions and the tool list, and a call to
/// one of the tools (steps_guide) comes back as a result, not an error. Run by hand like the test above.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the claude CLI, and costs a small haiku run"]
async fn a_real_claude_takes_the_servers_instructions_and_calls_a_tool() {
    let dir = tempfile::tempdir().unwrap();
    let folder = std::fs::canonicalize(dir.path()).unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<UiEvent>();
    let claude_pid = Arc::new(AtomicU32::new(0));
    let exe = std::path::PathBuf::from(env!("CARGO_BIN_EXE_lantern"));
    let sink_tx = tx.clone();
    let bridge = PermissionBridge::start(folder.join("b.sock"), Arc::new(move |ev| { let _ = sink_tx.send(ev); }), Arc::new(FolderRules::load(None)), helper_of(claude_pid.clone(), exe.clone())).unwrap();
    bridge.set_folder(&folder);
    let cfg = SessionConfig {
        provider: ProviderId::Claude,
        binary: which("claude"),
        folder: folder.clone(),
        mode: Mode::Ask,
        auto_approve: false,
        resume: None,
        model: Some("haiku".into()),
        effort: None,
        advisor: None,
        subagent_model: None,
        helper: HelperConfig { exe: exe.display().to_string(), socket: bridge.socket_path.display().to_string(), role: Role::Normal, providers: vec![] },
        path_env: std::env::var("PATH").ok(),
    };
    let mut session = Session::spawn(&cfg, Arc::new(move |ev| { let _ = tx.send(ev); }), Arc::new(|_: &str, _: Option<String>| {})).unwrap();
    claude_pid.store(session.pid(), Ordering::SeqCst);
    session.initialize().await;
    session
        .send("Two things, in order. 1) Call the mcp__lantern__steps_guide tool with flavour \"Debug\" (load it with ToolSearch first if you need to). 2) Reply with exactly: the MCP tools you have from the lantern server (their names, comma-separated), then a line that starts with NOTE: and quotes, from the lantern server's instructions, what a message that starts with \"[Lantern: \" is.")
        .await
        .unwrap();

    let (mut guide, mut reply, mut tools) = (None, String::new(), Vec::new());
    let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
    let mut guide_id = None;
    loop {
        let Ok(Some(ev)) = tokio::time::timeout_at(deadline, rx.recv()).await else { break };
        match ev {
            UiEvent::McpTools { tools: t } => tools = t,
            UiEvent::ToolStarted { name, tool_use_id, .. } if name == "mcp__lantern__steps_guide" => guide_id = Some(tool_use_id),
            UiEvent::ToolFinished { tool_use_id, is_error, output, .. } if guide_id.as_deref() == Some(tool_use_id.as_str()) => guide = Some((is_error, output)),
            UiEvent::AssistantText { parent: None, text, .. } => reply = text,
            UiEvent::TurnDone { .. } => break,
            _ => {}
        }
    }
    session.stop().await;
    bridge.close().await;
    eprintln!("tools: {tools:?}\nreply: {reply}");
    let (is_error, output) = guide.expect("steps_guide was never called");
    assert!(!is_error && output.contains("# Evidence N"), "{output}");
    assert!(tools.iter().any(|t| t == "mcp__lantern__steps_guide") && !tools.iter().any(|t| t == "mcp__lantern__reproduce"), "{tools:?}");
    assert!(reply.to_lowercase().contains("note from lantern") || reply.to_lowercase().contains("from lantern"), "Claude doesn't seem to have the server's instructions: {reply}");
}
