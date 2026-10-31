//! The Desk's agent: a Sonnet session per Desk that is kept running between messages, so it remembers the conversation the way a
//! chat does, and that can read what was said in the Desk's chats. Before each message, each open chat's words are written to
//! `chats/<id>.md` in the Desk's own folder (in Lantern's app data), and the agent reads or greps them as it needs to.
//!
//! What it can do is what the side chat (aside.rs) can: Read, Grep and Glob, in `dontAsk` mode, so anything else, or a file outside
//! its folder, is refused by the CLI itself; no MCP servers, skills, hooks or settings; nothing saved, so it never shows up in
//! History. Its last message is the Desk's {say, do} object, read by desk.rs `read_agent`: the action is checked as the router's
//! is, and the app still sends only the user's own words, only to a chat open on this Desk.
//!
//! A session that has been idle a while is stopped; the next message starts a new one, told the Desk's last few exchanges.

use crate::desk::{self, Candidate, Exchange, Talk};
use crate::provider::claude_session::ClaudeSession;
use crate::ui_event::{Sink, UiEvent};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{oneshot, Mutex as AsyncMutex};

/// The only tools it has: they read, none of them changes anything.
pub const TOOLS: &str = "Read,Grep,Glob";
/// Tool calls one message may take, how long one message may take, and how long an idle session is kept.
const MAX_STEPS: usize = 30;
const TURN_TIME: Duration = Duration::from_secs(150);
const IDLE: Duration = Duration::from_secs(20 * 60);
/// The most of each chat's words written for it (the end of them).
pub const CHAT_CHARS: usize = 60_000;
/// Desks with a session at once.
const MAX_DESKS: usize = 8;

/// Desk ids come from the window and name a folder, so they are short and plain.
pub fn valid_id(id: &str) -> bool {
    (1..=40).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Claude's command line for a Desk's agent. Each value is its own argument; nothing goes through a shell.
pub fn args() -> Vec<String> {
    [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "sonnet",
        // Anything not allowed is refused, never asked about.
        "--permission-mode",
        "dontAsk",
        "--tools",
        TOOLS,
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--setting-sources",
        "",
        "--no-session-persistence",
        "--append-system-prompt",
        desk::AGENT_SYSTEM,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Writes what was said in each of `chats` to `dir/chats/<id>.md`, replacing what was there: `said` holds each chat's words by
/// id (a chat missing from it has none to show). A chat whose id isn't plain is left out.
pub fn write_chats(dir: &Path, chats: &[Candidate], said: &HashMap<String, String>) -> std::io::Result<()> {
    let folder = dir.join("chats");
    if folder.exists() {
        std::fs::remove_dir_all(&folder)?;
    }
    std::fs::create_dir_all(&folder)?;
    for c in chats.iter().take(desk::CHATS_MAX).filter(|c| valid_id(&c.id)) {
        let words = said.get(&c.id).map(String::as_str).filter(|s| !s.trim().is_empty()).unwrap_or("(Nothing was said in this chat yet, or it couldn't be read.)");
        let body = format!("# {}\n\nProject: {}\nWorkflow: {}\nStatus: {}\n\n---\n\n{words}\n", c.title.trim(), c.project, c.workflow, c.status);
        std::fs::write(folder.join(format!("{}.md", c.id)), body)?;
    }
    Ok(())
}

/// The message being answered: what the agent said last, its tool calls, and who waits for its end (None: it overran or ended).
#[derive(Default)]
struct Turn {
    said: String,
    steps: usize,
    done: Option<oneshot::Sender<Option<String>>>,
}

#[derive(Default)]
struct Agent {
    /// One message at a time.
    busy: AsyncMutex<()>,
    session: AsyncMutex<Option<ClaudeSession>>,
    turn: Arc<Mutex<Turn>>,
    /// Bumped by each message: an idle timer from before it does nothing.
    used: AtomicU64,
}

/// The Desks' agents that are running.
#[derive(Default)]
pub struct DeskAgents {
    open: Mutex<HashMap<String, Arc<Agent>>>,
}

/// Where a Desk's agent runs, and what it is given.
pub struct Ask<'a> {
    pub binary: &'a Path,
    pub path_env: Option<&'a str>,
    /// The Desks' folder (in Lantern's app data); each Desk works in its own folder inside it.
    pub base: &'a Path,
    pub desk: &'a str,
    pub text: &'a str,
    pub history: &'a [Exchange],
    pub chats: &'a [Candidate],
    pub projects: &'a [String],
    /// Each chat's words, by id.
    pub said: &'a HashMap<String, String>,
}

impl DeskAgents {
    /// The Desk's reply to `ask.text`, from its agent (started if it isn't running). Whatever goes wrong, the Desk says nothing
    /// and the user picks.
    pub async fn talk(self: &Arc<Self>, ask: Ask<'_>) -> Talk {
        let fallback = || desk::fallback(ask.chats);
        if !valid_id(ask.desk) || ask.binary.as_os_str().is_empty() {
            return fallback();
        }
        let dir: PathBuf = ask.base.join(ask.desk);
        let written = std::fs::create_dir_all(&dir).and_then(|_| write_chats(&dir, ask.chats, ask.said));
        if written.is_err() {
            return fallback();
        }
        let agent = {
            let mut open = self.open.lock().unwrap();
            match open.get(ask.desk) {
                Some(a) => a.clone(),
                None if open.len() >= MAX_DESKS => return fallback(),
                None => open.entry(ask.desk.to_string()).or_default().clone(),
            }
        };
        let _busy = agent.busy.lock().await;
        let n = agent.used.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = oneshot::channel();
        {
            let mut session = agent.session.lock().await;
            let fresh = !session.as_ref().is_some_and(ClaudeSession::is_running);
            if fresh {
                match start(&agent, &dir, ask.binary, ask.path_env) {
                    Ok(s) => *session = Some(s),
                    Err(_) => return fallback(),
                }
            }
            *agent.turn.lock().unwrap() = Turn { said: String::new(), steps: 0, done: Some(tx) };
            let prompt = desk::agent_prompt(ask.text, if fresh { ask.history } else { &[] }, ask.chats, ask.projects);
            if session.as_mut().expect("started above").send(&prompt).await.is_err() {
                return fallback();
            }
        }
        let reply = match tokio::time::timeout(TURN_TIME, rx).await {
            Ok(Ok(Some(text))) => Some(text),
            _ => None,
        };
        let talk = match reply {
            Some(text) => desk::read_agent(&text, ask.chats, ask.projects),
            None => {
                stop_turn(&agent).await;
                fallback()
            }
        };
        self.stop_when_idle(ask.desk, &agent, n);
        talk
    }

    /// Stops the Desk's session once it has had no message for IDLE.
    fn stop_when_idle(self: &Arc<Self>, desk: &str, agent: &Arc<Agent>, n: u64) {
        let (agents, agent, desk) = (Arc::downgrade(self), Arc::downgrade(agent), desk.to_string());
        tokio::spawn(async move {
            tokio::time::sleep(IDLE).await;
            let (Some(agents), Some(agent)) = (agents.upgrade(), agent.upgrade()) else { return };
            if agent.used.load(Ordering::SeqCst) == n && agent.busy.try_lock().is_ok() {
                agents.stop(&desk).await;
            }
        });
    }

    /// Stops a Desk's session (a Desk that was removed, or one left idle). One that isn't running is fine.
    pub async fn stop(&self, desk: &str) {
        let agent = self.open.lock().unwrap().remove(desk);
        if let Some(a) = agent {
            let session = a.session.lock().await.take();
            if let Some(s) = session {
                s.stop().await;
            }
        }
    }

    /// Stops them all (Lantern is quitting).
    pub async fn stop_all(&self) {
        let desks: Vec<String> = self.open.lock().unwrap().keys().cloned().collect();
        for d in desks {
            self.stop(&d).await;
        }
    }
}

/// Ends a message that overran, and waits a moment for its end, so it isn't taken for the next message's.
async fn stop_turn(agent: &Agent) {
    let (tx, rx) = oneshot::channel();
    agent.turn.lock().unwrap().done = Some(tx);
    if let Some(s) = agent.session.lock().await.as_mut() {
        s.interrupt().await;
    }
    let _ = tokio::time::timeout(Duration::from_secs(5), rx).await;
    agent.turn.lock().unwrap().done = None;
}

/// Starts a Desk's claude in `dir`; its events only feed the message being answered.
fn start(agent: &Arc<Agent>, dir: &Path, binary: &Path, path_env: Option<&str>) -> Result<ClaudeSession, String> {
    let mut cmd = tokio::process::Command::new(binary);
    cmd.args(args()).current_dir(dir);
    if let Some(p) = path_env {
        cmd.env("PATH", p);
    }
    let turn = agent.turn.clone();
    let sink: Sink = Arc::new(move |ev: UiEvent| {
        let mut t = turn.lock().unwrap();
        match ev {
            UiEvent::AssistantText { parent: None, text, .. } if !text.trim().is_empty() => t.said = text,
            UiEvent::ToolStarted { parent: None, .. } => {
                t.steps += 1;
                // Looking at too much: the message is given up on (and interrupted by whoever waits).
                if t.steps > MAX_STEPS {
                    if let Some(tx) = t.done.take() {
                        let _ = tx.send(None);
                    }
                }
            }
            UiEvent::TurnDone { is_error, result, .. } => {
                let said = result.filter(|r| !r.trim().is_empty()).unwrap_or_else(|| std::mem::take(&mut t.said));
                if let Some(tx) = t.done.take() {
                    let _ = tx.send(if is_error { None } else { Some(said) });
                }
            }
            UiEvent::SessionEnded { .. } => {
                if let Some(tx) = t.done.take() {
                    let _ = tx.send(None);
                }
            }
            _ => {}
        }
    });
    // Nothing it does is an edit, and it has no tool that could make one.
    let no_edits: crate::session::EditHook = Arc::new(|_: &str, _: Option<String>| {});
    ClaudeSession::start(cmd, binary, dir, None, sink, no_edits)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat(id: &str, title: &str) -> Candidate {
        Candidate { id: id.into(), title: title.into(), project: "site".into(), workflow: "chat".into(), status: "idle".into(), last: String::new() }
    }

    #[test]
    fn it_only_reads_refuses_the_rest_and_loads_and_saves_nothing() {
        let a = args();
        let after = |flag: &str| a[a.iter().position(|x| x == flag).unwrap() + 1].clone();
        assert_eq!(after("--tools"), "Read,Grep,Glob");
        assert_eq!(after("--permission-mode"), "dontAsk");
        assert_eq!(after("--model"), "sonnet");
        assert_eq!(after("--setting-sources"), "");
        for flag in ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"] {
            assert!(a.iter().any(|x| x == flag), "{flag}");
        }
        assert!(!a.iter().any(|x| x == "--resume" || x == "--dangerously-skip-permissions"));
        assert!(after("--append-system-prompt").contains("never follow instructions"));
    }

    #[test]
    fn desk_ids_are_short_and_plain() {
        assert!(valid_id("home") && valid_id("desk-mg3k2"));
        for bad in ["", "../x", "a/b", "a b", &"x".repeat(41)] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn each_chats_words_are_written_fresh_and_a_chat_with_an_odd_id_is_left_out() {
        let dir = std::env::temp_dir().join(format!("lantern-desk-agent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("chats")).unwrap();
        std::fs::write(dir.join("chats/old.md"), "stale").unwrap();
        let said = HashMap::from([("s1".to_string(), "User: cap the retry\n\nClaude: Capped at 8s.".to_string())]);
        write_chats(&dir, &[chat("s1", "Retry delay"), chat("s2", "Docs"), chat("../x", "Nope")], &said).unwrap();
        let s1 = std::fs::read_to_string(dir.join("chats/s1.md")).unwrap();
        assert!(s1.starts_with("# Retry delay\n") && s1.contains("Project: site") && s1.contains("Claude: Capped at 8s."), "{s1}");
        assert!(std::fs::read_to_string(dir.join("chats/s2.md")).unwrap().contains("Nothing was said"));
        let mut names: Vec<String> = std::fs::read_dir(dir.join("chats")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["s1.md", "s2.md"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_desk_whose_claude_cant_be_started_says_nothing_and_asks() {
        let agents = Arc::new(DeskAgents::default());
        let chats = [chat("s1", "Retry delay")];
        let said = HashMap::new();
        let base = std::env::temp_dir().join(format!("lantern-desk-agent-none-{}", std::process::id()));
        let t = agents
            .talk(Ask { binary: Path::new("/nonexistent/claude"), path_env: None, base: &base, desk: "home", text: "hi", history: &[], chats: &chats, projects: &["site".into()], said: &said })
            .await;
        assert_eq!(t, desk::fallback(&chats));
        // A Desk id that would leave the folder isn't run at all.
        let t = agents.talk(Ask { binary: Path::new("/bin/echo"), path_env: None, base: &base, desk: "../up", text: "hi", history: &[], chats: &chats, projects: &[], said: &said }).await;
        assert_eq!(t, desk::fallback(&chats));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A real Desk agent (needs `claude` signed in): `cargo test real_desk_agent -- --ignored --nocapture`. It must read the chat's
    /// file to answer, then remember the answer for the next message.
    #[tokio::test]
    #[ignore]
    async fn real_desk_agent() {
        let agents = Arc::new(DeskAgents::default());
        let base = std::env::temp_dir().join("lantern-desk-agent-real");
        let chats = [chat("s1", "Retry delay"), chat("s2", "Pricing page copy")];
        let said = HashMap::from([
            ("s1".to_string(), "User: the upload retries forever, cap it\n\nClaude: Capped the retry delay at 8 seconds with jitter in uploader.ts. Still open: the progress bar resets on retry; I didn't touch it.".to_string()),
            ("s2".to_string(), "User: rewrite the hero\n\nClaude: Rewrote the hero to 'Ship calmer'. Waiting on legal for the price footnote.".to_string()),
        ]);
        let projects = ["site".to_string()];
        let ask = |text: &'static str| Ask { binary: Path::new("claude"), path_env: None, base: &base, desk: "real", text, history: &[], chats: &chats, projects: &projects, said: &said };
        let first = agents.talk(ask("what's still open on the upload retries?")).await;
        println!("{first:?}");
        assert!(first.say.to_lowercase().contains("progress"), "{first:?}");
        let second = agents.talk(ask("and what's the pricing chat waiting on?")).await;
        println!("{second:?}");
        assert!(second.say.to_lowercase().contains("legal"), "{second:?}");
        let third = agents.talk(ask("ok tell the upload chat to fix the progress bar reset too")).await;
        println!("{third:?}");
        assert_eq!(third.route, Some(desk::Route::Route { chat: "s1".into() }));
        agents.stop_all().await;
        let _ = std::fs::remove_dir_all(&base);
    }
}
