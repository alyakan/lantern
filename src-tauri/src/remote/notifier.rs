//! Telling a paired phone that a chat needs it, or has finished, when it isn't looking: a push through Expo's service
//! (which hands it to Apple's or Google's). What goes out is a chat id and a kind, with words that name no code and no
//! prompt; the chat's title only if the user turned that on in Settings. At most one push per chat and kind, until the
//! user has looked: opened the chat on the phone, answered what was asked, or sent the next message.

use super::bus::{BusEvent, EventBus};
use super::gateway::BoxFut;
use super::hub::{ChatStatus, SessionHub};
use super::pairing::{Device, RemoteStore};
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
    watched: Watched,
    /// What was pushed and hasn't been looked at since: one entry per chat and kind.
    sent: Mutex<HashSet<(String, Kind)>>,
}

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
    pub fn new(store: Arc<RemoteStore>, hub: Arc<SessionHub>, sender: Arc<dyn PushSender>, watched: Watched) -> Arc<Self> {
        Arc::new(Self { store, hub, sender, watched, sent: Mutex::default() })
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
        self.sent.lock().unwrap().retain(|(s, _)| s != slot);
    }

    fn forget(&self, slot: &str, kinds: &[Kind]) {
        self.sent.lock().unwrap().retain(|(s, k)| s != slot || !kinds.contains(k));
    }

    /// What one event does: a push, or the end of a reason not to push again.
    pub async fn handle(&self, ev: &BusEvent) {
        let slot = ev.slot.as_str();
        match &ev.event {
            UiEvent::PermissionRequested { .. } | UiEvent::MergeProposed { .. } => self.push(slot, Kind::NeedsYou).await,
            // Nothing waits any more (answered anywhere, or withdrawn): the next thing that waits is news again.
            UiEvent::PermissionResolved { .. } | UiEvent::PermissionWithdrawn { .. } | UiEvent::MergeResolved { .. } => {
                if self.hub.chat(slot).is_none_or(|c| c.status != ChatStatus::NeedsYou) {
                    self.forget(slot, &[Kind::NeedsYou]);
                }
            }
            UiEvent::TurnDone { is_error: false, .. } => self.push(slot, Kind::Finished).await,
            UiEvent::TurnDone { is_error: true, .. } => self.push(slot, Kind::Failed).await,
            UiEvent::SessionEnded { code: Some(c), .. } if *c != 0 => self.push(slot, Kind::Failed).await,
            // A new message starts a new turn, and a new claude starts over.
            UiEvent::UserText { .. } => self.forget(slot, &[Kind::Finished, Kind::Failed]),
            UiEvent::SessionStarted { .. } => self.forget(slot, &[Kind::Failed]),
            _ => {}
        }
    }

    async fn push(&self, slot: &str, kind: Kind) {
        let saved = self.store.saved();
        // Remote control off, nobody to tell, or a phone is looking at this very chat.
        if !saved.enabled || (self.watched)(slot) {
            return;
        }
        let devices: Vec<&Device> = saved.devices.iter().filter(|d| d.push_token.is_some()).collect();
        if devices.is_empty() || !self.sent.lock().unwrap().insert((slot.to_string(), kind)) {
            return;
        }
        let title = saved.show_titles.then(|| self.hub.chat(slot).and_then(|c| c.title)).flatten().map(|t| t.chars().take(60).collect::<String>());
        let (title, body) = words(kind, title.as_deref());
        let messages: Vec<PushMessage> = devices
            .iter()
            .map(|d| PushMessage { to: d.push_token.clone().unwrap_or_default(), title: title.clone(), body: body.clone(), data: PushData { slot: slot.to_string(), kind }, sound: "default" })
            .collect();
        match self.sender.send(messages).await {
            Ok(tickets) => {
                // A phone that no longer has the app is forgotten for push (it stays paired).
                for (device, ticket) in devices.iter().zip(tickets) {
                    if ticket.error.as_deref() == Some("DeviceNotRegistered") {
                        let _ = self.store.clear_push_token(&device.id);
                    }
                }
            }
            // Not sent (no network): it may be tried again by the next event of this kind.
            Err(_) => self.forget(slot, &[kind]),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

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

    struct Rig {
        notifier: Arc<Notifier>,
        outbox: Arc<Outbox>,
        store: Arc<RemoteStore>,
        hub: Arc<SessionHub>,
        watching: Arc<Mutex<HashSet<String>>>,
        seq: Mutex<u64>,
    }

    fn rig(devices: usize) -> Rig {
        let remote = crate::remote::Remote::default();
        remote.store.set_enabled(true).unwrap();
        for i in 0..devices {
            let d = remote.store.add_device(&[i as u8 + 1; 32], &format!("Phone {i}"), 1).unwrap();
            remote.store.set_push_token(&d.id, &format!("ExponentPushToken[t{i}]")).unwrap();
        }
        let outbox = Arc::new(Outbox::default());
        let watching: Arc<Mutex<HashSet<String>>> = Arc::default();
        let w = watching.clone();
        let notifier = Notifier::new(remote.store.clone(), remote.hub.clone(), outbox.clone(), Arc::new(move |slot| w.lock().unwrap().contains(slot)));
        Rig { notifier, outbox, store: remote.store.clone(), hub: remote.hub.clone(), watching, seq: Mutex::new(0) }
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
    }

    fn ask(id: &str) -> UiEvent {
        UiEvent::PermissionRequested { request_id: id.into(), tool_name: "Bash".into(), input: serde_json::json!({"command": "echo SECRET-COMMAND"}) }
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
        r.event("a", ask("p1")).await;
        r.event("a", ask("p2")).await;
        assert_eq!(r.pushed().len(), 1);
        // Both answered: the next thing that waits is news again.
        r.event("a", UiEvent::PermissionResolved { request_id: "p1".into(), allow: true, by: "desktop".into() }).await;
        r.event("a", ask("p3")).await;
        assert_eq!(r.pushed().len(), 1, "p2 is still waiting, so p3 isn't news");
        r.event("a", UiEvent::PermissionResolved { request_id: "p2".into(), allow: true, by: "desktop".into() }).await;
        r.event("a", UiEvent::PermissionResolved { request_id: "p3".into(), allow: true, by: "desktop".into() }).await;
        r.event("a", ask("p4")).await;
        assert_eq!(r.pushed().len(), 2);
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

    #[test]
    fn a_push_is_in_the_shape_expo_takes() {
        let m = PushMessage { to: "ExponentPushToken[x]".into(), title: "Lantern".into(), body: "A chat needs you.".into(), data: PushData { slot: "a".into(), kind: Kind::NeedsYou }, sound: "default" };
        assert_eq!(serde_json::to_value(&m).unwrap(), serde_json::json!({"to": "ExponentPushToken[x]", "title": "Lantern", "body": "A chat needs you.", "data": {"slot": "a", "kind": "needs_you"}, "sound": "default"}));
    }
}
