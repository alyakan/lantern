//! Chat hooks: two prompts the user writes themselves (Settings > Hooks, and per project), which Lantern runs around the
//! messages they send. The pre-hook goes in front of the first message of a chat and of the first one after a compaction
//! ("Check the brain's summary about this project"); the post-hook is sent as a turn of its own once Claude has answered a
//! message ("Update the brain if needed"). They are plain prompts: Lantern knows nothing of what they ask for.
//!
//! The window keeps what the user wrote (like every setting) and tells the backend (`set_chat_hooks`), which applies it
//! where a message goes out (`send_user_message`, so a paired phone's messages carry the pre-hook too) and where a turn ends
//! (the emitter). The post-hook's turn is not shown as a turn of its own: the user's turn goes on until the hook is done, and
//! ends once, with both turns' costs, so the busy state, the message queue, a phone's push and its lock-screen card each see
//! one end for each message.

use crate::ui_event::UiEvent;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Mutex;

/// The most characters a hook holds: what the window allows, and what is cut to here as well.
pub const MAX_HOOK_CHARS: usize = 2000;

/// What the pre-hook note starts with. It is one paragraph (no blank line in it) so that a replayed chat strips it like the
/// other `[Lantern note:` blocks (see history::without_lantern_note).
const PRE_NOTE_START: &str = "[Lantern note: the user set this up to be done at the start of a chat. Before you answer their message, do this first: ";

/// What the post-hook's message starts with. It is what Claude is sent, and what a replayed chat shows the card from.
pub const POST_PREFIX: &str = "[Lantern post-hook]\n";

/// One hook as the user wrote it: its words, and whether it is on.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Hook {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub on: bool,
}

/// A project's own choice for each hook: None uses the workspace's, a hook that is off means none for this project.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct ProjectHooks {
    #[serde(default)]
    pub pre: Option<Hook>,
    #[serde(default)]
    pub post: Option<Hook>,
}

/// Every hook the user has set, keyed by project folder where it is a project's own.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct HookTable {
    #[serde(default)]
    pub pre: Hook,
    #[serde(default)]
    pub post: Hook,
    #[serde(default)]
    pub projects: HashMap<String, ProjectHooks>,
}

/// The hooks that apply to one chat: the words of each that is on.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Resolved {
    pub pre: Option<String>,
    pub post: Option<String>,
}

/// A hook's words as they are sent: trimmed, cut to the limit, and on as few lines as they were written on without a blank
/// one (a blank line would end the note, see `PRE_NOTE_START`). None when it is off or says nothing.
fn words(hook: &Hook) -> Option<String> {
    if !hook.on {
        return None;
    }
    let lines: Vec<&str> = hook.text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let text: String = lines.join("\n").chars().take(MAX_HOOK_CHARS).collect();
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

impl HookTable {
    /// What applies to a chat in `folder`: the project's own hook where it has one, else the workspace's.
    pub fn resolve(&self, folder: &str) -> Resolved {
        let own = self.projects.get(folder);
        let pick = |mine: Option<&Hook>, workspace: &Hook| words(mine.unwrap_or(workspace));
        Resolved { pre: pick(own.and_then(|p| p.pre.as_ref()), &self.pre), post: pick(own.and_then(|p| p.post.as_ref()), &self.post) }
    }
}

/// Whether a message can carry a note: not a slash command, which Claude reads as one only at the very start of the message
/// (`/compact` with the hook in front would take it for its instructions). The hook waits for the next message instead.
pub fn carries_note(text: &str) -> bool {
    !text.trim_start().starts_with('/')
}

/// `text` with the pre-hook in front of it.
fn with_pre(text: &str, pre: &str) -> String {
    format!("{PRE_NOTE_START}{pre}]\n\n{text}")
}

/// What Claude is sent for a post-hook.
pub fn post_message(post: &str) -> String {
    format!("{POST_PREFIX}{post}")
}

/// The post-hook inside a message, if it is one (for the window's card when a chat is replayed).
pub fn post_text(message: &str) -> Option<&str> {
    message.strip_prefix(POST_PREFIX)
}

/// Where a chat's post-hook stands.
#[derive(Debug, Default)]
enum Post {
    #[default]
    Idle,
    /// A message of the user's is being worked on, and the post-hook (its message) follows it.
    Armed(String),
    /// The post-hook's turn is running; the user's turn's end is held until it is done.
    Running(Box<UiEvent>),
}

#[derive(Debug, Default)]
struct Inner {
    /// The next message that can carry it is the first of a chat, or of the conversation after a compaction.
    pre_armed: bool,
    post: Post,
}

/// What the emitter does with a chat's end of turn.
#[derive(Debug, PartialEq)]
pub enum TurnEnd {
    /// Tell everyone of it, as it is (or merged with the post-hook's).
    Publish(Box<UiEvent>),
    /// Hold it back and send this message (the post-hook) into the chat.
    SendPost(String),
}

/// A chat's hook state: whether its pre-hook is due, and where its post-hook stands.
#[derive(Debug, Default)]
pub struct SlotHooks(Mutex<Inner>);

impl SlotHooks {
    /// The chat starts a conversation (a new chat, or `/clear`, or a compaction): its next message carries the pre-hook.
    pub fn arm_pre(&self) {
        self.0.lock().unwrap().pre_armed = true;
    }

    /// What to send for the user's `text`: with the pre-hook in front of it when that is due and the message can carry it (a
    /// slash command can't: the hook waits for the next message). A hook that is due when there is none is not kept for later
    /// (a hook the user writes in the middle of a chat starts with the next conversation). Give it back with `arm_pre` if
    /// the message that carries it doesn't go.
    pub fn carry_pre(&self, text: &str, pre: Option<&str>) -> String {
        if !carries_note(text) {
            return text.to_string();
        }
        let due = std::mem::take(&mut self.0.lock().unwrap().pre_armed);
        match pre {
            Some(pre) if due => with_pre(text, pre),
            _ => text.to_string(),
        }
    }

    /// A message of the user's was sent: its turn will be followed by `post` (its message), or by nothing.
    pub fn follow_with(&self, post: Option<String>) {
        let mut inner = self.0.lock().unwrap();
        // One that is already running is not interrupted by a message sent meanwhile (a phone's): it ends the turn it holds.
        if !matches!(inner.post, Post::Running(_)) {
            inner.post = post.map_or(Post::Idle, Post::Armed);
        }
    }

    /// The post-hook was not sent after all (the message that would carry it didn't go).
    pub fn forget_post(&self) {
        let mut inner = self.0.lock().unwrap();
        if matches!(inner.post, Post::Armed(_)) {
            inner.post = Post::Idle;
        }
    }

    /// A turn ended: what to do with it.
    pub fn turn_ended(&self, ended: UiEvent) -> TurnEnd {
        let mut inner = self.0.lock().unwrap();
        match (std::mem::take(&mut inner.post), &ended) {
            (Post::Armed(post), UiEvent::TurnDone { is_error: false, .. }) => {
                inner.post = Post::Running(Box::new(ended));
                TurnEnd::SendPost(post_message(&post))
            }
            (Post::Running(held), UiEvent::TurnDone { .. }) => TurnEnd::Publish(Box::new(merged(*held, ended))),
            // A turn that failed or was stopped isn't followed by anything; neither is a turn nobody asked for.
            (_, _) => TurnEnd::Publish(Box::new(ended)),
        }
    }

    /// The post-hook could not be sent: the end of the turn that was held for it, to tell everyone of now.
    pub fn post_failed(&self) -> Option<UiEvent> {
        match std::mem::take(&mut self.0.lock().unwrap().post) {
            Post::Running(held) => Some(*held),
            _ => None,
        }
    }

    /// Its claude is gone: nothing is waiting for a turn that will not end.
    pub fn session_ended(&self) {
        self.0.lock().unwrap().post = Post::Idle;
    }
}

fn add<T: std::ops::Add<Output = T>>(a: Option<T>, b: Option<T>) -> Option<T> {
    Some(a? + b?)
}

/// The end of the user's turn and of the post-hook's after it, as one: what both cost, how long both took, and how the
/// session stands now. A post-hook that failed makes the whole turn show the failure, since it is what the user will want to
/// know of.
fn merged(first: UiEvent, second: UiEvent) -> UiEvent {
    let (
        UiEvent::TurnDone { is_error: e1, result: r1, cost_usd: c1, tokens: t1, duration_ms: d1, auth_hint: a1, denied: n1, context_window: w1, .. },
        UiEvent::TurnDone { is_error: e2, result: r2, cost_usd: c2, tokens: t2, session_cost_usd, session_tokens, duration_ms: d2, auth_hint: a2, denied: n2, context_window: w2 },
    ) = (first, second)
    else {
        unreachable!("only ends of turns are merged")
    };
    UiEvent::TurnDone {
        is_error: e1 || e2,
        result: if e2 { r2 } else { r1 },
        cost_usd: add(c1, c2),
        tokens: add(t1, t2),
        session_cost_usd,
        session_tokens,
        duration_ms: add(d1, d2),
        auth_hint: a1 || a2,
        denied: n1 + n2,
        context_window: w2.or(w1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hook(text: &str, on: bool) -> Hook {
        Hook { text: text.into(), on }
    }

    fn done(is_error: bool, cost: Option<f64>, session: f64) -> UiEvent {
        UiEvent::TurnDone { is_error, result: is_error.then(|| "boom".into()), cost_usd: cost, tokens: Some(100), session_cost_usd: Some(session), session_tokens: 500, duration_ms: Some(1000), auth_hint: false, denied: 0, context_window: Some(200_000) }
    }

    #[test]
    fn a_projects_own_hook_replaces_the_workspaces_and_an_unset_one_uses_it() {
        let mut table = HookTable { pre: hook("check the brain", true), post: hook("update the brain", true), projects: HashMap::new() };
        assert_eq!(table.resolve("/p"), Resolved { pre: Some("check the brain".into()), post: Some("update the brain".into()) });
        table.projects.insert("/p".into(), ProjectHooks { pre: Some(hook("read NOTES.md", true)), post: Some(hook("anything", false)) });
        // Its own pre-hook; its post-hook is off, which means none (not the workspace's).
        assert_eq!(table.resolve("/p"), Resolved { pre: Some("read NOTES.md".into()), post: None });
        // Another project is unaffected.
        assert_eq!(table.resolve("/q").pre.as_deref(), Some("check the brain"));
        // A project that sets only one hook uses the workspace's for the other.
        table.projects.insert("/r".into(), ProjectHooks { pre: None, post: Some(hook("x", true)) });
        assert_eq!(table.resolve("/r"), Resolved { pre: Some("check the brain".into()), post: Some("x".into()) });
    }

    #[test]
    fn a_hook_that_is_off_or_says_nothing_is_none() {
        assert_eq!(words(&hook("do it", false)), None);
        assert_eq!(words(&hook("  \n\n ", true)), None);
        assert_eq!(words(&hook("  do it  ", true)).as_deref(), Some("do it"));
    }

    #[test]
    fn blank_lines_in_a_hook_are_dropped_so_its_note_stays_one_paragraph() {
        assert_eq!(words(&hook("first\n\n\nsecond  \n  third", true)).as_deref(), Some("first\nsecond\nthird"));
        assert_eq!(words(&hook(&"a".repeat(MAX_HOOK_CHARS + 50), true)).unwrap().chars().count(), MAX_HOOK_CHARS);
    }

    #[test]
    fn the_pre_hook_goes_in_front_of_a_message_that_can_carry_it_and_only_when_it_is_due() {
        let h = SlotHooks::default();
        // Not due: the message goes as it is.
        assert_eq!(h.carry_pre("why?", Some("check the brain")), "why?");
        h.arm_pre();
        // A slash command stays one: the hook waits for the next message.
        assert_eq!(h.carry_pre("/compact", Some("check the brain")), "/compact");
        assert_eq!(h.carry_pre("  /clear", Some("check the brain")), "  /clear");
        let with = h.carry_pre("why is it slow?", Some("check the brain"));
        assert!(with.starts_with(PRE_NOTE_START));
        assert!(with.ends_with("check the brain]\n\nwhy is it slow?"));
        // Once: the next message carries nothing.
        assert_eq!(h.carry_pre("and?", Some("check the brain")), "and?");
        h.arm_pre();
        assert!(h.carry_pre("what does /clear do?", Some("check the brain")).starts_with(PRE_NOTE_START));
    }

    #[test]
    fn a_pre_hook_that_is_due_when_there_is_none_is_not_kept_for_later() {
        let h = SlotHooks::default();
        h.arm_pre();
        assert_eq!(h.carry_pre("hi", None), "hi");
        assert_eq!(h.carry_pre("hello", Some("check the brain")), "hello");
    }

    #[test]
    fn a_replayed_chat_strips_the_pre_hook_note_like_the_others() {
        let with = with_pre("why is it slow?", "check the brain\nand NOTES.md");
        assert_eq!(crate::history::prompt_text(&serde_json::json!({"type": "user", "message": {"content": with}})), Some("why is it slow?".into()));
    }

    #[test]
    fn the_post_hooks_message_is_known_again_from_its_prefix() {
        let sent = post_message("update the brain");
        assert_eq!(post_text(&sent), Some("update the brain"));
        assert_eq!(post_text("update the brain"), None);
    }

    #[test]
    fn a_turn_with_no_post_hook_ends_as_it_is() {
        let h = SlotHooks::default();
        let ev = done(false, Some(0.1), 0.1);
        assert_eq!(h.turn_ended(ev.clone()), TurnEnd::Publish(Box::new(ev)));
    }

    #[test]
    fn the_post_hook_follows_a_turn_and_the_two_end_as_one() {
        let h = SlotHooks::default();
        h.follow_with(Some("update the brain".into()));
        assert_eq!(h.turn_ended(done(false, Some(0.10), 0.10)), TurnEnd::SendPost(post_message("update the brain")));
        // The hook's own turn ends: one end for both, with both costs and how the session stands now.
        let TurnEnd::Publish(ev) = h.turn_ended(done(false, Some(0.02), 0.12)) else { panic!("published") };
        let UiEvent::TurnDone { is_error, cost_usd, tokens, session_cost_usd, duration_ms, .. } = *ev else { panic!("a turn end") };
        assert!(!is_error);
        assert!((cost_usd.unwrap() - 0.12).abs() < 1e-9);
        assert_eq!(tokens, Some(200));
        assert_eq!(session_cost_usd, Some(0.12));
        assert_eq!(duration_ms, Some(2000));
        // And it does not go on: the next turn ended is plain.
        let ev = done(false, None, 0.2);
        assert_eq!(h.turn_ended(ev.clone()), TurnEnd::Publish(Box::new(ev)));
    }

    #[test]
    fn a_turn_that_failed_is_not_followed_by_the_post_hook() {
        let h = SlotHooks::default();
        h.follow_with(Some("update the brain".into()));
        let ev = done(true, None, 0.1);
        assert_eq!(h.turn_ended(ev.clone()), TurnEnd::Publish(Box::new(ev)));
        let next = done(false, None, 0.1);
        assert_eq!(h.turn_ended(next.clone()), TurnEnd::Publish(Box::new(next)), "and it is not kept for the turn after");
    }

    #[test]
    fn a_post_hook_that_fails_shows_in_the_turn_that_ends() {
        let h = SlotHooks::default();
        h.follow_with(Some("update the brain".into()));
        h.turn_ended(done(false, Some(0.1), 0.1));
        let TurnEnd::Publish(ev) = h.turn_ended(done(true, None, 0.1)) else { panic!("published") };
        let UiEvent::TurnDone { is_error, result, cost_usd, .. } = *ev else { panic!("a turn end") };
        assert!(is_error);
        assert_eq!(result.as_deref(), Some("boom"));
        assert_eq!(cost_usd, None, "a cost that isn't known for one of the two isn't known for both");
    }

    #[test]
    fn a_post_hook_that_could_not_be_sent_gives_back_the_turn_it_held() {
        let h = SlotHooks::default();
        h.follow_with(Some("update the brain".into()));
        let held = done(false, Some(0.1), 0.1);
        h.turn_ended(held.clone());
        assert_eq!(h.post_failed(), Some(held));
        assert_eq!(h.post_failed(), None);
    }

    #[test]
    fn a_message_sent_while_the_post_hook_runs_does_not_cancel_it_and_a_session_ending_does() {
        let h = SlotHooks::default();
        h.follow_with(Some("update the brain".into()));
        h.turn_ended(done(false, None, 0.1));
        h.follow_with(None);
        assert!(matches!(h.turn_ended(done(false, None, 0.1)), TurnEnd::Publish(_)));
        h.follow_with(Some("update the brain".into()));
        h.turn_ended(done(false, None, 0.1));
        h.session_ended();
        assert_eq!(h.post_failed(), None);
    }

    #[test]
    fn a_message_that_did_not_go_takes_its_post_hook_back() {
        let h = SlotHooks::default();
        h.follow_with(Some("update the brain".into()));
        h.forget_post();
        let ev = done(false, None, 0.1);
        assert_eq!(h.turn_ended(ev.clone()), TurnEnd::Publish(Box::new(ev)));
    }
}
