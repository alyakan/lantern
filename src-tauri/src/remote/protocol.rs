//! What Lantern and a paired phone say to each other, once their channel is open (see secure.rs). The phone is never
//! sent Lantern's own events (`UiEvent`): it gets `RemoteEvent`, chosen and trimmed here, so the desktop's internals can
//! change without breaking an app already on someone's phone. The TypeScript side is generated from these types
//! (`cargo test export_bindings`, into mobile/src/protocol/generated).

use crate::ui_event::UiEvent;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Bumped when a message changes in a way an older phone can't read. The phone refuses a Mac with another version and
/// asks for the newer app (or the newer Lantern) instead of breaking.
pub const PROTOCOL_VERSION: u32 = 1;

/// What this Mac says it can do beyond protocol 1 (Welcome's `features`): a phone sends a request only if its name is here,
/// since a Mac that doesn't know a request ends the connection.
pub const FEATURES: &[&str] = &["controls", "close"];

/// Where the generated TypeScript goes, from ts-rs's export folder (src-tauri/bindings): each type below says it again.
#[cfg(test)]
const BINDINGS: &str = "../../mobile/src/protocol/generated/";

/// An event of a chat, as the phone sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub enum RemoteEvent {
    /// What the user said, without the notes Lantern put before it; `sent_by`: "desktop", a phone's id, or none (history).
    UserText {
        text: String,
        #[ts(type = "number | null")]
        at: Option<u64>,
        sent_by: Option<String>,
    },
    /// Claude is thinking (the main thread; a subagent's thinking isn't sent).
    Thinking,
    TextDelta { block_id: String, text: String },
    AssistantText { block_id: String, text: String },
    ToolStarted { tool_use_id: String, name: String, summary: String },
    /// The step ended; its output isn't sent (the phone shows steps as a line each).
    ToolFinished { tool_use_id: String, is_error: bool },
    /// A file the step changed, as counts: its diff is a request of its own.
    FileEdited { tool_use_id: String, path: String, created: bool, added: u32, removed: u32 },
    TestsRan { tool_use_id: String, command: String, passed: u32, failed: u32, skipped: u32 },
    TurnDone {
        is_error: bool,
        result: Option<String>,
        #[ts(type = "number | null")]
        duration_ms: Option<u64>,
    },
    /// Something waits for the user's answer: Allow or Deny, an approval, or a question (AskUserQuestion's input).
    PermissionRequested {
        request_id: String,
        tool_name: String,
        #[ts(type = "unknown")]
        input: serde_json::Value,
    },
    PermissionWithdrawn { request_id: String },
    PermissionResolved { request_id: String, allow: bool, by: String },
    /// Something only the desktop can answer: a merge proposal, a failed setup.
    NeedsDesktop { what: String },
    SessionStarted { session_id: String },
    SessionEnded { code: Option<i32> },
    Asleep { asleep: bool },
    ConversationReset,
}

/// The phone's events for one of Lantern's, or none: subagents' insides, Lantern's bookkeeping and anything a phone
/// doesn't show stay on the Mac. Every event is named here, so a new one is a compile error until it is decided.
pub fn to_remote(event: &UiEvent) -> Option<RemoteEvent> {
    use RemoteEvent as R;
    use UiEvent as U;
    Some(match event {
        U::UserText { text, at, sent_by } => R::UserText { text: super::hub::without_notes(text).to_string(), at: *at, sent_by: sent_by.clone() },
        U::Thinking { parent: None } => R::Thinking,
        U::TextDelta { parent: None, block_id, text } => R::TextDelta { block_id: block_id.clone(), text: text.clone() },
        U::AssistantText { parent: None, block_id, text } => R::AssistantText { block_id: block_id.clone(), text: text.clone() },
        U::ToolStarted { parent: None, tool_use_id, name, summary } => R::ToolStarted { tool_use_id: tool_use_id.clone(), name: name.clone(), summary: summary.clone() },
        U::ToolFinished { parent: None, tool_use_id, is_error, .. } => R::ToolFinished { tool_use_id: tool_use_id.clone(), is_error: *is_error },
        U::EditApplied { parent: None, tool_use_id, path, created, hunks, .. } => {
            let count = |mark: char| hunks.iter().flat_map(|h| &h.lines).filter(|l| l.starts_with(mark)).count() as u32;
            R::FileEdited { tool_use_id: tool_use_id.clone(), path: path.clone(), created: *created, added: count('+'), removed: count('-') }
        }
        U::TestRun { parent: None, tool_use_id, command, run } => R::TestsRan { tool_use_id: tool_use_id.clone(), command: command.clone(), passed: run.passed, failed: run.failed, skipped: run.skipped },
        U::TurnDone { is_error, result, duration_ms, .. } => R::TurnDone { is_error: *is_error, result: result.clone(), duration_ms: *duration_ms },
        U::PermissionRequested { request_id, tool_name, input } => R::PermissionRequested { request_id: request_id.clone(), tool_name: tool_name.clone(), input: trimmed(input) },
        U::PermissionWithdrawn { request_id } => R::PermissionWithdrawn { request_id: request_id.clone() },
        U::PermissionResolved { request_id, allow, by } => R::PermissionResolved { request_id: request_id.clone(), allow: *allow, by: by.clone() },
        U::MergeProposed { name, .. } => R::NeedsDesktop { what: format!("{name} wants to merge its branch.") },
        U::AgentSetup { phase, .. } if phase == "failed" => R::NeedsDesktop { what: "An agent's setup failed.".into() },
        U::SessionStarted { session_id, .. } => R::SessionStarted { session_id: session_id.clone() },
        U::SessionEnded { code, .. } => R::SessionEnded { code: *code },
        U::AgentAsleep { asleep } => R::Asleep { asleep: *asleep },
        U::ConversationReset => R::ConversationReset,
        // A subagent's insides: the phone shows the step that started it, not what it does.
        U::Thinking { parent: Some(_) } | U::TextDelta { parent: Some(_), .. } | U::AssistantText { parent: Some(_), .. } | U::ToolStarted { parent: Some(_), .. } | U::ToolFinished { parent: Some(_), .. } | U::EditApplied { parent: Some(_), .. } | U::TestRun { parent: Some(_), .. } => return None,
        // Lantern's own bookkeeping, and what only the desktop's panes show.
        U::AgentSetup { .. }
        | U::Retrying { .. }
        | U::ContextUsed { .. }
        | U::BackgroundTasks { .. }
        | U::TaskStarted { .. }
        | U::TaskEnded { .. }
        | U::Commands { .. }
        | U::AgentModel { .. }
        | U::AgentStarted { .. }
        | U::AgentProgress { .. }
        | U::AdvisorStarted { .. }
        | U::AdvisorDone { .. }
        | U::Offstream { .. }
        | U::ModelUsage { .. }
        | U::McpTools { .. }
        | U::Models { .. }
        | U::PermissionAutoAllowed { .. }
        | U::ShellOutput { .. }
        | U::ShellDone { .. }
        | U::ShellSecret { .. }
        | U::AgentSpawned { .. }
        | U::AgentWake { .. }
        | U::AgentMessage { .. }
        | U::AgentStopped { .. }
        | U::AgentTidied
        | U::ReviewUpdate { .. }
        | U::AgentMode { .. }
        | U::MergeResolved { .. }
        | U::ReviewTarget { .. }
        | U::PlanUsage { .. }
        | U::Unknown { .. }
        | U::ParseError { .. } => return None,
    })
}

/// The longest text a prompt's input carries to the phone, per field: a Write's whole file would be megabytes.
pub const INPUT_TEXT_MAX: usize = 4000;
/// What ends a text cut to INPUT_TEXT_MAX.
pub const CUT: &str = "\n… (cut short: the rest is on your Mac)";

/// A prompt's input as the phone is shown it: every long text cut short. (Answering never sends this back: a question's
/// answers are checked against the input Claude sent, see answers.rs.)
pub fn trimmed(input: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match input {
        Value::String(s) if s.len() > INPUT_TEXT_MAX => {
            let mut end = INPUT_TEXT_MAX;
            while !s.is_char_boundary(end) {
                end -= 1;
            }
            Value::String(format!("{}{CUT}", &s[..end]))
        }
        Value::Array(items) => Value::Array(items.iter().map(trimmed).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), trimmed(v))).collect()),
        other => other.clone(),
    }
}

/// Where a chat stands, as the phone lists it (the hub's ChatStatus).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub enum ChatStatus {
    NeedsYou,
    Working,
    Idle,
    Asleep,
    Ended,
}

impl From<super::hub::ChatStatus> for ChatStatus {
    fn from(s: super::hub::ChatStatus) -> Self {
        use super::hub::ChatStatus as H;
        match s {
            H::NeedsYou => Self::NeedsYou,
            H::Working => Self::Working,
            H::Idle => Self::Idle,
            H::Asleep => Self::Asleep,
            H::Ended => Self::Ended,
        }
    }
}

/// Earlier turns of a chat (the answer to Request::Earlier): `hidden` is how many still come before them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct EarlierPage {
    pub events: Vec<RemoteEvent>,
    pub hidden: u32,
}

/// One chat in the phone's list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct RemoteChat {
    pub slot: String,
    pub title: Option<String>,
    /// The project's folder name (not its whole path).
    pub project: Option<String>,
    pub status: ChatStatus,
    #[ts(type = "number")]
    pub last_seq: u64,
    #[ts(type = "number")]
    pub active_at: u64,
    /// Ask or Auto, as the Mac's window says it is (None until it has said).
    #[serde(default)]
    pub permissions: Option<RemotePermissions>,
    /// The id of the preset (which models do what) the chat runs on, one of Controls' presets (None until the window has said).
    #[serde(default)]
    pub preset: Option<String>,
    /// The colour the Mac's window gives the chat's project, "#rrggbb": the phone shows the same (None from a Mac that doesn't say).
    #[serde(default)]
    pub project_color: Option<String>,
}

/// Ask or Auto: what a chat does about asking before it acts. A phone may ask for Auto only when the Mac's setting allows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub enum RemotePermissions {
    Ask,
    Auto,
}

impl RemotePermissions {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "ask" => Some(Self::Ask),
            "auto" => Some(Self::Auto),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Auto => "auto",
        }
    }
}

/// A preset of the Mac's Settings › Models, as a phone lists it: which model does what, in a chat.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct RemotePreset {
    /// What a phone sends back to choose it. The Mac only takes one it listed.
    pub id: String,
    pub name: String,
    /// One line about what it does: "Sonnet · Opus advisor · Haiku subagents".
    pub summary: String,
}

/// What a phone may choose for a chat (the answer to Request::Controls).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct Controls {
    /// The Mac lets phones use Auto (Settings › Remote control). Off: Ask is the only choice, and the Mac refuses Auto.
    pub allow_auto: bool,
    pub presets: Vec<RemotePreset>,
}

impl From<super::hub::ChatInfo> for RemoteChat {
    fn from(c: super::hub::ChatInfo) -> Self {
        let project = c.folder.as_deref().and_then(|f| std::path::Path::new(f).file_name()).map(|n| n.to_string_lossy().into_owned());
        Self { slot: c.slot, title: c.title, project, status: c.status.into(), last_seq: c.last_seq, active_at: c.active_at, permissions: c.permissions.as_deref().and_then(RemotePermissions::parse), preset: c.preset, project_color: c.color }
    }
}

/// A project a phone may start a chat in: one the user already works in on this Mac (a chat open there, or a recent one).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct RemoteProject {
    /// What the phone sends back to start a chat there: the project's folder. The Mac decides whether it is one.
    pub id: String,
    /// The folder's name, for showing.
    pub name: String,
}

/// What a suggestion would do if the user chose it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub enum SuggestionTarget {
    /// Send `message` to an open chat.
    Continue { slot: String },
    /// Start a chat in a project (a Projects id) with `message`.
    NewChat { project: String, project_name: String },
}

/// One thing Claude suggests doing next. It only ever fills in a draft the user can change: nothing is sent by itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct Suggestion {
    pub id: String,
    pub title: String,
    /// One short sentence: why this.
    pub why: String,
    /// The draft message, in the user's voice.
    pub message: String,
    pub target: SuggestionTarget,
}

/// The answer to Request::Suggest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct Suggestions {
    pub items: Vec<Suggestion>,
    /// When they were made (ms since the epoch).
    #[ts(type = "number")]
    pub generated_at: u64,
}

/// The chat a phone started, once it is open on the Mac.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct StartedChat {
    pub slot: String,
}

/// A prompt waiting on the user, in any chat (the home screen's stack, oldest first).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct Waiting {
    pub slot: String,
    pub chat_title: Option<String>,
    pub request_id: String,
    pub tool_name: String,
    #[ts(type = "unknown")]
    pub input: serde_json::Value,
    #[ts(type = "number")]
    pub at: u64,
}

/// What a phone may ask. Nothing else is accepted: no commands, no files, no settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "op", rename_all = "snake_case")]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub enum Request {
    ListChats,
    ListWaiting,
    /// Events of the chat after number `after` from now on (0: from what is kept).
    /// `epoch`: the one Welcome gave when the phone got event `after`. Numbers start again each time Lantern starts, so
    /// from another epoch (or a number Lantern hasn't reached) the phone gets a Reset instead.
    Subscribe {
        slot: String,
        #[ts(type = "number")]
        after: u64,
        #[ts(type = "number")]
        epoch: u64,
    },
    /// The turns before the `hidden` ones a Reset left out (counted from the first), a page at a time.
    Earlier { slot: String, hidden: u32 },
    Unsubscribe { slot: String },
    /// `client_id`: the phone's own id for the message, so it can match the hub's copy to the one it shows.
    Send { slot: String, text: String, client_id: String },
    Interrupt { slot: String },
    /// `answers`: a question's answers (AskUserQuestion), by question. A phone never sends a tool's input: Lantern adds
    /// the answers to the input Claude sent (see answers.rs).
    Answer {
        slot: String,
        request_id: String,
        allow: bool,
        message: Option<String>,
        answers: Option<std::collections::BTreeMap<String, String>>,
    },
    Wake { slot: String },
    /// Closes a chat on the Mac, as closing it in the window's sidebar does (its conversation stays in History). Refused while
    /// the chat is working or waiting on someone (stop it first), and for a team's Lead or agent (the window decides that).
    /// Only sent to a Mac whose Welcome lists "close" in `features`: an older Mac ends the connection at a request it doesn't know.
    Close { slot: String },
    /// The projects a chat may be started in from the phone.
    Projects,
    /// Starts a chat in `project` (one of Projects' ids) with `text` as its first message, without switching what the Mac's
    /// window shows. It starts on Ask unless `permissions` says Auto and the Mac lets phones use Auto, whatever the project's
    /// Permissions were; `preset` (one of Controls' ids) is the models it runs on, else the project's own.
    NewChat {
        project: String,
        text: String,
        #[serde(default)]
        permissions: Option<RemotePermissions>,
        #[serde(default)]
        preset: Option<String>,
    },
    /// What a phone may choose: whether Auto is allowed, and the presets. Only sent to a Mac that said it has them
    /// (Welcome's `features`): an older Mac ends the connection at a request it doesn't know.
    Controls,
    /// Puts a chat on Ask or Auto (its claude restarts on the same session). Refused for Auto unless the Mac lets phones use
    /// it, and while the chat is working or waiting on someone: the restart would drop what it is doing.
    SetPermissions { slot: String, permissions: RemotePermissions },
    /// Puts a chat on one of Controls' presets (its claude restarts on the same session), under the same conditions.
    SetPreset { slot: String, preset: String },
    /// What Claude would do next, from the recent chats: up to three drafts. Made by a short call to a small model, so
    /// they are kept for a while and shared by every phone; `refresh` asks again (not within a minute of the last time).
    Suggest { refresh: bool },
    /// One file's diff from the chat's start, as unified-diff text.
    Diff { slot: String, path: String },
    /// The token Expo's push service delivers this phone's notifications with.
    PushToken { token: String },
}

/// A phone's message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub enum ClientMessage {
    /// `device_name`: the name the phone goes by on the Mac's device list (its first pairing sets it).
    Hello { protocol: u32, app_version: String, device_name: String },
    Request {
        #[ts(type = "number")]
        id: u64,
        request: Request,
    },
}

/// Lantern's message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub enum ServerMessage {
    /// The answer to Hello. `protocol` differs from the phone's: it stops and says which side to update.
    /// `epoch`: this run of Lantern's (see Request::Subscribe).
    Welcome {
        protocol: u32,
        app_version: String,
        mac_name: String,
        #[ts(type = "number")]
        epoch: u64,
        /// The addresses the Mac can be reached at now, local ones first then Tailscale's: the phone keeps them in place
        /// of what the QR code said, so a Mac whose address changed (or that joined Tailscale) is still found.
        #[serde(default)]
        hosts: Vec<String>,
        /// What this Mac can do beyond protocol 1, by name ("controls": Request::Controls and what goes with it). A Mac that
        /// is older says nothing, and a phone doesn't ask it for what it hasn't got.
        #[serde(default)]
        features: Vec<String>,
    },
    /// The answer to request `id`: `ok` with its result, or `error` with why (for the user).
    Response {
        #[ts(type = "number")]
        id: u64,
        #[ts(type = "unknown")]
        ok: Option<serde_json::Value>,
        error: Option<String>,
    },
    Event {
        slot: String,
        #[ts(type = "number")]
        seq: u64,
        event: RemoteEvent,
    },
    /// The chat `slot` from its start (the transcript, then what is kept), to show in place of what the phone had: when it
    /// first subscribes, or was too far behind. It comes in pages: page 0 starts over, later pages add to it, and `done`
    /// is the last. Live events follow from `seq`.
    /// `hidden`: how many earlier turns it leaves out (the last ones come first; Request::Earlier brings the rest).
    Reset {
        slot: String,
        #[ts(type = "number")]
        seq: u64,
        page: u32,
        done: bool,
        hidden: u32,
        events: Vec<RemoteEvent>,
    },
    /// The chat list changed (a chat opened, closed, or moved on).
    Chats { chats: Vec<RemoteChat> },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui_event::Hunk;

    #[test]
    fn what_an_older_phone_or_mac_says_still_reads() {
        // An older phone starts a chat with no say in the mode or preset: it is Ask, the project's own models.
        let old: Request = serde_json::from_str(r#"{"op":"new_chat","project":"/p","text":"hi"}"#).unwrap();
        assert_eq!(old, Request::NewChat { project: "/p".into(), text: "hi".into(), permissions: None, preset: None });
        // An older Mac's chat list and Welcome have neither field.
        let chat: RemoteChat = serde_json::from_str(r#"{"slot":"a","title":null,"project":null,"status":"idle","last_seq":1,"active_at":2}"#).unwrap();
        assert_eq!((chat.permissions, chat.preset, chat.project_color), (None, None, None));
        let welcome: ServerMessage = serde_json::from_str(r#"{"type":"welcome","protocol":1,"app_version":"0.1.53","mac_name":"M","epoch":3}"#).unwrap();
        assert!(matches!(welcome, ServerMessage::Welcome { features, .. } if features.is_empty()));
    }

    #[test]
    fn a_chat_says_its_mode_and_preset_and_only_the_two_modes_are_taken() {
        let info = |p: Option<&str>| crate::remote::hub::ChatInfo { slot: "a".into(), title: None, folder: None, session_id: None, status: crate::remote::hub::ChatStatus::Idle, last_seq: 0, active_at: 0, permissions: p.map(String::from), preset: Some("max".into()), color: None };
        let auto = RemoteChat::from(info(Some("auto")));
        assert_eq!((auto.permissions, auto.preset.as_deref()), (Some(RemotePermissions::Auto), Some("max")));
        assert_eq!(RemoteChat::from(info(Some("ask"))).permissions, Some(RemotePermissions::Ask));
        assert_eq!(RemoteChat::from(info(Some("bypass"))).permissions, None);
        assert!(serde_json::from_str::<Request>(r#"{"op":"set_permissions","slot":"a","permissions":"bypass"}"#).is_err());
    }

    #[test]
    fn export_bindings_are_where_the_phone_reads_them() {
        assert!(BINDINGS.ends_with("mobile/src/protocol/generated/"));
    }

    #[test]
    fn the_phone_sees_the_main_thread_and_not_a_subagents_insides() {
        let main = UiEvent::TextDelta { parent: None, block_id: "b".into(), text: "hi".into() };
        assert_eq!(to_remote(&main), Some(RemoteEvent::TextDelta { block_id: "b".into(), text: "hi".into() }));
        let sub = UiEvent::TextDelta { parent: Some("t".into()), block_id: "b".into(), text: "hi".into() };
        assert_eq!(to_remote(&sub), None);
        assert_eq!(to_remote(&UiEvent::Thinking { parent: Some("t".into()) }), None);
    }

    #[test]
    fn an_edit_is_sent_as_counts_and_a_steps_output_not_at_all() {
        let edit = UiEvent::EditApplied {
            parent: None,
            tool_use_id: "t1".into(),
            path: "/p/a.rs".into(),
            created: false,
            hunks: vec![Hunk { old_start: 1, old_lines: 2, new_start: 1, new_lines: 3, lines: vec![" a".into(), "-b".into(), "+c".into(), "+d".into()] }],
            original: Some("secret".into()),
        };
        assert_eq!(to_remote(&edit), Some(RemoteEvent::FileEdited { tool_use_id: "t1".into(), path: "/p/a.rs".into(), created: false, added: 2, removed: 1 }));
        let done = UiEvent::ToolFinished { parent: None, tool_use_id: "t1".into(), is_error: false, output: "a lot of output".into() };
        assert!(!serde_json::to_string(&to_remote(&done).unwrap()).unwrap().contains("output"));
    }

    #[test]
    fn what_only_the_desktop_can_answer_is_said_so_and_lanterns_bookkeeping_stays_home() {
        let merge = UiEvent::MergeProposed { worker: "w".into(), name: "Builder".into(), branch: "b".into(), into: "main".into(), summary: "s".into(), commits: 1, files: vec![], uncommitted: 0, loose: vec![] };
        assert_eq!(to_remote(&merge), Some(RemoteEvent::NeedsDesktop { what: "Builder wants to merge its branch.".into() }));
        assert_eq!(to_remote(&UiEvent::ContextUsed { tokens: 5 }), None);
        assert_eq!(to_remote(&UiEvent::ShellOutput { id: "s".into(), text: "secret".into() }), None);
        assert_eq!(to_remote(&UiEvent::Unknown { raw: serde_json::json!({}) }), None);
    }

    #[test]
    fn a_big_prompt_reaches_the_phone_cut_short_and_a_small_one_whole() {
        let content = "é".repeat(30_000);
        let ev = UiEvent::PermissionRequested { request_id: "p".into(), tool_name: "Write".into(), input: serde_json::json!({"file_path": "/p/a.txt", "content": content, "list": ["x"]}) };
        let Some(RemoteEvent::PermissionRequested { input, .. }) = to_remote(&ev) else { panic!() };
        let shown = input["content"].as_str().unwrap();
        assert!(shown.len() <= INPUT_TEXT_MAX + CUT.len() && shown.ends_with(CUT));
        assert_eq!((input["file_path"].as_str(), &input["list"]), (Some("/p/a.txt"), &serde_json::json!(["x"])));
    }

    #[test]
    fn a_message_reaches_the_phone_without_lanterns_notes() {
        let sent = UiEvent::UserText { text: "[Lantern: this chat switched to Debug. The user picked it.]\n\nit crashes".into(), at: Some(3), sent_by: Some("desktop".into()) };
        assert_eq!(to_remote(&sent), Some(RemoteEvent::UserText { text: "it crashes".into(), at: Some(3), sent_by: Some("desktop".into()) }));
    }

    #[test]
    fn messages_read_as_the_generated_typescript_expects() {
        let req: ClientMessage = serde_json::from_str(r#"{"type":"request","id":7,"request":{"op":"subscribe","slot":"a","after":12,"epoch":5}}"#).unwrap();
        assert_eq!(req, ClientMessage::Request { id: 7, request: Request::Subscribe { slot: "a".into(), after: 12, epoch: 5 } });
        let ev = ServerMessage::Event { slot: "a".into(), seq: 3, event: RemoteEvent::Thinking };
        assert_eq!(serde_json::to_value(&ev).unwrap(), serde_json::json!({"type": "event", "slot": "a", "seq": 3, "event": {"kind": "thinking"}}));
        // Anything else a phone sends is refused as it's read.
        assert!(serde_json::from_str::<ClientMessage>(r#"{"type":"request","id":1,"request":{"op":"run_shell","command":"rm -rf /"}}"#).is_err());
    }

    #[test]
    fn a_chat_is_listed_by_its_projects_name_not_its_path() {
        let info = crate::remote::hub::ChatInfo { slot: "a".into(), title: Some("t".into()), folder: Some("/Users/me/dev/lantern".into()), session_id: Some("s".into()), status: crate::remote::hub::ChatStatus::NeedsYou, last_seq: 4, active_at: 9, permissions: Some("auto".into()), preset: Some("balanced".into()), color: Some("#5b5bd6".into()) };
        let chat = RemoteChat::from(info);
        assert_eq!((chat.project.as_deref(), chat.status), (Some("lantern"), ChatStatus::NeedsYou));
    }
}
