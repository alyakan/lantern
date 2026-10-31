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
pub const FEATURES: &[&str] = &["controls", "close", "workflow", "output", "shell", "images", "pair", "liveactivity", "storage", "pushkey", "reviewdiff", "todos", "artifacts", "rename", "livesummary", PHONE_DESK, DESK_TALK];

/// A picture a phone attaches to a message, as it travels: the phone has already made it small (a JPEG at most 1568 px
/// on its long side), and `data` is its bytes in base64 (standard alphabet, no line breaks).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct RemoteImage {
    /// "image/jpeg", "image/png", "image/webp" or "image/gif".
    pub media_type: String,
    pub data: String,
}

/// How many pictures one message may carry.
pub const IMAGES_MAX: usize = 4;
/// The largest one picture may be, and all of a message's together, in bytes once decoded. Claude takes 5 MB a picture; the
/// total keeps a message inside what the channel carries (secure::MAX_MESSAGE) with its base64 and JSON around it.
pub const IMAGE_BYTES_MAX: usize = 3 << 20;
pub const IMAGES_TOTAL_MAX: usize = 5 << 20;

/// What the first bytes of each kind of picture say it is (WebP is "RIFF", four bytes of size, then "WEBP").
fn kind_of(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("image/png")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Whether a phone's pictures are fit to hand to Claude: few, not huge, real base64, and each what it says it is (the bytes
/// are looked at, not the phone's word). Claude is given exactly what was sent, so nothing else about a picture is trusted
/// or kept: nothing is written to disk.
pub fn check_images(images: &[RemoteImage]) -> Result<(), String> {
    use base64::Engine;
    if images.len() > IMAGES_MAX {
        return Err(format!("A message can carry {IMAGES_MAX} pictures at most."));
    }
    let mut total = 0usize;
    for image in images {
        // Looked at before it is decoded: a huge string is refused without the work of reading it.
        if image.data.len() > IMAGE_BYTES_MAX / 3 * 4 + 4 {
            return Err("A picture is too big to send. It is shrunk before it goes: try another.".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD.decode(&image.data).map_err(|_| "A picture didn't arrive whole.".to_string())?;
        if bytes.is_empty() || bytes.len() > IMAGE_BYTES_MAX {
            return Err("A picture is empty or too big to send.".into());
        }
        total += bytes.len();
        if total > IMAGES_TOTAL_MAX {
            return Err("Those pictures are too big together. Send fewer of them.".into());
        }
        match kind_of(&bytes) {
            Some(kind) if kind == image.media_type => {}
            Some(_) | None => return Err("A picture isn't the kind of file it says it is: only JPEG, PNG, WebP and GIF are sent.".into()),
        }
    }
    Ok(())
}

/// What the id of a command started from a phone begins with: the window's own commands are "sh…" and "run-…", so the two
/// never meet, and only these commands' output is ever sent to a phone (a command typed on the Mac may print anything).
pub const PHONE_SHELL_PREFIX: &str = "ph-";

/// Whether `id` is a well-formed id for a command started from a phone: the prefix and 4 to 28 letters or digits (the
/// longest id a command may have is 32 characters, see shell::valid_id).
pub fn phone_shell_id(id: &str) -> bool {
    id.strip_prefix(PHONE_SHELL_PREFIX).is_some_and(|rest| (4..=28).contains(&rest.len()) && rest.chars().all(|c| c.is_ascii_alphanumeric()))
}

/// The longest command a phone may run, in bytes.
pub const SHELL_COMMAND_MAX: usize = 4096;
/// The longest reply a phone may type into a running command, in bytes.
pub const SHELL_INPUT_MAX: usize = 1024;

/// The longest output of a step a phone is sent, in characters (the parser already keeps only the start of a huge one).
pub const STEP_OUTPUT_MAX: usize = 20_000;

/// What a phone says it can read beyond protocol 1 (Hello's `features`): the Mac sends it only what its name allows, since a
/// phone that doesn't know an event can't show the chat. "extras": the commands, plan and context events, and the plan usage.
pub const PHONE_EXTRAS: &str = "extras";
/// A phone that shows the Desk: it is pushed ServerMessage::Desk.
pub const PHONE_DESK: &str = "desk";
/// A Mac whose Desk talks back (Request::DeskTalk) and sums up what came back (Request::DeskReply).
pub const DESK_TALK: &str = "desktalk";

/// A slash command or skill the chat's claude offers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct RemoteCommand {
    pub name: String,
    pub description: String,
    pub argument_hint: String,
}

/// One line of the plan Claude keeps. `status`: "pending", "in_progress" or "completed".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct RemoteTodo {
    pub content: String,
    pub status: String,
    pub active_form: String,
}

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
        /// How many pictures went with it, when any did: only the count is ever sent, never the pictures.
        #[serde(default)]
        #[ts(optional)]
        images: Option<u32>,
    },
    /// Claude is thinking (the main thread; a subagent's thinking isn't sent).
    Thinking,
    TextDelta { block_id: String, text: String },
    AssistantText { block_id: String, text: String },
    ToolStarted { tool_use_id: String, name: String, summary: String },
    /// The step ended; its output isn't sent with it (the phone shows steps as a line each): only a few kinds of step's output
    /// is sent, and only when asked for (Request::StepOutput).
    ToolFinished { tool_use_id: String, is_error: bool },
    /// A file the step changed, as counts: its diff is a request of its own.
    FileEdited { tool_use_id: String, path: String, created: bool, added: u32, removed: u32 },
    TestsRan { tool_use_id: String, command: String, passed: u32, failed: u32, skipped: u32 },
    TurnDone {
        is_error: bool,
        result: Option<String>,
        #[ts(type = "number | null")]
        duration_ms: Option<u64>,
        /// The model's context size in tokens, when this turn's result said (what "context used" is a share of).
        #[serde(default)]
        #[ts(type = "number | null")]
        context_window: Option<u64>,
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
    /// The user's post-hook (Settings > Hooks) was sent as a turn after Claude's answer, with what it asks: what Claude says and does
    /// after this, to the end of the turn, is the hook's, not the answer. A phone that doesn't know this event shows it all as before.
    HookTurn { text: String },
    SessionStarted { session_id: String },
    SessionEnded { code: Option<i32> },
    Asleep { asleep: bool },
    ConversationReset,
    /// What the chat's claude offers after a "/" (extras: sent only to a phone that can read it).
    Commands { commands: Vec<RemoteCommand> },
    /// The plan Claude keeps, whole each time it changes (extras).
    Todos { items: Vec<RemoteTodo> },
    /// How much of the model's context the chat holds, in tokens (extras). `window`: its size, when the Mac knows it (else the
    /// phone keeps the last it was told).
    Context {
        #[ts(type = "number")]
        tokens: u64,
        #[ts(type = "number | null")]
        window: Option<u64>,
    },
    /// What the chat still runs in the background (a dev server, a subagent), whole each time it changes: each one's description (extras).
    Background { tasks: Vec<String> },
    /// A command started from a phone (Request::Shell) is running. Only such commands are sent, never the Mac's own (extras).
    ShellStarted { id: String, command: String },
    /// What that command printed, stdout and stderr together, as it comes (extras).
    ShellOutput { id: String, text: String },
    /// The command turned echo off to read a secret (a password), or back on: the phone hides what is typed in reply (extras).
    ShellSecret { id: String, secret: bool },
    /// The command ended: its exit code (none when a signal ended it), and whether it was stopped (extras).
    ShellDone { id: String, code: Option<i32>, stopped: bool },
}

impl RemoteEvent {
    /// Whether only a phone that said "extras" can read it.
    pub fn is_extra(&self) -> bool {
        matches!(
            self,
            RemoteEvent::Commands { .. } | RemoteEvent::Todos { .. } | RemoteEvent::Context { .. } | RemoteEvent::Background { .. } | RemoteEvent::ShellStarted { .. } | RemoteEvent::ShellOutput { .. } | RemoteEvent::ShellSecret { .. } | RemoteEvent::ShellDone { .. }
        )
    }
}

/// `to_remote`, without what a phone that can't read extras would choke on.
pub fn to_remote_for(event: &UiEvent, extras: bool) -> Option<RemoteEvent> {
    to_remote(event).filter(|e| extras || !e.is_extra())
}

/// The most background tasks a phone is told of (each one's description cut short too).
pub const BACKGROUND_MAX: usize = 20;

/// The most slash commands a phone is sent, each with its text cut short: a long list of skills is still a short message.
pub const COMMANDS_MAX: usize = 300;

/// The phone's events for one of Lantern's, or none: subagents' insides, Lantern's bookkeeping and anything a phone
/// doesn't show stay on the Mac. Every event is named here, so a new one is a compile error until it is decided.
pub fn to_remote(event: &UiEvent) -> Option<RemoteEvent> {
    use RemoteEvent as R;
    use UiEvent as U;
    Some(match event {
        // A post-hook is Lantern's own message (see hooks.rs): the phone is not shown it as the user's, only told that what follows is the hook's.
        U::UserText { text, .. } if crate::hooks::post_text(text).is_some() => R::HookTurn { text: crate::hooks::post_text(text).unwrap_or_default().to_string() },
        U::UserText { text, at, sent_by, images } => R::UserText { text: super::hub::without_notes(text).to_string(), at: *at, sent_by: sent_by.clone(), images: (*images > 0).then_some(*images) },
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
        U::TurnDone { is_error, result, duration_ms, context_window, .. } => R::TurnDone { is_error: *is_error, result: result.clone(), duration_ms: *duration_ms, context_window: *context_window },
        U::PermissionRequested { request_id, tool_name, input } => R::PermissionRequested { request_id: request_id.clone(), tool_name: tool_name.clone(), input: trimmed(input) },
        U::PermissionWithdrawn { request_id } => R::PermissionWithdrawn { request_id: request_id.clone() },
        U::PermissionResolved { request_id, allow, by } => R::PermissionResolved { request_id: request_id.clone(), allow: *allow, by: by.clone() },
        U::MergeProposed { name, .. } => R::NeedsDesktop { what: format!("{name} wants to merge its branch.") },
        U::AgentSetup { phase, .. } if phase == "failed" => R::NeedsDesktop { what: "An agent's setup failed.".into() },
        U::SessionStarted { session_id, .. } => R::SessionStarted { session_id: session_id.clone() },
        U::SessionEnded { code, .. } => R::SessionEnded { code: *code },
        U::AgentAsleep { asleep } => R::Asleep { asleep: *asleep },
        U::ConversationReset => R::ConversationReset,
        U::Commands { commands } => {
            let cut = |s: &str, n: usize| s.chars().take(n).collect::<String>();
            R::Commands { commands: commands.iter().take(COMMANDS_MAX).map(|c| RemoteCommand { name: cut(&c.name, 80), description: cut(&c.description, 200), argument_hint: cut(&c.argument_hint, 80) }).collect() }
        }
        U::Todos { parent: None, items } => R::Todos { items: items.iter().map(|t| RemoteTodo { content: t.content.clone(), status: t.status.clone(), active_form: t.active_form.clone() }).collect() },
        U::ContextUsed { tokens } => R::Context { tokens: *tokens, window: None },
        U::BackgroundTasks { tasks } => R::Background { tasks: tasks.iter().take(BACKGROUND_MAX).map(|t| t.description.chars().take(200).collect()).collect() },
        // Only the commands a phone started: what a command typed on the Mac prints stays there.
        U::ShellStarted { id, command } if phone_shell_id(id) => R::ShellStarted { id: id.clone(), command: command.clone() },
        U::ShellOutput { id, text } if phone_shell_id(id) => R::ShellOutput { id: id.clone(), text: text.clone() },
        U::ShellSecret { id, secret } if phone_shell_id(id) => R::ShellSecret { id: id.clone(), secret: *secret },
        U::ShellDone { id, code, stopped } if phone_shell_id(id) => R::ShellDone { id: id.clone(), code: *code, stopped: *stopped },
        // A subagent's insides: the phone shows the step that started it, not what it does.
        U::Thinking { parent: Some(_) } | U::TextDelta { parent: Some(_), .. } | U::AssistantText { parent: Some(_), .. } | U::ToolStarted { parent: Some(_), .. } | U::ToolFinished { parent: Some(_), .. } | U::EditApplied { parent: Some(_), .. } | U::TestRun { parent: Some(_), .. } => return None,
        // Lantern's own bookkeeping, and what only the desktop's panes show.
        U::AgentSetup { .. }
        | U::Retrying { .. }
        | U::TaskStarted { .. }
        | U::TaskEnded { .. }
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
        | U::ShellStarted { .. }
        | U::ShellOutput { .. }
        | U::ShellDone { .. }
        | U::ShellSecret { .. }
        | U::AgentSpawned { .. }
        | U::AgentWake { .. }
        | U::AgentMessage { .. }
        | U::AgentStopped { .. }
        | U::AgentTidied
        | U::Compacted
        | U::ReviewUpdate { .. }
        | U::AgentMode { .. }
        | U::MergeResolved { .. }
        | U::ReviewTarget { .. }
        | U::Todos { parent: Some(_), .. }
        // The account's usage goes to the phone as a message of its own (ServerMessage::Plan), not as a chat's event.
        | U::PlanUsage { .. }
        | U::WeekUsage { .. }
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
    /// Chat, Step by step or Team, as the Mac's window says (None until it has, or from a Mac that doesn't).
    #[serde(default)]
    pub workflow: Option<RemoteWorkflow>,
    /// What the chat runs on when that isn't Claude Code ("Codex", an endpoint's name), as the Mac's window says. None for a Claude chat,
    /// and from a Mac that doesn't say.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub provider: Option<String>,
    /// One short line for the chat's row: the tool it is in while it works, else the last thing it said (None until it has done
    /// either, and from a Mac that doesn't say).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub preview: Option<String>,
}

/// How a chat goes about its work: a plain conversation, one page at a time in a flavour (Build, Review, Debug or Design), or a
/// Lead running a team of agents. A phone can put a chat on Chat or Step by step; a team is started on the Mac.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub enum RemoteWorkflow {
    Chat,
    Steps,
    Team,
}

impl RemoteWorkflow {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "chat" => Some(Self::Chat),
            "steps" => Some(Self::Steps),
            "team" => Some(Self::Team),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Steps => "steps",
            Self::Team => "team",
        }
    }
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

/// A place a chat can run besides Claude Code's own default, as a phone lists it: Claude Code, Codex when a phone can answer its
/// questions, or an endpoint the user set up. What a chat started here does is the Mac's; this is only what the phone shows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct RemoteProvider {
    /// What a phone sends back to choose it. The Mac only takes one it listed.
    pub id: String,
    pub name: String,
    /// It has an Auto mode. Without one a chat on it asks before it acts, whatever the phone asks for.
    pub auto: bool,
    /// The Mac's presets (which model does what, in Claude Code) apply to it. Without them the chat runs on the provider's own model.
    pub presets: bool,
}

/// What a phone may choose for a chat (the answer to Request::Controls).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct Controls {
    /// The Mac lets phones use Auto (Settings › Remote control). Off: Ask is the only choice, and the Mac refuses Auto.
    pub allow_auto: bool,
    pub presets: Vec<RemotePreset>,
    /// Where a chat may run, when the Mac has more than Claude Code to offer (empty: only Claude Code, as before). A Mac that
    /// doesn't say leaves it out, which reads as empty.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub providers: Option<Vec<RemoteProvider>>,
}

/// A pairing code made for a phone to show another device (the answer to Request::PairOffer). Secret until it is used or has
/// expired: it is never logged, and the phone shows it only behind Face ID.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct PairOffer {
    /// The link the QR code holds (lantern://pair?…), for pasting where a camera can't scan it.
    pub link: String,
    /// When it stops working, in milliseconds since 1970.
    #[ts(type = "number")]
    pub expires_at: u64,
    /// The QR code's squares, one string per row: "1" a dark square, "0" a light one. No margin around it.
    pub modules: Vec<String>,
}

/// One of a chat's folder's artifacts (`.lantern/artifacts/`), as the phone lists it: no path, only the name it asks for it by.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct RemoteArtifact {
    /// From the artifacts folder, with `/` between folders: `maps/auth.html`.
    pub name: String,
    /// "html", "svg", "markdown" or "mermaid".
    pub kind: String,
    /// Last changed, in milliseconds since 1970.
    #[ts(type = "number")]
    pub modified: u64,
    #[ts(type = "number")]
    pub size: u64,
}

/// One item of the Mac's storage a phone may clear, as it is shown: no path, only what the user needs to decide. The phone sends
/// the ids back to clear them, and the Mac clears only those it still finds safe (see storage/phone.rs).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct RemoteStorageItem {
    pub id: String,
    /// "worktree", "build_output", "cache" or "simulator".
    pub kind: String,
    pub name: String,
    #[ts(type = "number")]
    pub bytes: u64,
    /// It goes to the Trash, so it takes no space back until the Trash is emptied.
    pub to_trash: bool,
    /// What it is, and how it comes back if it is cleared.
    pub note: String,
}

/// How the last clear a phone started went.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct RemoteStorageReport {
    pub ok: u32,
    pub failed: u32,
    #[ts(type = "number")]
    pub freed: u64,
    /// When it finished, in milliseconds since 1970.
    #[ts(type = "number")]
    pub at: u64,
}

/// The Mac's disk, and what a phone may clear from it (the answer to Request::Storage).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct RemoteStorage {
    #[ts(type = "number | null")]
    pub free_bytes: Option<u64>,
    #[ts(type = "number | null")]
    pub total_bytes: Option<u64>,
    /// When the last scan finished (ms since 1970); None before the first.
    #[ts(type = "number | null")]
    pub scanned_at: Option<u64>,
    pub scanning: bool,
    /// Where a scan has got to, while one runs.
    pub progress: String,
    /// A clear is running (the Storage tab's or a phone's).
    pub deleting: bool,
    /// The biggest items that are safe to clear.
    pub items: Vec<RemoteStorageItem>,
    /// How many more safe items there are than are listed (the Storage tab on the Mac has them).
    pub more: u32,
    pub report: Option<RemoteStorageReport>,
}

impl From<crate::storage::phone::PhoneView> for RemoteStorage {
    fn from(v: crate::storage::phone::PhoneView) -> Self {
        Self {
            free_bytes: v.free_bytes,
            total_bytes: v.total_bytes,
            scanned_at: v.scanned_at,
            scanning: v.scanning,
            progress: v.progress,
            deleting: v.deleting,
            items: v
                .items
                .iter()
                .map(|i| RemoteStorageItem { id: i.id.clone(), kind: crate::storage::phone::kind_name(i.kind).to_string(), name: i.name.clone(), bytes: i.bytes, to_trash: crate::storage::phone::to_trash(i), note: i.note.clone() })
                .collect(),
            more: v.more as u32,
            report: v.report.map(|r| RemoteStorageReport { ok: r.ok as u32, failed: r.failed as u32, freed: r.freed, at: r.at }),
        }
    }
}

impl From<super::hub::ChatInfo> for RemoteChat {
    fn from(c: super::hub::ChatInfo) -> Self {
        let project = c.folder.as_deref().and_then(|f| std::path::Path::new(f).file_name()).map(|n| n.to_string_lossy().into_owned());
        Self { slot: c.slot, title: c.title, project, status: c.status.into(), last_seq: c.last_seq, active_at: c.active_at, permissions: c.permissions.as_deref().and_then(RemotePermissions::parse), preset: c.preset, project_color: c.color, workflow: c.workflow.as_deref().and_then(RemoteWorkflow::parse), provider: c.provider, preview: c.preview }
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

/// The Desk as the Mac's window has it (see remote/desk.rs): its Desks, and a card for each answer that finished in their chats.
/// What each chat is doing now is the chat list's (`RemoteChat`), and what waits on the user is ListWaiting's.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct RemoteDesk {
    /// The first is home: it has every project no other Desk has.
    pub desks: Vec<RemoteDeskInfo>,
    /// Oldest first, the newest only.
    pub cards: Vec<RemoteDeskCard>,
}

/// One Desk: a named set of projects, with their open chats.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct RemoteDeskInfo {
    pub id: String,
    pub name: String,
    /// The open chats on it.
    pub slots: Vec<String>,
    /// The projects a message on it may start a chat in (`id` is the folder, as Projects gives it).
    pub projects: Vec<RemoteProject>,
}

/// An answer that finished, in one of a Desk's chats.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct RemoteDeskCard {
    pub key: String,
    pub desk: String,
    pub slot: String,
    pub title: String,
    /// The project (and the team, for a team's Lead).
    pub project: String,
    /// When what started it was sent (ms), when known.
    #[ts(type = "number | null")]
    pub at: Option<u64>,
    /// What was said to start it, on one line; `auto`: by Claude going on by itself, not by the user.
    pub asked: String,
    pub auto: bool,
    /// The start of Claude's last words in it.
    pub said: String,
    /// "done", "failed" or "stopped".
    pub outcome: String,
}

/// Where a message typed on a phone's Desk goes (the answer to Request::DeskRoute). The phone sends it there itself, as it would
/// from the chat or the New chat sheet: the Mac only decides.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub enum RemoteDeskRoute {
    /// One of the Desk's open chats.
    Chat { slot: String },
    /// A new chat in one of the Desk's projects (a Projects id), in Chat or Step by step.
    Start { project: String, workflow: RemoteWorkflow },
    /// The user picks: the likeliest of the Desk's chats (`unsure`: the router couldn't tell or couldn't be asked, so a new chat is
    /// offered too).
    Ask { slots: Vec<String>, unsure: bool },
    /// The message asked which chat has something: past chats of the Desk's projects that say it, newest first (`failed`: the
    /// search couldn't be done).
    Search { terms: String, hits: Vec<RemoteDeskHit>, failed: bool },
    /// The message asked how something stands: the Desk's own answer (Markdown, with [1], [2] for its `sources`, in order), made
    /// from the Desk's chats about `terms`. No sources: no chat talks about it. `error`: why there is no answer.
    Answer { terms: String, text: String, sources: Vec<RemoteDeskHit>, error: Option<String> },
}

/// An earlier exchange on a phone's Desk, as the phone tells it: what the user said, and what came of it in a few words.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct RemoteDeskExchange {
    pub you: String,
    pub desk: String,
}

/// What the Desk says back to a message typed on a phone's Desk (the answer to Request::DeskTalk), and what it does with it, as
/// RemoteDeskRoute (None: it only replied). `say` is plain text, only ever shown to the user.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct RemoteDeskTalk {
    pub say: String,
    pub route: Option<RemoteDeskRoute>,
}

/// What came back from the chat a phone's Desk message went to (the answer to Request::DeskReply). `done` false: its turn hasn't
/// finished yet. `off`: the chat runs on another provider than Claude, so nothing said there is summed up. `summary`: a sentence
/// or two (None with `error` when it couldn't be made); `full`: Claude's last words in the turn, for "Show full answer".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct RemoteDeskReply {
    pub done: bool,
    pub failed: bool,
    pub off: bool,
    pub summary: Option<String>,
    pub full: String,
    pub error: Option<String>,
}

/// A past chat a Desk's search found.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct RemoteDeskHit {
    pub title: String,
    pub project: String,
    #[ts(type = "number")]
    pub updated_ms: u64,
    /// Where it says it, a line.
    pub snippet: String,
    /// The open chat it is, when it is open (a phone opens only those).
    pub slot: Option<String>,
}

/// What a phone may ask. Nothing else is accepted: no commands, no files (not what Claude read from them either), no settings.
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
    /// `images`: pictures to go with it (the text may then be empty). Only sent to a Mac whose Welcome lists "images" in
    /// `features`: an older Mac would send the words without them and say nothing.
    Send {
        slot: String,
        text: String,
        client_id: String,
        #[serde(default)]
        #[ts(optional)]
        images: Option<Vec<RemoteImage>>,
    },
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
    /// Names a chat, as the History menu's Rename does on the Mac (the name beats every other title, and the window's chat takes it
    /// too). Refused for a chat that has no conversation yet, and for a name with nothing in it.
    /// Only sent to a Mac whose Welcome lists "rename" in `features`: an older Mac ends the connection at a request it doesn't know.
    Rename { slot: String, title: String },
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
        /// Step by step, or else a plain Chat. A team is started on the Mac.
        #[serde(default)]
        workflow: Option<RemoteWorkflow>,
        /// One of Controls' `providers` ids: where it runs, else the project's own. Never sent unless Controls listed it (and left out,
        /// not null, when nothing was chosen, so a Mac that doesn't know the field is never sent it).
        #[serde(default)]
        #[ts(optional)]
        provider: Option<String>,
    },
    /// What a phone may choose: whether Auto is allowed, and the presets. Only sent to a Mac that said it has them
    /// (Welcome's `features`): an older Mac ends the connection at a request it doesn't know.
    Controls,
    /// Puts a chat on Ask or Auto (its claude restarts on the same session). Refused for Auto unless the Mac lets phones use
    /// it, and while the chat is working or waiting on someone: the restart would drop what it is doing.
    SetPermissions { slot: String, permissions: RemotePermissions },
    /// Puts a chat on one of Controls' presets (its claude restarts on the same session), under the same conditions.
    SetPreset { slot: String, preset: String },
    /// Puts a chat on Chat or Step by step (its claude restarts on the same session), under the same conditions. Not a team's
    /// Lead, and not onto Team: a team is started and left on the Mac. Only sent to a Mac whose Welcome lists "workflow".
    SetWorkflow { slot: String, workflow: RemoteWorkflow },
    /// What Claude would do next, from the recent chats: up to three drafts. Made by a short call to a small model, so
    /// they are kept for a while and shared by every phone; `refresh` asks again (not within a minute of the last time).
    Suggest { refresh: bool },
    /// One file's diff from the chat's start, as unified-diff text.
    Diff { slot: String, path: String },
    /// A reviewed file's diff, as unified-diff text: in the pull request or branch the chat is reviewing (its last review_target
    /// call), or, when it isn't reviewing anything, the chat's own change to it (as Diff). `path` is as the review's page names
    /// it, relative to the repository or absolute in it. Only sent to a Mac whose Welcome lists "reviewdiff".
    ReviewDiff { slot: String, path: String },
    /// The artifacts in the chat's folder (`.lantern/artifacts/`), newest first, as a list of RemoteArtifact. Only sent to a Mac
    /// whose Welcome lists "artifacts" in `features`: an older Mac ends the connection at a request it doesn't know.
    Artifacts { slot: String },
    /// One artifact's text, by the `name` Artifacts listed: Markdown and Mermaid as written; HTML and SVG with what makes a page
    /// reach a server on its own taken out (artifacts.rs `defuse`), for the phone to draw with scripts off. At most 1 MB.
    ArtifactRead { slot: String, name: String },
    /// What a finished step of the chat printed (a command's output, a skill's, a helper's report, an MCP tool's), as text,
    /// cut to STEP_OUTPUT_MAX. Never what Claude read from a file or the web (hub.rs `output_may_be_read`). Only what the Mac
    /// still keeps of the chat: an older step may be gone, which is an error. Only sent to a Mac whose Welcome lists "output".
    StepOutput { slot: String, tool_use_id: String },
    /// Runs `command` (what was typed after "!") in the chat's folder, as the window's own "!" mode does: in a terminal of its
    /// own, outside claude. `id` is the phone's id for it (see `phone_shell_id`); its output comes back as the chat's
    /// ShellStarted, ShellOutput, ShellSecret and ShellDone events. The phone asks the user first, with the exact command
    /// shown: each command is one deliberate swipe. Refused for a chat that is asleep. Only sent to a Mac whose Welcome lists
    /// "shell" in `features`: an older Mac ends the connection at a request it doesn't know.
    Shell { slot: String, id: String, command: String },
    /// Types `text` and Enter into the running command `id`: the reply to what it asked (a password, a code, y/n).
    ShellInput { slot: String, id: String, text: String },
    /// Stops the running command `id` and what it started.
    ShellStop { slot: String, id: String },
    /// A new one-time pairing code for another device (the QR code the Mac's own Show a pairing code makes), so a phone that is
    /// already paired can show it to a second device when the Mac is out of reach. Any code the Mac's window is showing stops
    /// working. Only sent to a Mac whose Welcome lists "pair" in `features`: an older Mac ends the connection at a request it
    /// doesn't know.
    PairOffer,
    /// The Mac's disk and the items of it that are safe to clear (see RemoteStorage). Only sent to a Mac whose Welcome lists
    /// "storage" in `features`: an older Mac ends the connection at a request it doesn't know.
    Storage,
    /// Starts a scan of the Mac's storage, in the background (the answer is at once; ask Storage to see how it goes).
    StorageScan,
    /// Clears the items with these ids (ones Storage listed) that are still safe to clear on the Mac now, in the background:
    /// the answer is how many were started and about how many bytes. The Mac decides what is safe, never the phone, and
    /// ignores any id that isn't (a Review or Blocked item, a project, the Trash). Refused for a scan older than an hour. The
    /// phone asks Face ID and a swipe first, with the list shown.
    StorageClear { ids: Vec<String> },
    /// The user's own to-do list for a project (a folder Projects lists, or the token a reminder's push named it by), as RemoteUserTodos.
    /// Not Claude's plan (RemoteEvent::Todos). Only sent to a Mac whose Welcome lists "todos" in `features`.
    Todos { project: String },
    /// One change to that list, by the user on the phone; the answer is the list after it.
    TodoEdit { project: String, edit: RemoteTodoEdit },
    /// The token Expo's push service delivers this phone's notifications with.
    PushToken { token: String },
    /// The key the phone made for the words of its notifications (32 bytes, standard base64): the Mac encrypts what a prompt
    /// asks with it, the phone's notification extension decrypts it, and Apple carries only what it can't read. Sent again each
    /// time the phone connects, since it replaces the one before. Only sent to a Mac whose Welcome lists "pushkey" in `features`.
    PushKey { key: String },
    /// What the phone shows on its lock screen: the card for the chat it last messaged (`card`, None when there is none now)
    /// and the token for starting one by push (`start_token`). The whole state each time: it replaces what was said before.
    /// Only sent to a Mac whose Welcome lists "liveactivity" in `features`.
    LiveActivity {
        #[serde(default)]
        #[ts(optional)]
        start_token: Option<String>,
        #[serde(default)]
        #[ts(optional)]
        card: Option<RemoteLiveCard>,
    },
    /// The Desk as the Mac's window has it, as RemoteDesk (also pushed as ServerMessage::Desk when it changes, to a phone that said
    /// "desk"). Only sent to a Mac whose Welcome lists "desk" in `features`.
    Desk,
    /// Where `text`, typed on the phone's Desk `desk`, goes (RemoteDeskRoute): one quick call to a small model on the Mac, shown the
    /// Desk's chats as data. Nothing is sent: the phone sends the user's words there itself. A "which chat had…" answer brings
    /// the title and a line of past chats of the Desk's projects, closed ones too (History's search, as on the Mac's Desk).
    DeskRoute { desk: String, text: String },
    /// The Desk talks (RemoteDeskTalk): what it says back to `text`, typed on the phone's Desk `desk`, given the last few
    /// `history` exchanges there, and what it does with it (as DeskRoute does). Only sent to a Mac whose Welcome lists "desktalk".
    DeskTalk { desk: String, text: String, history: Vec<RemoteDeskExchange> },
    /// What came back from chat `slot` of Desk `desk` to the Desk message `text` sent there after the chat's event `after`
    /// (RemoteDeskReply): the turn it started, once finished, summed up. Only sent to a Mac whose Welcome lists "desktalk".
    DeskReply {
        desk: String,
        slot: String,
        text: String,
        #[ts(type = "number")]
        after: u64,
    },
}

/// The user's own to-dos for one project, kept on the Mac (see todos.rs). `project` is the key a reminder names and the phone
/// sends back; `name` is the project's folder name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct RemoteUserTodos {
    pub project: String,
    pub name: String,
    pub items: Vec<RemoteUserTodo>,
}

/// One of the user's to-dos. `due_date` is "YYYY-MM-DD" and `due_time` "HH:MM", the Mac's local time; `overdue` is the Mac's
/// word for it now.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct RemoteUserTodo {
    pub id: String,
    pub title: String,
    pub note: Option<String>,
    pub done: bool,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub overdue: bool,
    /// Claude added it (open) or ticked it (done).
    pub by_claude: bool,
    #[ts(type = "number | null")]
    pub snoozed_until: Option<u64>,
}

/// What a phone may change on a to-do list. `until` is ms since 1970.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "op", rename_all = "snake_case")]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub enum RemoteTodoEdit {
    Add {
        title: String,
        #[serde(default)]
        due_date: Option<String>,
        #[serde(default)]
        due_time: Option<String>,
    },
    Done { id: String, done: bool },
    Snooze {
        id: String,
        #[ts(type = "number")]
        until: u64,
    },
    Delete { id: String },
}

/// A phone's card on its lock screen, which the Mac keeps right with pushes to Apple.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub struct RemoteLiveCard {
    /// The chat the card is for; empty for a summary card.
    pub slot: String,
    /// The card's own push token, as Apple gave it to the phone (hex).
    pub token: String,
    /// The project's name, as the card shows it.
    pub project: String,
    /// When the turn it shows began (ms since the epoch).
    #[ts(type = "number")]
    pub since: u64,
    /// The card is about every chat (what is working, what needs you, what finished), not one (a Mac that lists
    /// "livesummary"); `slot` and `project` mean nothing then.
    #[serde(default)]
    #[ts(optional)]
    pub summary: Option<bool>,
}

/// A phone's message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = "../../mobile/src/protocol/generated/")]
pub enum ClientMessage {
    /// `device_name`: the name the phone goes by on the Mac's device list (its first pairing sets it).
    /// `features`: what the phone can read beyond protocol 1 (see PHONE_EXTRAS); an older phone says nothing.
    Hello {
        protocol: u32,
        app_version: String,
        device_name: String,
        #[serde(default)]
        features: Vec<String>,
    },
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
    /// The subscription's five-hour window (and its weekly one, when known), for the whole account: `used` from 0 to 1, `resets_at` in unix seconds, and the
    /// CLI's status for it ("allowed", "allowed_warning", "rejected"). Sent when it first connects and when it changes, and
    /// only to a phone that said "extras".
    Plan {
        used: f64,
        #[ts(type = "number | null")]
        resets_at: Option<u64>,
        status: String,
        /// The weekly window, when the Mac knows it: how much of it (0 to 1) and when it resets. An older phone ignores both.
        #[serde(default)]
        #[ts(optional)]
        week_used: Option<f64>,
        #[serde(default)]
        #[ts(optional, type = "number | null")]
        week_resets_at: Option<u64>,
    },
    /// The Desk changed (see Request::Desk). Only sent to a phone that said "desk".
    Desk { desk: RemoteDesk },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui_event::Hunk;

    #[test]
    fn what_an_older_phone_or_mac_says_still_reads() {
        // An older phone starts a chat with no say in the mode or preset: it is Ask, the project's own models.
        let old: Request = serde_json::from_str(r#"{"op":"new_chat","project":"/p","text":"hi"}"#).unwrap();
        assert_eq!(old, Request::NewChat { project: "/p".into(), text: "hi".into(), permissions: None, preset: None, workflow: None, provider: None });
        // An older Mac's chat list and Welcome have neither field.
        let chat: RemoteChat = serde_json::from_str(r#"{"slot":"a","title":null,"project":null,"status":"idle","last_seq":1,"active_at":2}"#).unwrap();
        assert_eq!((chat.permissions, chat.preset, chat.project_color, chat.workflow, chat.provider), (None, None, None, None, None));
        // An older Mac's Controls has no providers: only Claude Code, as before.
        let controls: Controls = serde_json::from_str(r#"{"allow_auto":true,"presets":[]}"#).unwrap();
        assert!(controls.providers.unwrap_or_default().is_empty());
        let welcome: ServerMessage = serde_json::from_str(r#"{"type":"welcome","protocol":1,"app_version":"0.1.53","mac_name":"M","epoch":3}"#).unwrap();
        assert!(matches!(welcome, ServerMessage::Welcome { features, .. } if features.is_empty()));
    }

    fn picture(media_type: &str, bytes: &[u8]) -> RemoteImage {
        use base64::Engine;
        RemoteImage { media_type: media_type.into(), data: base64::engine::general_purpose::STANDARD.encode(bytes) }
    }
    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 16, b'J', b'F', b'I', b'F'];
    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0];
    const WEBP: &[u8] = b"RIFF\x10\0\0\0WEBPVP8 ";

    #[test]
    fn a_phones_pictures_are_taken_only_when_they_are_what_they_say() {
        assert!(check_images(&[]).is_ok());
        assert!(check_images(&[picture("image/jpeg", JPEG), picture("image/png", PNG), picture("image/webp", WEBP), picture("image/gif", b"GIF89a....")]).is_ok());
        // The bytes are looked at, not the phone's word: a script, or one kind of picture called another, is refused.
        assert!(check_images(&[picture("image/png", b"#!/bin/sh\nrm -rf ~")]).unwrap_err().contains("isn't the kind"));
        assert!(check_images(&[picture("image/png", JPEG)]).unwrap_err().contains("isn't the kind"));
        assert!(check_images(&[picture("image/svg+xml", b"<svg onload=x>")]).is_err());
        assert!(check_images(&[picture("image/jpeg", WEBP)]).is_err());
        assert!(check_images(&[picture("image/webp", b"RIFF\x10\0\0\0WAVEfmt ")]).is_err(), "a RIFF that isn't WebP");
        // Not base64, or not whole, or nothing.
        for data in ["not base64!!", "/9j/4AAQ\n", "", "A"] {
            assert!(check_images(&[RemoteImage { media_type: "image/jpeg".into(), data: data.into() }]).is_err(), "{data:?}");
        }
    }

    #[test]
    fn a_phones_pictures_are_few_and_small() {
        let jpeg = picture("image/jpeg", JPEG);
        assert!(check_images(&vec![jpeg.clone(); IMAGES_MAX]).is_ok());
        assert!(check_images(&vec![jpeg.clone(); IMAGES_MAX + 1]).unwrap_err().contains("at most"));
        let sized = |n: usize| {
            let mut bytes = JPEG.to_vec();
            bytes.resize(n, 0);
            picture("image/jpeg", &bytes)
        };
        assert!(check_images(&[sized(IMAGE_BYTES_MAX)]).is_ok());
        assert!(check_images(&[sized(IMAGE_BYTES_MAX + 1)]).is_err());
        // Each is fine, together they are not.
        assert!(check_images(&[sized(IMAGE_BYTES_MAX), sized(IMAGES_TOTAL_MAX - IMAGE_BYTES_MAX)]).is_ok());
        assert!(check_images(&[sized(IMAGE_BYTES_MAX), sized(IMAGES_TOTAL_MAX - IMAGE_BYTES_MAX + 1)]).unwrap_err().contains("together"));
        // A huge string is refused before it is decoded.
        assert!(check_images(&[RemoteImage { media_type: "image/jpeg".into(), data: "A".repeat(IMAGE_BYTES_MAX * 2) }]).unwrap_err().contains("too big"));
        // The most a message may hold fits the channel with room to spare.
        const { assert!(IMAGES_TOTAL_MAX / 3 * 4 + (64 << 10) < crate::remote::secure::MAX_MESSAGE) };
    }

    #[test]
    fn only_the_count_of_a_messages_pictures_reaches_a_phone_and_old_requests_still_read() {
        let sent = UiEvent::UserText { text: "look".into(), at: None, sent_by: Some("p".into()), images: 2 };
        assert!(matches!(to_remote(&sent), Some(RemoteEvent::UserText { images: Some(2), .. })));
        let json = serde_json::to_string(&to_remote(&sent).unwrap()).unwrap();
        assert!(!json.contains("base64") && !json.contains("data"), "{json}");
        assert!(matches!(to_remote(&UiEvent::UserText { text: "x".into(), at: None, sent_by: None, images: 0 }), Some(RemoteEvent::UserText { images: None, .. })));
        // A phone with no pictures says nothing of them.
        let old: Request = serde_json::from_str(r#"{"op":"send","slot":"a","text":"hi","client_id":"c1"}"#).unwrap();
        assert_eq!(old, Request::Send { slot: "a".into(), text: "hi".into(), client_id: "c1".into(), images: None });
        assert!(FEATURES.contains(&"images"));
    }

    #[test]
    fn the_lock_screen_card_request_reads_with_either_part_missing_and_the_feature_is_listed() {
        let bare: Request = serde_json::from_str(r#"{"op":"live_activity"}"#).unwrap();
        assert_eq!(bare, Request::LiveActivity { start_token: None, card: None });
        let card: Request = serde_json::from_str(r#"{"op":"live_activity","card":{"slot":"a","token":"ab","project":"p","since":5}}"#).unwrap();
        assert_eq!(card, Request::LiveActivity { start_token: None, card: Some(RemoteLiveCard { slot: "a".into(), token: "ab".into(), project: "p".into(), since: 5, summary: None }) });
        assert!(FEATURES.contains(&"liveactivity"));
    }

    #[test]
    fn a_push_key_is_a_request_only_a_mac_that_lists_pushkey_takes() {
        let key: Request = serde_json::from_str(r#"{"op":"push_key","key":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="}"#).unwrap();
        assert_eq!(key, Request::PushKey { key: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=".into() });
        assert!(FEATURES.contains(&"pushkey"));
    }

    #[test]
    fn a_chat_says_its_mode_and_preset_and_only_the_two_modes_are_taken() {
        let info = |p: Option<&str>| crate::remote::hub::ChatInfo { slot: "a".into(), title: None, folder: None, session_id: None, status: crate::remote::hub::ChatStatus::Idle, last_seq: 0, active_at: 0, permissions: p.map(String::from), preset: Some("max".into()), color: None, workflow: None, provider: None, preview: None };
        let auto = RemoteChat::from(info(Some("auto")));
        assert_eq!((auto.permissions, auto.preset.as_deref()), (Some(RemotePermissions::Auto), Some("max")));
        assert_eq!(RemoteChat::from(info(Some("ask"))).permissions, Some(RemotePermissions::Ask));
        assert_eq!(RemoteChat::from(info(Some("bypass"))).permissions, None);
        assert!(serde_json::from_str::<Request>(r#"{"op":"set_permissions","slot":"a","permissions":"bypass"}"#).is_err());
    }

    #[test]
    fn only_the_commands_a_phone_started_are_sent_to_a_phone_that_can_read_them() {
        let events = |id: &str| {
            [
                UiEvent::ShellStarted { id: id.into(), command: "ls".into() },
                UiEvent::ShellOutput { id: id.into(), text: "a\n".into() },
                UiEvent::ShellSecret { id: id.into(), secret: true },
                UiEvent::ShellDone { id: id.into(), code: Some(0), stopped: false },
            ]
        };
        let sent = |id: &str| events(id).iter().map(|e| to_remote_for(e, true)).collect::<Vec<_>>();
        assert_eq!(
            sent("ph-abcd1234"),
            vec![
                Some(RemoteEvent::ShellStarted { id: "ph-abcd1234".into(), command: "ls".into() }),
                Some(RemoteEvent::ShellOutput { id: "ph-abcd1234".into(), text: "a\n".into() }),
                Some(RemoteEvent::ShellSecret { id: "ph-abcd1234".into(), secret: true }),
                Some(RemoteEvent::ShellDone { id: "ph-abcd1234".into(), code: Some(0), stopped: false }),
            ]
        );
        // What a command typed on the Mac prints (it may be anything) stays there, whoever is looking.
        for id in ["sh1", "run-1", "ph-ab"] {
            assert!(sent(id).iter().all(Option::is_none), "{id}");
        }
        // A phone that can't read extras is sent none of it.
        assert!(events("ph-abcd1234").iter().all(|e| to_remote_for(e, false).is_none()));
        assert!(FEATURES.contains(&"shell"));
        // The phone shows its Desk only to a Mac that lists it: without it the Desk stays hidden on every phone.
        assert!(FEATURES.contains(&PHONE_DESK));
        // The Desk that talks: a phone only asks a Mac that lists it (its own tests mock the list, so it is checked here).
        assert!(FEATURES.contains(&DESK_TALK));
        assert!(phone_shell_id("ph-abcd1234") && phone_shell_id(&format!("ph-{}", "a".repeat(28))));
        assert!(!phone_shell_id(&format!("ph-{}", "a".repeat(29))) && !phone_shell_id("ph-abc") && !phone_shell_id("ph-ab-cd12") && !phone_shell_id(""));
    }

    #[test]
    fn the_commands_plan_and_usage_are_sent_to_a_phone_that_can_read_them_and_to_no_other() {
        let todos = UiEvent::Todos { parent: None, items: vec![crate::ui_event::Todo { content: "a".into(), status: "pending".into(), active_form: "doing a".into() }] };
        let sent = RemoteEvent::Todos { items: vec![RemoteTodo { content: "a".into(), status: "pending".into(), active_form: "doing a".into() }] };
        assert_eq!(to_remote_for(&todos, true), Some(sent));
        assert_eq!(to_remote_for(&todos, false), None);
        assert_eq!(to_remote_for(&UiEvent::Todos { parent: Some("t".into()), items: vec![] }, true), None, "a subagent's plan stays with it");
        let context = UiEvent::ContextUsed { tokens: 90_000 };
        assert_eq!(to_remote_for(&context, true), Some(RemoteEvent::Context { tokens: 90_000, window: None }));
        assert_eq!(to_remote_for(&context, false), None);
        // The account's usage is a message of its own, never a chat's event.
        assert_eq!(to_remote_for(&UiEvent::PlanUsage { used: 0.5, resets_at: Some(1), status: "allowed".into() }, true), None);
        // What was already sent is sent whatever the phone says.
        let said = UiEvent::AssistantText { parent: None, block_id: "b".into(), text: "hi".into() };
        assert!(to_remote_for(&said, false).is_some());
    }

    #[test]
    fn a_long_list_of_commands_is_cut_to_a_short_message() {
        let command = |i: usize| crate::ui_event::SlashCommand { name: format!("c{i}"), description: "d".repeat(500), argument_hint: String::new() };
        let Some(RemoteEvent::Commands { commands }) = to_remote(&UiEvent::Commands { commands: (0..COMMANDS_MAX + 50).map(command).collect() }) else { panic!("commands") };
        assert_eq!((commands.len(), commands[0].description.chars().count()), (COMMANDS_MAX, 200));
    }

    #[test]
    fn a_hello_with_no_features_still_reads() {
        let hello: ClientMessage = serde_json::from_str(r#"{"type":"hello","protocol":1,"app_version":"1","device_name":"P"}"#).unwrap();
        assert!(matches!(hello, ClientMessage::Hello { features, .. } if features.is_empty()));
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
        assert_eq!(to_remote_for(&UiEvent::ContextUsed { tokens: 5 }, false), None, "to a phone that can't read it");
        assert_eq!(to_remote(&UiEvent::ShellOutput { id: "s".into(), text: "secret".into() }), None);
        assert_eq!(to_remote(&UiEvent::Unknown { raw: serde_json::json!({}) }), None);
    }

    #[test]
    fn a_post_hook_is_told_to_the_phone_as_the_hooks_turn_not_as_the_users_message() {
        let hook = UiEvent::UserText { text: crate::hooks::post_message("Update the brain if needed"), at: Some(1), sent_by: Some("lantern".into()), images: 0 };
        assert_eq!(to_remote(&hook), Some(RemoteEvent::HookTurn { text: "Update the brain if needed".into() }));
        // A phone that can't read extras is still told: it only marks what follows.
        assert_eq!(to_remote_for(&hook, false), Some(RemoteEvent::HookTurn { text: "Update the brain if needed".into() }));
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
        let sent = UiEvent::UserText { text: "[Lantern: this chat switched to Debug. The user picked it.]\n\nit crashes".into(), at: Some(3), sent_by: Some("desktop".into()), images: 0 };
        assert_eq!(to_remote(&sent), Some(RemoteEvent::UserText { text: "it crashes".into(), at: Some(3), sent_by: Some("desktop".into()), images: None }));
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
        let info = crate::remote::hub::ChatInfo { slot: "a".into(), title: Some("t".into()), folder: Some("/Users/me/dev/lantern".into()), session_id: Some("s".into()), status: crate::remote::hub::ChatStatus::NeedsYou, last_seq: 4, active_at: 9, permissions: Some("auto".into()), preset: Some("balanced".into()), color: Some("#5b5bd6".into()), workflow: Some("steps".into()), provider: None, preview: Some("Bash npm test".into()) };
        let chat = RemoteChat::from(info);
        assert_eq!((chat.project.as_deref(), chat.status), (Some("lantern"), ChatStatus::NeedsYou));
    }
}
