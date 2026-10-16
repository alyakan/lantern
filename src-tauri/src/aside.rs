//! The side chat: a quick question asked about a chat without touching it. Claude Code's own `/btw` lives in its
//! interactive screen only (it is not among the commands a `-p` session offers, and it answers without tools), so this is
//! the same idea built from flags the CLI does take: a separate `claude -p` that starts from a copy (a fork) of the chat's
//! conversation, can only read files, is not saved anywhere, and is stopped when the popover closes.
//!
//! Its events never go through a chat's slot: they reach the window as their own `aside-event`, so nothing here can land
//! in a chat's messages, queue, permission cards or totals. Nothing is asked of the user either: in `dontAsk` mode a
//! tool that isn't allowed is refused by the CLI itself, and the only tools it has are the three that read.

use crate::provider::claude_session::ClaudeSession;
use crate::ui_event::{Sink, UiEvent};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::process::Command;
use tokio::sync::Mutex as AsyncMutex;

/// The only tools a side chat has: they read, none of them changes anything.
pub const TOOLS: &str = "Read,Grep,Glob";
/// Claude Code has no `--max-turns`, so a side chat's limits are kept here: questions in one side chat, tool calls for one
/// question, and how long one question may take.
pub const MAX_QUESTIONS: usize = 10;
pub const MAX_STEPS: usize = 12;
pub const QUESTION_TIME: Duration = Duration::from_secs(180);
/// Side chats open at once (the window has one popover, so this is only a bound).
const MAX_ASIDES: usize = 4;
const MAX_QUESTION_CHARS: usize = 4000;

/// Said with the first question, since a resumed conversation keeps the system prompt it started with.
const NOTE: &str = "[This is a side question, asked while the main chat carries on separately; your answer is not added to it. You can only read files: Read, Grep and Glob are your only tools, and you can't change anything or run commands. Answer briefly and in plain language. If it would need a change or a command, say so and suggest asking in the main chat.]";

/// What the window hears of a side chat, as its own event (`aside-event`): a chat event, or a note from Lantern.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AsideEvent {
    pub aside: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<UiEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// What a side chat starts from.
#[derive(Debug, Clone)]
pub struct Launch {
    pub binary: std::path::PathBuf,
    /// The chat's folder: Claude Code finds the conversation to fork there, and reads files from there.
    pub folder: std::path::PathBuf,
    pub path_env: Option<String>,
    /// The chat's session id; None when it has no conversation yet (the side chat starts blank).
    pub resume: Option<String>,
    /// `--model`; None is Claude Code's default.
    pub model: Option<String>,
}

/// Ids come from the window and name a side chat in a map, so they are short and plain.
pub fn valid_id(id: &str) -> bool {
    (1..=32).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The shape of a Claude Code session id: a UUID (8-4-4-4-12 hex digits). It goes after `--resume`, so nothing else is passed.
pub fn valid_session_id(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    parts.len() == 5 && parts.iter().zip([8, 4, 4, 4, 12]).all(|(p, n)| p.len() == n && p.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Claude's command line for a side chat. `resume` is the chat's session id, forked so the chat's own session is not
/// changed; each value is its own argument, and nothing here goes through a shell.
pub fn args(resume: Option<&str>, model: Option<&str>) -> Vec<String> {
    let mut a: Vec<String> = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"].iter().map(|s| s.to_string()).collect();
    for flag in [
        // Anything not allowed is refused, never asked about.
        "--permission-mode",
        "dontAsk",
        // Only reading tools exist; no MCP servers, skills, hooks or user settings come along.
        "--tools",
        TOOLS,
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--setting-sources",
        "",
        // Not saved: no transcript of its own, so it never shows up in the chat history.
        "--no-session-persistence",
    ] {
        a.push(flag.to_string());
    }
    if let Some(id) = resume {
        a.push("--resume".into());
        a.push(id.into());
        a.push("--fork-session".into());
    }
    if let Some(m) = model {
        a.push("--model".into());
        a.push(m.into());
    }
    a
}

fn command(launch: &Launch) -> Command {
    let mut cmd = Command::new(&launch.binary);
    cmd.args(args(launch.resume.as_deref(), launch.model.as_deref())).current_dir(&launch.folder);
    if let Some(p) = &launch.path_env {
        cmd.env("PATH", p);
    }
    cmd
}

/// The question as it goes to Claude: the first one with the note about what a side question is.
fn wrapped(first: bool, question: &str) -> String {
    if first { format!("{NOTE}\n\n{question}") } else { question.to_string() }
}

/// Whether a chat event is part of the answer: the rest (models, context, plan usage…) belongs to a chat and is dropped.
fn shown(ev: &UiEvent) -> bool {
    match ev {
        UiEvent::TextDelta { parent, .. } | UiEvent::AssistantText { parent, .. } => parent.is_none(),
        UiEvent::ToolStarted { parent, .. } => parent.is_none(),
        UiEvent::TurnDone { .. } | UiEvent::SessionEnded { .. } | UiEvent::Retrying { .. } => true,
        _ => false,
    }
}

type Emit = Arc<dyn Fn(AsideEvent) + Send + Sync>;

struct Aside {
    slot: String,
    session: AsyncMutex<Option<ClaudeSession>>,
    asked: AtomicUsize,
    /// Tool calls so far in the question being answered.
    steps: AtomicUsize,
    /// Whether a question is being answered, and which one (a timer for an earlier question does nothing).
    working: AtomicBool,
    question: AtomicU64,
}

impl Aside {
    /// Ends the question being answered; Claude keeps running for a follow-up. `why` is shown with what it had said.
    async fn stop_answering(&self, id: &str, emit: &Emit, why: &str) {
        if !self.working.swap(false, Ordering::SeqCst) {
            return;
        }
        // The note goes first: the interrupted turn's own end follows it, and the window keeps the note as the reason.
        emit(AsideEvent { aside: id.to_string(), event: None, note: Some(why.to_string()) });
        if let Some(s) = self.session.lock().await.as_mut() {
            s.interrupt().await;
        }
    }
}

/// The side chats that are open.
#[derive(Default)]
pub struct Asides {
    open: Mutex<HashMap<String, Arc<Aside>>>,
}

impl Asides {
    /// Asks `text` in side chat `id` (started on the first question, from `launch`). Resolves once the question is sent;
    /// the answer comes as events through `emit`. Whether the side chat has the chat's conversation to start from.
    pub async fn ask(&self, id: &str, slot: &str, launch: &Launch, text: &str, emit: Emit) -> Result<bool, String> {
        if !valid_id(id) {
            return Err(format!("{id:?} is not a side chat id."));
        }
        if launch.resume.as_deref().is_some_and(|r| !valid_session_id(r)) {
            return Err("This chat's conversation id is not one a side chat can continue from.".into());
        }
        let text = text.trim();
        if text.is_empty() {
            return Err("Type a question first.".into());
        }
        if text.chars().count() > MAX_QUESTION_CHARS {
            return Err("That question is too long for a side chat.".into());
        }
        let aside = {
            let mut open = self.open.lock().unwrap();
            match open.get(id) {
                Some(a) if a.slot != slot => return Err("That side chat belongs to another chat.".into()),
                Some(a) => a.clone(),
                None => {
                    if open.len() >= MAX_ASIDES {
                        return Err("Too many side chats are open. Close one first.".into());
                    }
                    let a = Arc::new(Aside { slot: slot.to_string(), session: AsyncMutex::new(None), asked: AtomicUsize::new(0), steps: AtomicUsize::new(0), working: AtomicBool::new(false), question: AtomicU64::new(0) });
                    open.insert(id.to_string(), a.clone());
                    a
                }
            }
        };
        if aside.working.load(Ordering::SeqCst) {
            return Err("Wait for the answer, or stop it, before asking again.".into());
        }
        if aside.asked.load(Ordering::SeqCst) >= MAX_QUESTIONS {
            return Err(format!("A side chat takes {MAX_QUESTIONS} questions. Close it and open a new one."));
        }
        let mut session = aside.session.lock().await;
        let first = session.is_none();
        if first {
            *session = Some(start(&aside, id, launch, emit.clone()).inspect_err(|_| self.forget(id))?);
        }
        let claude = session.as_mut().expect("started above");
        if !claude.is_running() {
            return Err("This side chat has ended. Close it and open a new one.".into());
        }
        aside.steps.store(0, Ordering::SeqCst);
        aside.working.store(true, Ordering::SeqCst);
        let n = aside.question.fetch_add(1, Ordering::SeqCst) + 1;
        if let Err(e) = claude.send(&wrapped(first, text)).await {
            aside.working.store(false, Ordering::SeqCst);
            return Err(e);
        }
        aside.asked.fetch_add(1, Ordering::SeqCst);
        drop(session);
        // A question that takes too long is ended; what it had said stays.
        let (weak, id, emit) = (Arc::downgrade(&aside), id.to_string(), emit);
        tokio::spawn(async move {
            tokio::time::sleep(QUESTION_TIME).await;
            if let Some(a) = weak.upgrade().filter(|a| a.question.load(Ordering::SeqCst) == n) {
                a.stop_answering(&id, &emit, "Stopped: it was taking too long.").await;
            }
        });
        Ok(launch.resume.is_some())
    }

    fn forget(&self, id: &str) {
        self.open.lock().unwrap().remove(id);
    }

    /// Closes a side chat: its claude is stopped and nothing of it is kept. One that isn't open is fine.
    pub async fn stop(&self, id: &str) {
        let aside = self.open.lock().unwrap().remove(id);
        if let Some(a) = aside {
            a.working.store(false, Ordering::SeqCst);
            let session = a.session.lock().await.take();
            if let Some(s) = session {
                s.stop().await;
            }
        }
    }

    /// Ends the question being answered, keeping the side chat for a follow-up.
    pub async fn stop_answering(&self, id: &str, emit: Emit) {
        let aside = self.open.lock().unwrap().get(id).cloned();
        if let Some(a) = aside {
            a.stop_answering(id, &emit, "Stopped.").await;
        }
    }

    /// Closes every side chat of a chat (the chat was closed).
    pub async fn stop_slot(&self, slot: &str) {
        let ids: Vec<String> = self.open.lock().unwrap().iter().filter(|(_, a)| a.slot == slot).map(|(id, _)| id.clone()).collect();
        for id in ids {
            self.stop(&id).await;
        }
    }

    /// Closes them all (Lantern is quitting).
    pub async fn stop_all(&self) {
        let ids: Vec<String> = self.open.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.stop(&id).await;
        }
    }
}

/// Starts the claude of a side chat; what it says goes to `emit` as the side chat's own events.
fn start(aside: &Arc<Aside>, id: &str, launch: &Launch, emit: Emit) -> Result<ClaudeSession, String> {
    if !launch.folder.is_dir() {
        return Err(format!("{} no longer exists.", launch.folder.display()));
    }
    let (weak, id): (Weak<Aside>, String) = (Arc::downgrade(aside), id.to_string());
    let sink: Sink = {
        let emit = emit.clone();
        Arc::new(move |ev: UiEvent| {
            let Some(a) = weak.upgrade() else { return };
            match &ev {
                UiEvent::ToolStarted { parent: None, .. } => {
                    // One question may look at this many files before it is stopped.
                    if a.steps.fetch_add(1, Ordering::SeqCst) + 1 == MAX_STEPS + 1 {
                        let (a, id, emit) = (a.clone(), id.clone(), emit.clone());
                        tokio::spawn(async move { a.stop_answering(&id, &emit, "Stopped: it was looking at too many files.").await });
                    }
                }
                UiEvent::TurnDone { .. } | UiEvent::SessionEnded { .. } => a.working.store(false, Ordering::SeqCst),
                _ => {}
            }
            if shown(&ev) {
                emit(AsideEvent { aside: id.clone(), event: Some(ev), note: None });
            }
        })
    };
    // Nothing a side chat does is an edit of the chat's files, and there is no tool that could make one.
    let no_edits: crate::session::EditHook = Arc::new(|_: &str, _: Option<String>| {});
    ClaudeSession::start(command(launch), &launch.binary, &launch.folder, None, sink, no_edits)
}

/// Where Claude Code keeps the chat's conversation, when it has one: a side chat of a chat that hasn't said anything yet
/// starts blank, since there is nothing to fork. Returns the id to fork from.
pub fn forkable(projects: &Path, folder: &Path, aliases: &[std::path::PathBuf], session_id: Option<&str>) -> Option<String> {
    let id = session_id.filter(|id| valid_session_id(id))?;
    crate::history::transcript_path_with_aliases(projects, folder, aliases, id).ok()?;
    Some(id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tokio::sync::mpsc;

    fn pos(a: &[String], flag: &str) -> usize {
        a.iter().position(|x| x == flag).unwrap_or_else(|| panic!("{flag} missing from {a:?}"))
    }

    #[test]
    fn a_side_chat_forks_the_chat_and_reads_only() {
        let a = args(Some("2e1f7a52-aaaa-4bbb-8ccc-0123456789ab"), Some("haiku"));
        // The session id is its own argument right after --resume, and the fork flag follows: the chat's own session
        // file is not the one that is continued.
        assert_eq!(a[pos(&a, "--resume") + 1], "2e1f7a52-aaaa-4bbb-8ccc-0123456789ab");
        assert_eq!(a[pos(&a, "--resume") + 2], "--fork-session");
        assert_eq!(a[pos(&a, "--model") + 1], "haiku");
        // Read-only: three reading tools and nothing else, refused rather than asked about.
        assert_eq!(a[pos(&a, "--tools") + 1], "Read,Grep,Glob");
        assert_eq!(a[pos(&a, "--permission-mode") + 1], "dontAsk");
        for flag in ["--allowedTools", "--allowed-tools", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--mcp-config", "--permission-prompt-tool", "--add-dir", "--agents", "--plugin-dir"] {
            assert!(!a.iter().any(|x| x == flag), "{flag}");
        }
        // Nothing of its own is saved, and no servers, skills or settings come along.
        for flag in ["--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands", "--setting-sources"] {
            assert!(a.iter().any(|x| x == flag), "{flag}");
        }
        assert_eq!(a[pos(&a, "--setting-sources") + 1], "");
        // The tools named are only those that read.
        assert!(TOOLS.split(',').all(|t| ["Read", "Grep", "Glob"].contains(&t)));
    }

    #[test]
    fn without_a_conversation_or_a_model_it_starts_blank_on_the_default() {
        let a = args(None, None);
        assert!(!a.iter().any(|x| x == "--resume" || x == "--fork-session" || x == "--model"), "{a:?}");
    }

    #[test]
    fn the_command_is_the_program_with_those_arguments_and_nothing_through_a_shell() {
        // A value that would mean something to a shell stays one argument, whatever it holds.
        let hostile = "abc; rm -rf ~ && echo $(whoami)";
        let launch = Launch { binary: "/bin/claude".into(), folder: "/tmp".into(), path_env: Some("/usr/bin".into()), resume: Some(hostile.into()), model: None };
        let cmd = command(&launch);
        let cmd = cmd.as_std();
        assert_eq!(cmd.get_program(), "/bin/claude");
        let got: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(got, args(Some(hostile), None));
        assert_eq!(got.iter().filter(|a| a.as_str() == hostile).count(), 1);
        assert!(!got.iter().any(|a| a == "-c" || a == "sh" || a == "/bin/sh" || a == "bash"));
        // The app only ever passes an id its history accepts (hex and dashes), so this one never gets this far.
        assert!(!crate::history::valid_id(hostile));
        assert_eq!(cmd.get_current_dir(), Some(Path::new("/tmp")));
    }

    #[test]
    fn only_the_chats_own_conversation_is_forked() {
        let dir = tempfile::tempdir().unwrap();
        let (projects, folder) = (dir.path().join("projects"), dir.path().join("work"));
        std::fs::create_dir_all(&folder).unwrap();
        let id = "2e1f7a52-aaaa-4bbb-8ccc-0123456789ab";
        // No conversation yet: nothing to fork, so the side chat starts blank.
        assert_eq!(forkable(&projects, &folder, &[], Some(id)), None);
        assert_eq!(forkable(&projects, &folder, &[], None), None);
        let transcripts = projects.join(crate::history::encode_folder(&folder));
        std::fs::create_dir_all(&transcripts).unwrap();
        std::fs::write(transcripts.join(format!("{id}.jsonl")), "{}\n").unwrap();
        assert_eq!(forkable(&projects, &folder, &[], Some(id)).as_deref(), Some(id));
        // An id that isn't one (it could point somewhere else on disk) is never used.
        assert_eq!(forkable(&projects, &folder, &[], Some("../../etc/passwd")), None);
    }

    #[test]
    fn only_the_answer_is_shown() {
        let text = UiEvent::AssistantText { parent: None, block_id: "b".into(), text: "hi".into() };
        let sub = UiEvent::AssistantText { parent: Some("t".into()), block_id: "b".into(), text: "hi".into() };
        assert!(shown(&text) && !shown(&sub));
        assert!(!shown(&UiEvent::ContextUsed { tokens: 5 }));
        assert!(!shown(&UiEvent::PermissionRequested { request_id: "r".into(), tool_name: "Bash".into(), input: serde_json::json!({}) }));
        assert!(!shown(&UiEvent::ModelUsage { models: vec![] }));
        assert!(!shown(&UiEvent::ConversationReset));
    }

    #[test]
    fn ids_are_short_and_plain() {
        assert!(valid_id("a1-b2") && !valid_id("") && !valid_id("a/b") && !valid_id("a b") && !valid_id(&"x".repeat(33)));
    }

    #[test]
    fn a_session_id_is_a_uuid_and_nothing_else() {
        assert!(valid_session_id("2e1f7a52-aaaa-4bbb-8ccc-0123456789ab") && valid_session_id("2E1F7A52-AAAA-4BBB-8CCC-0123456789AB"));
        for bad in ["", "abc", "--dangerously-skip-permissions", "-a-b-c-d", "2e1f7a52-aaaa-4bbb-8ccc-0123456789a", "2e1f7a52-aaaa-4bbb-8ccc-0123456789abc", "2e1f7a52-aaaa-4bbb-8ccc-0123456789ag", "../2e1f7a52-aaaa-4bbb-8ccc-012345", "2e1f7a52aaaa4bbb8ccc0123456789ab", "2e1f7a52-aaaa-4bbb-8ccc-0123456789ab\n"] {
            assert!(!valid_session_id(bad), "{bad:?}");
        }
    }

    #[tokio::test]
    async fn a_session_id_that_is_not_a_uuid_is_refused_before_anything_starts() {
        let dir = tempfile::tempdir().unwrap();
        let fake = script(dir.path(), "touch started.txt");
        let (emit, _rx) = channel();
        let asides = Asides::default();
        let mut l = launch(fake, dir.path());
        l.resume = Some("--dangerously-skip-permissions".into());
        let err = asides.ask("a1", "s1", &l, "what?", emit).await.unwrap_err();
        assert!(err.contains("conversation id"), "{err}");
        assert!(!dir.path().join("started.txt").exists());
        assert!(asides.open.lock().unwrap().is_empty());
    }

    #[test]
    fn the_first_question_carries_the_note_and_follow_ups_do_not() {
        assert!(wrapped(true, "what is x?").starts_with('[') && wrapped(true, "what is x?").ends_with("\n\nwhat is x?"));
        assert_eq!(wrapped(false, "and y?"), "and y?");
    }

    // ---- with a stand-in for claude ----

    fn script(dir: &Path, body: &str) -> std::path::PathBuf {
        let p = dir.join("fake-claude");
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    fn launch(binary: std::path::PathBuf, folder: &Path) -> Launch {
        Launch { binary, folder: folder.to_path_buf(), path_env: None, resume: Some("2e1f7a52-aaaa-4bbb-8ccc-0123456789ab".into()), model: Some("haiku".into()) }
    }

    fn channel() -> (Emit, mpsc::UnboundedReceiver<AsideEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Arc::new(move |ev| { let _ = tx.send(ev); }), rx)
    }

    async fn until(rx: &mut mpsc::UnboundedReceiver<AsideEvent>, pred: impl Fn(&AsideEvent) -> bool) -> AsideEvent {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let ev = rx.recv().await.expect("channel closed");
                if pred(&ev) {
                    return ev;
                }
            }
        })
        .await
        .expect("timed out waiting for an event")
    }

    async fn file(path: &Path) -> String {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some(c) = std::fs::read_to_string(path).ok().filter(|c| !c.is_empty()) {
                    return c;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("timed out waiting for a file")
    }

    const INIT: &str = r#"{"type":"system","subtype":"init","session_id":"forked-1","model":"m","cwd":"/p","permissionMode":"dontAsk"}"#;
    const RESULT: &str = r#"{"type":"result","subtype":"success","is_error":false,"result":"It does X.","total_cost_usd":0.02,"modelUsage":{"haiku":{"costUSD":0.02,"inputTokens":100,"outputTokens":20}}}"#;
    const TEXT: &str = r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"It does X."}]}}"#;

    #[tokio::test]
    async fn an_answer_reaches_the_side_chat_alone_and_only_as_an_answer() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().display();
        // Says a lot more than an answer (a context size, a plan's usage), then answers.
        let fake = script(
            dir.path(),
            &format!(
                "printf '%s\\n' \"$@\" > {d}/args.txt\nwhile IFS= read -r line; do\n  printf '%s\\n' \"$line\" >> {d}/stdin.txt\n  printf '%s\\n' '{INIT}'\n  printf '%s\\n' '{{\"type\":\"rate_limit_event\",\"rate_limit_info\":{{\"status\":\"allowed\",\"unifiedWindows\":{{\"five_hour\":{{\"utilization\":0.5}}}}}}}}'\n  printf '%s\\n' '{TEXT}'\n  printf '%s\\n' '{RESULT}'\ndone"
            ),
        );
        let (emit, mut rx) = channel();
        let asides = Asides::default();
        let forked = asides.ask("a1", "s1", &launch(fake, dir.path()), "what does x do?", emit).await.unwrap();
        assert!(forked);
        let done = until(&mut rx, |e| matches!(e.event, Some(UiEvent::TurnDone { .. }))).await;
        assert_eq!(done.aside, "a1");
        // Its own cost is its own: the totals are this process's, which is only the side chat.
        assert!(matches!(done.event, Some(UiEvent::TurnDone { session_cost_usd: Some(c), is_error: false, .. }) if (c - 0.02).abs() < 1e-9));
        let args = file(&dir.path().join("args.txt")).await;
        assert!(args.contains("--fork-session\n") && args.contains("--tools\nRead,Grep,Glob\n") && args.contains("--permission-mode\ndontAsk\n"), "{args}");
        let stdin = file(&dir.path().join("stdin.txt")).await;
        assert_eq!(stdin.lines().count(), 1);
        let sent: serde_json::Value = serde_json::from_str(stdin.trim()).unwrap();
        assert!(sent["message"]["content"][0]["text"].as_str().unwrap().ends_with("what does x do?"));
        // Everything that arrived between, apart from the answer, was dropped.
        while let Ok(ev) = rx.try_recv() {
            assert!(matches!(ev.event, Some(UiEvent::AssistantText { .. } | UiEvent::TextDelta { .. } | UiEvent::TurnDone { .. } | UiEvent::ToolStarted { .. })), "{ev:?}");
        }
        asides.stop("a1").await;
    }

    #[tokio::test]
    async fn a_follow_up_goes_to_the_same_claude_and_closing_stops_it() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().display();
        let fake = script(dir.path(), &format!("echo $$ >> {d}/pids.txt\nwhile IFS= read -r line; do\n  printf '%s\\n' \"$line\" >> {d}/stdin.txt\n  printf '%s\\n' '{INIT}'\n  printf '%s\\n' '{RESULT}'\ndone"));
        let (emit, mut rx) = channel();
        let asides = Asides::default();
        let l = launch(fake, dir.path());
        asides.ask("a1", "s1", &l, "first?", emit.clone()).await.unwrap();
        until(&mut rx, |e| matches!(e.event, Some(UiEvent::TurnDone { .. }))).await;
        asides.ask("a1", "s1", &l, "and then?", emit).await.unwrap();
        until(&mut rx, |e| matches!(e.event, Some(UiEvent::TurnDone { .. }))).await;
        // One process answered both; only the first question carries the note.
        let pids = file(&dir.path().join("pids.txt")).await;
        assert_eq!(pids.lines().count(), 1);
        let sent: Vec<serde_json::Value> = std::fs::read_to_string(dir.path().join("stdin.txt")).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(sent.len(), 2);
        assert!(sent[0]["message"]["content"][0]["text"].as_str().unwrap().starts_with('['));
        assert_eq!(sent[1]["message"]["content"][0]["text"], "and then?");
        let pid: libc::pid_t = pids.trim().parse().unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, 0, "still running while open");
        asides.stop("a1").await;
        let gone = tokio::time::timeout(Duration::from_secs(5), async {
            while unsafe { libc::kill(pid, 0) } == 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        assert!(gone.is_ok(), "closing the side chat left its claude running");
        // Closing a side chat that isn't open is fine, and a new one starts over.
        asides.stop("a1").await;
        assert!(asides.open.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_question_that_looks_at_too_many_files_is_interrupted() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().display();
        let calls: String = (0..=MAX_STEPS).map(|i| format!("printf '%s\\n' '{{\"type\":\"assistant\",\"message\":{{\"id\":\"m{i}\",\"content\":[{{\"type\":\"tool_use\",\"id\":\"t{i}\",\"name\":\"Read\",\"input\":{{\"file_path\":\"/a{i}\"}}}}]}}}}'\n")).collect();
        let fake = script(dir.path(), &format!("while IFS= read -r line; do\n  case \"$line\" in *interrupt*) printf '%s\\n' \"$line\" >> {d}/interrupts.txt ;; *) {calls} ;; esac\ndone"));
        let (emit, mut rx) = channel();
        let asides = Asides::default();
        asides.ask("a1", "s1", &launch(fake, dir.path()), "everything?", emit).await.unwrap();
        let note = until(&mut rx, |e| e.note.is_some()).await;
        assert!(note.note.unwrap().contains("too many files"));
        let sent = file(&dir.path().join("interrupts.txt")).await;
        assert!(sent.contains("\"interrupt\""), "{sent}");
        asides.stop("a1").await;
    }

    #[tokio::test]
    async fn a_side_chat_takes_so_many_questions_and_one_at_a_time() {
        let dir = tempfile::tempdir().unwrap();
        let fake = script(dir.path(), &format!("while IFS= read -r line; do\n  printf '%s\\n' '{INIT}'\n  printf '%s\\n' '{RESULT}'\ndone"));
        let (emit, mut rx) = channel();
        let asides = Asides::default();
        let l = launch(fake, dir.path());
        for i in 0..MAX_QUESTIONS {
            asides.ask("a1", "s1", &l, &format!("q{i}"), emit.clone()).await.unwrap();
            until(&mut rx, |e| matches!(e.event, Some(UiEvent::TurnDone { .. }))).await;
        }
        let err = asides.ask("a1", "s1", &l, "one more", emit.clone()).await.unwrap_err();
        assert!(err.contains("10 questions"), "{err}");
        // Another chat's side chat can't be asked into, and an empty question is refused.
        assert!(asides.ask("a1", "s2", &l, "x", emit.clone()).await.unwrap_err().contains("another chat"));
        assert!(asides.ask("a2", "s1", &l, "   ", emit.clone()).await.is_err());
        assert!(asides.ask("../x", "s1", &l, "x", emit).await.is_err());
        asides.stop_slot("s1").await;
        assert!(asides.open.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_folder_that_is_gone_is_a_clear_error_and_leaves_nothing_open() {
        let dir = tempfile::tempdir().unwrap();
        let (emit, _rx) = channel();
        let asides = Asides::default();
        let l = launch(dir.path().join("nope"), &dir.path().join("gone"));
        assert!(asides.ask("a1", "s1", &l, "x", emit).await.unwrap_err().contains("no longer exists"));
        assert!(asides.open.lock().unwrap().is_empty());
    }
}
