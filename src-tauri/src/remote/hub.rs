//! What Lantern keeps of each chat for a client that joins late (a paired phone): where the chat stands, its recent
//! events with their numbers, its title and its session. Fed by the event bus (see bus.rs), so it holds what every
//! client was sent; anything older than it keeps is read from the chat's transcript.

use super::bus::BusEvent;
use super::protocol::RemotePreset;
use crate::ui_event::UiEvent;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;

/// How much of a chat's recent events is kept, in bytes of their JSON. Streamed text is folded into its block's final
/// text as soon as that comes, so this holds whole turns of an ordinary chat.
pub const CHAT_CAP: usize = 2 << 20;

/// Where a chat stands, as a list of chats shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatStatus {
    /// Something is waiting for the user's answer: a permission, an approval, a question.
    NeedsYou,
    Working,
    Idle,
    /// Its claude was stopped to save memory; it wakes when it is opened.
    Asleep,
    /// Its claude stopped on its own (it crashed, or was closed).
    Ended,
}

/// One chat as a list shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChatInfo {
    pub slot: String,
    pub title: Option<String>,
    pub folder: Option<String>,
    pub session_id: Option<String>,
    pub status: ChatStatus,
    /// The number of its latest event (0: none yet).
    pub last_seq: u64,
    /// When something last happened in it (ms since the epoch).
    pub active_at: u64,
    /// "ask" or "auto", as the window says (None until it has).
    pub permissions: Option<String>,
    /// The id of the preset it runs on, as the window says (None until it has).
    pub preset: Option<String>,
    /// The colour the window gives the chat's project, "#rrggbb" (None until it has).
    pub color: Option<String>,
    /// "chat", "steps" or "team", as the window says (None until it has).
    pub workflow: Option<String>,
}

/// What came after a number a client had.
#[derive(Debug, Clone, PartialEq)]
pub enum Since {
    /// Every event after it that is still kept, oldest first (streamed text already folded may be missing: its block's
    /// final text comes instead).
    Events(Vec<BusEvent>),
    /// The events right after it are no longer kept: the client starts again from the transcript and `kept`.
    TooOld { kept: Vec<BusEvent> },
}

#[derive(Default)]
struct Log {
    entries: VecDeque<(BusEvent, usize)>,
    bytes: usize,
    /// Events numbered up to this one are no longer kept.
    floor: u64,
    last_seq: u64,
    working: bool,
    ended: bool,
    asleep: bool,
    pending: HashSet<String>,
    title: Option<String>,
    /// The first thing the user said, as the title until the chat has one.
    first_prompt: Option<String>,
    folder: Option<String>,
    session_id: Option<String>,
    active_at: u64,
    permissions: Option<String>,
    preset: Option<String>,
    color: Option<String>,
    workflow: Option<String>,
    /// What the chat's claude last said it offers after a "/", and the plan it last kept: a phone that opens the chat is
    /// told them whatever the kept events no longer reach.
    commands: Option<Vec<crate::ui_event::SlashCommand>>,
    todos: Option<Vec<crate::ui_event::Todo>>,
    /// The tokens the chat holds, and its model's context size once a turn's result said it.
    context: Option<u64>,
    window: Option<u64>,
    /// The chat runs on another provider than Claude Code (a gateway's model, Codex): what is said in it is never put to Claude
    /// for the phone's suggestions, which are made on the user's own Claude login.
    off_claude: bool,
}

impl Log {
    fn status(&self) -> ChatStatus {
        if self.asleep {
            ChatStatus::Asleep
        } else if !self.pending.is_empty() {
            ChatStatus::NeedsYou
        } else if self.working {
            ChatStatus::Working
        } else if self.ended {
            ChatStatus::Ended
        } else {
            ChatStatus::Idle
        }
    }

    fn info(&self, slot: &str) -> ChatInfo {
        ChatInfo {
            slot: slot.to_string(),
            title: self.title.clone().or_else(|| self.first_prompt.clone()),
            folder: self.folder.clone(),
            session_id: self.session_id.clone(),
            status: self.status(),
            last_seq: self.last_seq,
            active_at: self.active_at,
            permissions: self.permissions.clone(),
            preset: self.preset.clone(),
            color: self.color.clone(),
            workflow: self.workflow.clone(),
        }
    }

    fn note(&mut self, event: &UiEvent) {
        match event {
            UiEvent::UserText { text, .. } => {
                self.working = true;
                if self.first_prompt.is_none() {
                    self.first_prompt = title_from(text);
                }
            }
            UiEvent::Thinking { .. } | UiEvent::TextDelta { .. } | UiEvent::ToolStarted { .. } => self.working = true,
            UiEvent::TurnDone { context_window, .. } => {
                self.working = false;
                self.window = context_window.or(self.window);
            }
            UiEvent::PermissionRequested { request_id, .. } => {
                self.pending.insert(request_id.clone());
            }
            UiEvent::PermissionWithdrawn { request_id } | UiEvent::PermissionResolved { request_id, .. } => {
                self.pending.remove(request_id);
            }
            UiEvent::SessionStarted { session_id, cwd, .. } => {
                (self.ended, self.asleep) = (false, false);
                self.pending.clear();
                self.session_id = Some(session_id.clone());
                self.folder.get_or_insert_with(|| cwd.clone());
            }
            UiEvent::SessionEnded { .. } => {
                (self.working, self.ended) = (false, true);
                self.pending.clear();
            }
            UiEvent::AgentAsleep { asleep } => self.asleep = *asleep,
            UiEvent::ConversationReset => {
                self.first_prompt = None;
                (self.todos, self.context) = (None, None);
            }
            UiEvent::ContextUsed { tokens } => self.context = Some(*tokens),
            UiEvent::Commands { commands } => self.commands = Some(commands.clone()),
            UiEvent::Todos { parent: None, items } => self.todos = Some(items.clone()),
            _ => {}
        }
    }

    fn keep(&mut self, ev: &BusEvent, cap: usize) {
        // A block's final text stands for the pieces it streamed in: they go.
        if let UiEvent::AssistantText { block_id, parent, .. } = &ev.event {
            let mut freed = 0;
            self.entries.retain(|(e, size)| {
                let streamed = matches!(&e.event, UiEvent::TextDelta { block_id: b, parent: p, .. } if b == block_id && p == parent);
                if streamed {
                    freed += size;
                }
                !streamed
            });
            self.bytes -= freed;
        }
        let size = serde_json::to_vec(&ev.event).map_or(0, |v| v.len());
        self.entries.push_back((ev.clone(), size));
        self.bytes += size;
        // The newest event is always kept, however big.
        while self.bytes > cap && self.entries.len() > 1 {
            if let Some((old, size)) = self.entries.pop_front() {
                self.bytes -= size;
                self.floor = old.seq;
            }
        }
    }
}

/// Whether a phone may be sent what a step printed: a command's output, a skill's, a helper's report, the advisor's, an MCP
/// tool's. Not what Claude read from a file or the web (Read, Grep, Glob, WebFetch, WebSearch), nor what it wrote: a phone is
/// shown those as a line, and the diff of an edit, and no more. Anything else (a tool this list doesn't know) is refused too.
pub fn output_may_be_read(tool: &str) -> bool {
    matches!(tool, "Bash" | "BashOutput" | "Skill" | "Agent" | "Task" | "advisor") || tool.strip_prefix("mcp__").and_then(|rest| rest.split_once("__")).is_some_and(|(server, name)| !server.is_empty() && !name.is_empty())
}

/// The first line of what the user typed, without the notes Lantern puts before it, cut to a title's length.
pub fn title_from(text: &str) -> Option<String> {
    let typed = without_notes(text);
    let line = typed.lines().map(str::trim).find(|l| !l.is_empty())?;
    let mut title: String = line.chars().take(80).collect();
    if line.chars().count() > 80 {
        title.push('…');
    }
    Some(title)
}

/// A message without the notes Lantern puts before it: each is a `[Lantern…]` block, the long ones running to their end
/// mark (they have blank lines of their own).
pub fn without_notes(text: &str) -> &str {
    let mut rest = text.trim_start();
    while rest.starts_with("[Lantern") {
        let short = rest.split_once("\n\n").filter(|(block, _)| block.trim_end().ends_with(']')).map(|(_, after)| after);
        let long = rest.split_once(crate::args::NOTE_END).map(|(_, after)| after);
        // The nearer end: a short note's, unless a long note's end mark comes before the first blank line after it.
        let next = match (short, long) {
            (Some(s), Some(l)) => Some(if l.len() > s.len() { l } else { s }),
            (s, l) => s.or(l),
        };
        match next {
            Some(after) => rest = after.trim_start(),
            // A note with nothing after it: the message is only a note (Lantern's own, like a wake-up).
            None if rest.trim_end().ends_with(']') => return "",
            None => break,
        }
    }
    rest
}

pub struct SessionHub {
    chats: Mutex<HashMap<String, Log>>,
    /// The presets the window offers (Settings › Models), as it last said.
    presets: Mutex<Vec<RemotePreset>>,
    /// The subscription's usage as the last chat to report it said (it is the account's, the same in every chat).
    plan: Mutex<Option<UiEvent>>,
    cap: usize,
    now: fn() -> u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

impl Default for SessionHub {
    fn default() -> Self {
        Self::with_cap(CHAT_CAP)
    }
}

impl SessionHub {
    pub fn with_cap(cap: usize) -> Self {
        Self { chats: Mutex::default(), presets: Mutex::default(), plan: Mutex::default(), cap, now: now_ms }
    }

    /// Keeps an event the bus numbered, and what it says about where its chat stands.
    pub fn record(&self, ev: &BusEvent) {
        if matches!(ev.event, UiEvent::PlanUsage { .. }) {
            *self.plan.lock().unwrap() = Some(ev.event.clone());
        }
        let mut chats = self.chats.lock().unwrap();
        let log = chats.entry(ev.slot.clone()).or_default();
        log.note(&ev.event);
        log.keep(ev, self.cap);
        log.last_seq = ev.seq;
        log.active_at = (self.now)();
    }

    /// A chat's claude starts in `folder` (it is listed from now on, before its first event).
    pub fn opened(&self, slot: &str, folder: &str) {
        let mut chats = self.chats.lock().unwrap();
        let log = chats.entry(slot.to_string()).or_default();
        log.folder = Some(folder.to_string());
        log.active_at = log.active_at.max((self.now)());
    }

    /// Marks whether the chat runs on a provider other than Claude Code (set each time it starts), so what is said in it stays
    /// out of anything made on Claude.
    pub fn set_off_claude(&self, slot: &str, off: bool) {
        // Only a chat that is listed: this must never make one appear.
        if let Some(log) = self.chats.lock().unwrap().get_mut(slot) {
            log.off_claude = off;
        }
    }

    pub fn is_off_claude(&self, slot: &str) -> bool {
        self.chats.lock().unwrap().get(slot).is_some_and(|log| log.off_claude)
    }

    /// The chat was closed: it is no longer listed, and what was kept of it goes.
    pub fn closed(&self, slot: &str) {
        self.chats.lock().unwrap().remove(slot);
    }

    /// The chat is asleep (its claude stopped to save memory, or it was restored and not opened yet), with what the window
    /// knows of it. It stays listed, and can be woken.
    pub fn asleep(&self, slot: &str, folder: &str, title: Option<String>, session_id: Option<String>) {
        let mut chats = self.chats.lock().unwrap();
        let log = chats.entry(slot.to_string()).or_default();
        (log.asleep, log.working) = (true, false);
        log.pending.clear();
        log.folder = Some(folder.to_string());
        log.title = title.or(log.title.take());
        log.session_id = session_id.or(log.session_id.take());
    }

    /// The window says the chat is awake (its claude was started again). Claude names its session only once it has a message to
    /// answer, so a woken chat sends no start until then and would stay asleep here: this is what ends it.
    pub fn awake(&self, slot: &str) {
        if let Some(log) = self.chats.lock().unwrap().get_mut(slot) {
            log.asleep = false;
        }
    }

    /// The window knows which session a chat is. Claude only names its session once it has a message to answer, so a chat
    /// resumed from History has none here until then, and without it its transcript can't be found for a phone. Claude's own
    /// word (the session's start) stands once it has come: this only fills a gap.
    pub fn session(&self, slot: &str, session_id: &str) {
        if let Some(log) = self.chats.lock().unwrap().get_mut(slot) {
            log.session_id.get_or_insert_with(|| session_id.to_string());
        }
    }

    /// What the window says a chat runs on: Ask or Auto, and a preset. Only a chat the hub lists is given them, and only
    /// "ask" or "auto" is taken as the first.
    pub fn controls(&self, slot: &str, permissions: &str, preset: Option<&str>) {
        if let Some(log) = self.chats.lock().unwrap().get_mut(slot) {
            if matches!(permissions, "ask" | "auto") {
                log.permissions = Some(permissions.to_string());
            }
            log.preset = preset.map(String::from);
        }
    }

    /// The colour the window gives a chat's project (the one its sidebar shows), so a phone shows the same. Only "#rrggbb" is
    /// taken; anything else leaves the chat with none.
    pub fn colored(&self, slot: &str, color: Option<&str>) {
        let ok = |c: &str| c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|h| h.is_ascii_hexdigit());
        if let Some(log) = self.chats.lock().unwrap().get_mut(slot) {
            log.color = color.filter(|c| ok(c)).map(str::to_string);
        }
    }

    /// The workflow the window says a chat is on. Only "chat", "steps" and "team" are taken, and only for a chat the hub lists.
    pub fn flow(&self, slot: &str, workflow: &str) {
        if let Some(log) = self.chats.lock().unwrap().get_mut(slot) {
            if matches!(workflow, "chat" | "steps" | "team") {
                log.workflow = Some(workflow.to_string());
            }
        }
    }

    /// The presets the window offers, as it says them (at most a few dozen, with their texts cut short).
    pub fn set_presets(&self, presets: Vec<RemotePreset>) {
        let cut = |s: String, n: usize| s.chars().take(n).collect::<String>();
        *self.presets.lock().unwrap() = presets.into_iter().take(40).map(|p| RemotePreset { id: cut(p.id, 64), name: cut(p.name, 60), summary: cut(p.summary, 160) }).collect();
    }

    pub fn presets(&self) -> Vec<RemotePreset> {
        self.presets.lock().unwrap().clone()
    }

    /// The window's title for the chat (it beats the first prompt).
    pub fn titled(&self, slot: &str, title: &str) {
        if let Some(log) = self.chats.lock().unwrap().get_mut(slot) {
            log.title = Some(title.to_string());
        }
    }

    /// Every chat, the most recently active first.
    pub fn chats(&self) -> Vec<ChatInfo> {
        let chats = self.chats.lock().unwrap();
        let mut all: Vec<ChatInfo> = chats.iter().map(|(slot, log)| log.info(slot)).collect();
        all.sort_by(|a, b| b.active_at.cmp(&a.active_at).then_with(|| a.slot.cmp(&b.slot)));
        all
    }

    pub fn chat(&self, slot: &str) -> Option<ChatInfo> {
        self.chats.lock().unwrap().get(slot).map(|log| log.info(slot))
    }

    /// What a phone that opens the chat is told besides its events: the commands claude offers there, its plan and the context
    /// it holds (each only if it has been said), since the kept events may no longer reach them.
    pub fn extras(&self, slot: &str) -> Vec<super::protocol::RemoteEvent> {
        let chats = self.chats.lock().unwrap();
        let Some(log) = chats.get(slot) else { return Vec::new() };
        let mut out = Vec::new();
        out.extend(log.commands.clone().and_then(|commands| super::protocol::to_remote(&UiEvent::Commands { commands })));
        out.extend(log.todos.clone().and_then(|items| super::protocol::to_remote(&UiEvent::Todos { parent: None, items })));
        out.extend(log.context.map(|tokens| super::protocol::RemoteEvent::Context { tokens, window: log.window }));
        out
    }

    /// The chat's own title, when it has one: never the stand-in made from the first thing the user said, which would put their
    /// words on a lock screen.
    pub fn real_title(&self, slot: &str) -> Option<String> {
        self.chats.lock().unwrap().get(slot)?.title.clone()
    }

    /// How far the chat's own plan has got, as steps done and steps in all (None when it keeps none): counts only, never what the
    /// steps say.
    pub fn steps(&self, slot: &str) -> Option<(u32, u32)> {
        let chats = self.chats.lock().unwrap();
        let todos = chats.get(slot)?.todos.as_ref().filter(|t| !t.is_empty())?;
        Some((todos.iter().filter(|t| t.status == "completed").count() as u32, todos.len() as u32))
    }

    /// The subscription's usage as the last chat to report it said: how much of the window, when it resets, and the status.
    pub fn plan(&self) -> Option<(f64, Option<u64>, String)> {
        match self.plan.lock().unwrap().as_ref()? {
            UiEvent::PlanUsage { used, resets_at, status } => Some((*used, *resets_at, status.clone())),
            _ => None,
        }
    }

    /// What the chat's step printed when it finished, if the hub still keeps it, cut to what a phone is sent. Only for the
    /// steps whose output a phone is meant to read (see `output_may_be_read`): never what Claude read from a file.
    pub fn step_output(&self, slot: &str, tool_use_id: &str) -> Option<String> {
        let chats = self.chats.lock().unwrap();
        let log = chats.get(slot)?;
        let allowed = log.entries.iter().any(|(e, _)| matches!(&e.event, UiEvent::ToolStarted { parent: None, tool_use_id: id, name, .. } if id == tool_use_id && output_may_be_read(name)));
        if !allowed {
            return None;
        }
        let output = log.entries.iter().rev().find_map(|(e, _)| match &e.event {
            UiEvent::ToolFinished { parent: None, tool_use_id: id, output, .. } if id == tool_use_id => Some(output.as_str()),
            _ => None,
        })?;
        let mut cut: String = output.chars().take(super::protocol::STEP_OUTPUT_MAX).collect();
        if output.chars().count() > super::protocol::STEP_OUTPUT_MAX {
            cut.push_str(super::protocol::CUT);
        }
        Some(cut)
    }

    /// What came after event `after` of the chat (None: no such chat).
    pub fn since(&self, slot: &str, after: u64) -> Option<Since> {
        let chats = self.chats.lock().unwrap();
        let log = chats.get(slot)?;
        let kept = |from: u64| log.entries.iter().filter(|(e, _)| e.seq > from).map(|(e, _)| e.clone()).collect();
        Some(if after < log.floor { Since::TooOld { kept: kept(0) } } else { Since::Events(kept(after)) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hub() -> SessionHub {
        SessionHub { chats: Mutex::default(), presets: Mutex::default(), plan: Mutex::default(), cap: CHAT_CAP, now: || 1000 }
    }

    fn feed(hub: &SessionHub, slot: &str, events: Vec<UiEvent>) {
        let start = hub.chat(slot).map_or(0, |c| c.last_seq);
        for (i, event) in events.into_iter().enumerate() {
            hub.record(&BusEvent { slot: slot.into(), seq: start + i as u64 + 1, event });
        }
    }

    fn delta(block: &str, t: &str) -> UiEvent {
        UiEvent::TextDelta { parent: None, block_id: block.into(), text: t.into() }
    }

    fn user(t: &str) -> UiEvent {
        UiEvent::UserText { text: t.into(), at: None, sent_by: None, images: 0 }
    }

    fn done() -> UiEvent {
        UiEvent::TurnDone { is_error: false, result: None, cost_usd: None, tokens: None, session_cost_usd: None, session_tokens: 0, duration_ms: None, auth_hint: false, denied: 0, context_window: None }
    }

    fn events(s: Since) -> Vec<UiEvent> {
        match s {
            Since::Events(e) => e.into_iter().map(|e| e.event).collect(),
            Since::TooOld { .. } => panic!("expected events"),
        }
    }

    #[test]
    fn a_finished_block_stands_for_the_pieces_it_streamed_in() {
        let hub = hub();
        feed(&hub, "a", vec![user("hi"), delta("b1", "Hel"), delta("b1", "lo"), delta("b2", "other")]);
        feed(&hub, "a", vec![UiEvent::AssistantText { parent: None, block_id: "b1".into(), text: "Hello".into() }]);
        let kept = events(hub.since("a", 0).unwrap());
        assert_eq!(kept.len(), 3, "{kept:?}");
        assert!(matches!(&kept[1], UiEvent::TextDelta { block_id, .. } if block_id == "b2"));
        assert!(matches!(&kept[2], UiEvent::AssistantText { text, .. } if text == "Hello"));
        // A subagent's block with the same id is its own.
        feed(&hub, "a", vec![UiEvent::TextDelta { parent: Some("t1".into()), block_id: "b2".into(), text: "sub".into() }, UiEvent::AssistantText { parent: None, block_id: "b2".into(), text: "other".into() }]);
        assert!(events(hub.since("a", 0).unwrap()).iter().any(|e| matches!(e, UiEvent::TextDelta { parent: Some(_), .. })));
    }

    #[test]
    fn a_chat_keeps_no_more_than_its_cap_and_a_client_too_far_behind_starts_again() {
        let hub = SessionHub { chats: Mutex::default(), presets: Mutex::default(), plan: Mutex::default(), cap: 400, now: || 1 };
        let long = "x".repeat(150);
        feed(&hub, "a", (0..6).map(|_| UiEvent::AssistantText { parent: None, block_id: "b".into(), text: long.clone() }).collect());
        let Some(Since::TooOld { kept }) = hub.since("a", 0) else { panic!("events 1.. are gone") };
        assert!(!kept.is_empty() && kept.len() < 6);
        let first_kept = kept[0].seq;
        assert!(matches!(hub.since("a", first_kept - 1), Some(Since::Events(_))), "from right before what's kept, nothing is missing");
        assert_eq!(events(hub.since("a", 6).unwrap()), vec![]);
        assert!(hub.since("nope", 0).is_none());
    }

    #[test]
    fn the_newest_event_is_kept_even_when_it_is_bigger_than_the_cap() {
        let hub = SessionHub { chats: Mutex::default(), presets: Mutex::default(), plan: Mutex::default(), cap: 10, now: || 1 };
        feed(&hub, "a", vec![user("a long message, longer than the cap")]);
        assert_eq!(events(hub.since("a", 0).unwrap()).len(), 1);
    }

    #[test]
    fn a_chats_steps_are_counted_and_its_real_title_is_never_the_stand_in() {
        let hub = SessionHub { chats: Mutex::default(), presets: Mutex::default(), plan: Mutex::default(), cap: 10, now: || 1 };
        let todo = |s: &str| crate::ui_event::Todo { content: "secret step".into(), status: s.into(), active_form: "a".into() };
        feed(&hub, "a", vec![UiEvent::UserText { text: "my first message".into(), at: None, sent_by: None, images: 0 }]);
        assert_eq!(hub.steps("a"), None, "no plan yet");
        assert_eq!(hub.chat("a").unwrap().title.as_deref(), Some("my first message"), "the list may stand in the first message");
        assert_eq!(hub.real_title("a"), None, "but the lock screen never does");
        feed(&hub, "a", vec![UiEvent::Todos { parent: None, items: vec![todo("completed"), todo("in_progress"), todo("pending")] }]);
        assert_eq!(hub.steps("a"), Some((1, 3)));
        feed(&hub, "a", vec![UiEvent::Todos { parent: None, items: vec![] }]);
        assert_eq!(hub.steps("a"), None, "an empty plan is no plan");
        hub.titled("a", "Release 0.1.63");
        assert_eq!(hub.real_title("a").as_deref(), Some("Release 0.1.63"));
        assert_eq!((hub.steps("nope"), hub.real_title("nope")), (None, None));
    }

    #[test]
    fn the_latest_commands_plan_and_context_are_kept_past_the_events_cap() {
        let hub = SessionHub { chats: Mutex::default(), presets: Mutex::default(), plan: Mutex::default(), cap: 10, now: || 1 };
        let todo = |s: &str| crate::ui_event::Todo { content: "a".into(), status: s.into(), active_form: "a".into() };
        feed(&hub, "a", vec![UiEvent::Todos { parent: None, items: vec![todo("pending")] }, UiEvent::Todos { parent: None, items: vec![todo("completed")] }, UiEvent::ContextUsed { tokens: 50_000 }, UiEvent::PlanUsage { used: 0.2, resets_at: None, status: "allowed".into() }]);
        feed(&hub, "b", vec![UiEvent::PlanUsage { used: 0.3, resets_at: Some(5), status: "allowed".into() }]);
        // Pushed out of the few events kept, they are still told.
        feed(&hub, "a", (0..4).map(|_| UiEvent::AssistantText { parent: None, block_id: "x".into(), text: "y".repeat(200) }).collect());
        use super::super::protocol::RemoteEvent as R;
        let told = hub.extras("a");
        assert!(matches!(&told[0], R::Todos { items } if items[0].status == "completed"));
        assert_eq!(told[1], R::Context { tokens: 50_000, window: None });
        assert_eq!(told.len(), 2);
        assert_eq!(hub.plan(), Some((0.3, Some(5), "allowed".to_string())), "the account's usage is the last one said, by any chat");
        // A turn's result says the model's context size, and it is told from then on.
        let mut finished = done();
        if let UiEvent::TurnDone { context_window, .. } = &mut finished {
            *context_window = Some(200_000);
        }
        feed(&hub, "a", vec![finished]);
        assert_eq!(hub.extras("a")[1], R::Context { tokens: 50_000, window: Some(200_000) });
        feed(&hub, "a", vec![UiEvent::ConversationReset]);
        assert!(hub.extras("a").is_empty(), "a new conversation has no plan and holds nothing");
    }

    #[test]
    fn a_finished_steps_output_is_told_while_it_is_kept_and_cut_when_long() {
        let hub = hub();
        let finished = |id: &str, output: String| UiEvent::ToolFinished { parent: None, tool_use_id: id.into(), is_error: false, output };
        let started = |id: &str, name: &str| UiEvent::ToolStarted { parent: None, tool_use_id: id.into(), name: name.into(), summary: String::new() };
        feed(
            &hub,
            "a",
            vec![
                started("t1", "Bash"),
                finished("t1", "ok\n3 passed".into()),
                started("t2", "mcp__claude_ai_Linear__list_issues"),
                finished("t2", "x".repeat(super::super::protocol::STEP_OUTPUT_MAX + 50)),
                UiEvent::ToolStarted { parent: Some("sub".into()), tool_use_id: "t3".into(), name: "Bash".into(), summary: String::new() },
                UiEvent::ToolFinished { parent: Some("sub".into()), tool_use_id: "t3".into(), is_error: false, output: "a subagent's".into() },
                started("t4", "Read"),
                finished("t4", "API_KEY=hunter2".into()),
                finished("t5", "no start was kept".into()),
            ],
        );
        assert_eq!(hub.step_output("a", "t1").as_deref(), Some("ok\n3 passed"));
        let long = hub.step_output("a", "t2").unwrap();
        assert!(long.ends_with(super::super::protocol::CUT) && long.chars().count() < super::super::protocol::STEP_OUTPUT_MAX + 100);
        assert_eq!((hub.step_output("a", "t3"), hub.step_output("a", "nope"), hub.step_output("b", "t1")), (None, None, None), "a subagent's step, one never seen, a chat not kept");
        // What Claude read from a file stays on the Mac, as does the output of a step whose start isn't kept.
        assert_eq!((hub.step_output("a", "t4"), hub.step_output("a", "t5")), (None, None));
        for tool in ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "Edit", "Write", "MultiEdit", "NotebookEdit", "TodoWrite", "mcp__x", "mcp____y", "Bashx", ""] {
            assert!(!output_may_be_read(tool), "{tool}");
        }
        for tool in ["Bash", "BashOutput", "Skill", "Agent", "Task", "advisor", "mcp__github__get_file"] {
            assert!(output_may_be_read(tool), "{tool}");
        }
    }

    #[test]
    fn status_follows_turns_prompts_and_sleep() {
        let hub = hub();
        hub.opened("a", "/p");
        assert_eq!(hub.chat("a").unwrap().status, ChatStatus::Idle);
        feed(&hub, "a", vec![user("go")]);
        assert_eq!(hub.chat("a").unwrap().status, ChatStatus::Working);
        feed(&hub, "a", vec![UiEvent::PermissionRequested { request_id: "p1".into(), tool_name: "Bash".into(), input: serde_json::json!({}) }]);
        assert_eq!(hub.chat("a").unwrap().status, ChatStatus::NeedsYou);
        feed(&hub, "a", vec![UiEvent::PermissionResolved { request_id: "p1".into(), allow: true, by: "desktop".into() }]);
        assert_eq!(hub.chat("a").unwrap().status, ChatStatus::Working);
        feed(&hub, "a", vec![UiEvent::PermissionRequested { request_id: "p2".into(), tool_name: "Bash".into(), input: serde_json::json!({}) }, UiEvent::PermissionWithdrawn { request_id: "p2".into() }, done()]);
        assert_eq!(hub.chat("a").unwrap().status, ChatStatus::Idle);
        feed(&hub, "a", vec![UiEvent::SessionEnded { code: Some(1), stderr_tail: String::new() }]);
        assert_eq!(hub.chat("a").unwrap().status, ChatStatus::Ended);
        hub.asleep("a", "/p", Some("Release".into()), Some("s1".into()));
        let c = hub.chat("a").unwrap();
        assert_eq!((c.status, c.title.as_deref(), c.session_id.as_deref()), (ChatStatus::Asleep, Some("Release"), Some("s1")));
        feed(&hub, "a", vec![UiEvent::SessionStarted { session_id: "s1".into(), model: "m".into(), cwd: "/p".into(), permission_mode: "auto".into(), claude_version: "1".into() }]);
        assert_eq!(hub.chat("a").unwrap().status, ChatStatus::Idle);
        hub.closed("a");
        assert!(hub.chat("a").is_none());
    }

    #[test]
    fn the_window_fills_a_chats_missing_session_but_never_replaces_claudes_own_or_lists_a_chat() {
        let hub = hub();
        hub.session("ghost", "aaaa-1111");
        assert!(hub.chat("ghost").is_none(), "a session for a chat the hub doesn't list doesn't list it");
        hub.opened("a", "/p");
        assert_eq!(hub.chat("a").unwrap().session_id, None);
        hub.session("a", "aaaa-1111");
        assert_eq!(hub.chat("a").unwrap().session_id.as_deref(), Some("aaaa-1111"));
        hub.session("a", "bbbb-2222");
        assert_eq!(hub.chat("a").unwrap().session_id.as_deref(), Some("aaaa-1111"), "the first one stands");
        // Claude's own start replaces it: that is the session now.
        feed(&hub, "a", vec![UiEvent::SessionStarted { session_id: "cccc-3333".into(), model: "m".into(), cwd: "/p".into(), permission_mode: "auto".into(), claude_version: "1".into() }]);
        assert_eq!(hub.chat("a").unwrap().session_id.as_deref(), Some("cccc-3333"));
    }

    #[test]
    fn a_chat_the_window_woke_is_awake_here_without_waiting_for_claudes_first_message() {
        let hub = hub();
        hub.asleep("a", "/p", Some("Old".into()), Some("aaaa-1111".into()));
        assert_eq!(hub.chat("a").unwrap().status, ChatStatus::Asleep);
        hub.awake("a");
        let a = hub.chat("a").unwrap();
        assert_eq!((a.status, a.session_id.as_deref(), a.title.as_deref()), (ChatStatus::Idle, Some("aaaa-1111"), Some("Old")), "awake, and nothing it knew is lost");
        // A chat the hub doesn't list isn't listed by it.
        hub.awake("ghost");
        assert!(hub.chat("ghost").is_none());
    }

    #[test]
    fn a_chat_has_the_mode_and_preset_the_window_says_and_only_for_a_chat_it_lists() {
        let hub = hub();
        hub.controls("ghost", "auto", Some("max"));
        assert!(hub.chat("ghost").is_none());
        hub.opened("a", "/p");
        hub.controls("a", "auto", Some("max"));
        let a = hub.chat("a").unwrap();
        assert_eq!((a.permissions.as_deref(), a.preset.as_deref()), (Some("auto"), Some("max")));
        // Something that isn't a mode leaves the mode as it was; the preset is whatever the window says.
        hub.controls("a", "bypassPermissions", None);
        let a = hub.chat("a").unwrap();
        assert_eq!((a.permissions.as_deref(), a.preset.as_deref()), (Some("auto"), None));
    }

    #[test]
    fn a_chat_has_its_projects_colour_only_as_a_hex_colour_and_only_if_it_is_listed() {
        let hub = hub();
        hub.colored("ghost", Some("#5b5bd6"));
        assert!(hub.chat("ghost").is_none());
        hub.opened("a", "/p");
        hub.colored("a", Some("#5b5bd6"));
        assert_eq!(hub.chat("a").unwrap().color.as_deref(), Some("#5b5bd6"));
        for bad in ["red", "#12345", "#12345g", "5b5bd6", "#5b5bd6;x", ""] {
            hub.colored("a", Some(bad));
            assert_eq!(hub.chat("a").unwrap().color, None, "{bad:?}");
        }
        hub.colored("a", Some("#0F8A7E"));
        hub.colored("a", None);
        assert_eq!(hub.chat("a").unwrap().color, None, "what the window says now replaces what it said");
    }

    #[test]
    fn a_chat_has_the_workflow_the_window_says_only_if_it_is_one_and_the_chat_is_listed() {
        let hub = hub();
        hub.flow("ghost", "steps");
        assert!(hub.chat("ghost").is_none());
        hub.opened("a", "/p");
        assert_eq!(hub.chat("a").unwrap().workflow, None);
        hub.flow("a", "steps");
        assert_eq!(hub.chat("a").unwrap().workflow.as_deref(), Some("steps"));
        hub.flow("a", "workflow");
        hub.flow("a", "");
        assert_eq!(hub.chat("a").unwrap().workflow.as_deref(), Some("steps"), "what isn't one leaves it as it was");
    }

    #[test]
    fn the_presets_the_window_offers_are_kept_with_their_texts_cut_short() {
        let hub = hub();
        let p = |id: &str, n: usize| RemotePreset { id: id.into(), name: "n".repeat(n), summary: "s".repeat(n) };
        hub.set_presets((0..50).map(|i| p(&format!("p{i}"), 500)).collect());
        let kept = hub.presets();
        assert_eq!(kept.len(), 40);
        assert_eq!((kept[0].name.len(), kept[0].summary.len()), (60, 160));
        hub.set_presets(vec![]);
        assert!(hub.presets().is_empty(), "what the window says now replaces what it said");
    }

    #[test]
    fn a_chat_is_titled_by_the_window_or_else_by_its_first_prompt_without_lanterns_notes() {
        let hub = hub();
        feed(&hub, "a", vec![user("[Lantern: this chat switched to Debug. The user picked it.]\n\nit crashes on save\nmore detail"), user("second")]);
        assert_eq!(hub.chat("a").unwrap().title.as_deref(), Some("it crashes on save"));
        hub.titled("a", "Save crash");
        assert_eq!(hub.chat("a").unwrap().title.as_deref(), Some("Save crash"));
    }

    #[test]
    fn notes_of_every_shape_are_left_out_of_a_title() {
        let settings = format!("{} … long:\n\nwith blank lines\n\n{}", crate::args::SETTINGS_NOTE_START, crate::args::NOTE_END);
        let guide = "[Lantern: this chat switched to Build. How Build works:\n\nBuild: …\n\n(end of Lantern's note)]";
        assert_eq!(title_from(&format!("{settings}\n\n{guide}\n\n[Lantern note: moved]\n\nship it")).as_deref(), Some("ship it"));
        assert_eq!(title_from(&"y".repeat(100)).unwrap().chars().count(), 81);
        assert_eq!(title_from("[Lantern: only a note]"), None);
    }

    #[test]
    fn chats_are_listed_most_recently_active_first() {
        static TICK: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let hub = SessionHub { chats: Mutex::default(), presets: Mutex::default(), plan: Mutex::default(), cap: CHAT_CAP, now: || TICK.fetch_add(1, std::sync::atomic::Ordering::SeqCst) };
        hub.opened("old", "/p");
        hub.opened("new", "/p");
        feed(&hub, "old", vec![user("again")]);
        let order: Vec<String> = hub.chats().into_iter().map(|c| c.slot).collect();
        assert_eq!(order, vec!["old", "new"]);
    }
}
