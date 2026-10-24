//! The card on a phone's lock screen for the chat the user last messaged from it (a Live Activity). The phone starts the
//! card and hands the Mac its token; from then on the Mac keeps it right with pushes straight to Apple, signed with the
//! push key the user imported (kept in the Keychain), whether or not the phone is connected or awake.
//!
//! What a card says is the project's name, one of four states and when the turn began: never a chat's title (it can be the
//! first words of a message), a command, a file or any text of Claude's. Tokens come from a phone and go into a URL, so they
//! are checked to be hex before anything uses them, and the host and topic they are sent to are fixed here.

use super::bus::{BusEvent, EventBus};
use super::gateway::BoxFut;
use super::hub::{ChatStatus, SessionHub};
use super::keys::KeyStore;
use super::pairing::RemoteStore;
use crate::ui_event::UiEvent;
use base64::Engine;
use ring::rand::SystemRandom;
use ring::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, Notify};

const URL_SAFE: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;
const STANDARD: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// Apple's push service (production: TestFlight and App Store builds). Only the device token is added to it.
pub const APNS_URL: &str = "https://api.push.apple.com/3/device/";
/// The topic of a Live Activity push: the app's bundle id and this suffix.
pub const TOPIC: &str = "com.alyakan.lantern.push-type.liveactivity";
/// The name the phone gives its card's layout (createLiveActivity): what a push says it is updating.
pub const ACTIVITY_NAME: &str = "LanternChat";
/// What a push to start a card must say its data is (expo-widgets' own type).
pub const ATTRIBUTES_TYPE: &str = "LiveActivityAttributes";
/// How long a card stays after its turn ended, in seconds, before the phone clears it.
pub const DISMISS_AFTER_SECS: u64 = 10 * 60;
/// A card goes stale (the phone says it is not being updated) this long after the last push, so a Mac that has gone to sleep
/// doesn't leave a confident "Working" with a ticking timer. While the Mac is awake, a card is pushed again before then.
const STALE_AFTER_SECS: u64 = 25 * 60;
const REFRESH_AFTER_MS: u64 = 15 * 60 * 1000;
/// How often the cards are looked at for one that is due a refresh.
const HEARTBEAT: Duration = Duration::from_secs(5 * 60);
/// A card the phone started this long ago is gone (iOS ends every Live Activity after about 8 hours).
const CARD_LIFETIME_MS: u64 = 8 * 60 * 60 * 1000;
/// How long a signed token is reused: Apple wants one at most every 20 minutes and none older than an hour.
const JWT_REUSE_SECS: u64 = 50 * 60;
/// The longest a project's name on a card is, in characters.
const PROJECT_MAX: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Working,
    NeedsYou,
    Done,
    Failed,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Status::Working => "working",
            Status::NeedsYou => "needs_you",
            Status::Done => "done",
            Status::Failed => "failed",
        }
    }
}

/// Whether `token` could be a push token: hex, of a length Apple's tokens have. (It goes into a URL.)
pub fn valid_token(token: &str) -> bool {
    (32..=200).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A project's name as it may appear on a lock screen: no control characters, not long.
pub fn clean_project(name: &str) -> String {
    let cleaned: String = name.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(PROJECT_MAX).collect();
    if cleaned.is_empty() { "Lantern".into() } else { cleaned }
}

/// A phone's card, as the Mac keeps it.
#[derive(Debug, Clone, PartialEq)]
pub struct LiveCard {
    pub slot: String,
    /// The card's own push token (Apple's, hex).
    pub token: String,
    pub project: String,
    /// When the turn it shows began (ms since the epoch): the phone's timer counts from it.
    pub since: u64,
    pub status: Status,
    /// An end was pushed (or Apple said the card is gone): nothing more is sent to it.
    pub ended: bool,
    pub registered_at: u64,
    /// When the card was last pushed to (ms): after STALE_AFTER_SECS without one, the phone shows it as not updating.
    pub last_push: u64,
}

/// What a phone has told the Mac about its Live Activities.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LiveState {
    /// The phone's token for starting a card by push (kept for when a card may be started from the Mac).
    pub start_token: Option<String>,
    pub card: Option<LiveCard>,
}

/// Every phone's Live Activity state, in memory only: a phone says it again each time it connects, and a card's token is
/// no use for long. `changed` wakes the service when a phone has registered a card, so that a turn that already ended
/// is shown as ended.
#[derive(Default)]
pub struct LiveBook {
    states: Mutex<HashMap<String, LiveState>>,
    pub changed: Notify,
    /// What Apple last answered, for Settings (never a token, a payload or the key).
    pub last: Mutex<Option<String>>,
}

impl LiveBook {
    /// A phone's whole Live Activity state: replaces what it said before.
    pub fn register(&self, device: &str, start_token: Option<String>, card: Option<LiveCard>) {
        let mut states = self.states.lock().unwrap();
        // The same card said again (a phone does, each time it connects) is the card the Mac already follows: what it knows
        // of where it stands is kept, rather than started over (and an end it already sent sent again).
        let card = match (card, states.get(device).and_then(|s| s.card.as_ref())) {
            (Some(new), Some(old)) if new.slot == old.slot && new.token == old.token => Some(old.clone()),
            (new, _) => new,
        };
        states.insert(device.to_string(), LiveState { start_token, card });
        drop(states);
        self.changed.notify_one();
    }

    pub fn forget(&self, device: &str) {
        self.states.lock().unwrap().remove(device);
    }

    pub fn cards(&self) -> Vec<(String, LiveCard)> {
        self.states.lock().unwrap().iter().filter_map(|(d, s)| s.card.clone().map(|c| (d.clone(), c))).collect()
    }

    pub fn state(&self, device: &str) -> Option<LiveState> {
        self.states.lock().unwrap().get(device).cloned()
    }

    fn edit(&self, device: &str, f: impl FnOnce(&mut LiveCard)) {
        if let Some(card) = self.states.lock().unwrap().get_mut(device).and_then(|s| s.card.as_mut()) {
            f(card);
        }
    }

    fn drop_card(&self, device: &str) {
        if let Some(s) = self.states.lock().unwrap().get_mut(device) {
            s.card = None;
        }
    }

    fn said(&self, what: String) {
        *self.last.lock().unwrap() = Some(what);
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The key, and the signed token Apple wants with every push.

/// The `.p8` Apple gives, as the PKCS#8 bytes inside its PEM.
fn der_of_pem(pem: &str) -> Result<Vec<u8>, String> {
    let body: String = pem
        .lines()
        .map(str::trim)
        .skip_while(|l| *l != "-----BEGIN PRIVATE KEY-----")
        .skip(1)
        .take_while(|l| *l != "-----END PRIVATE KEY-----")
        .collect();
    if body.is_empty() {
        return Err("That isn't a push key: it should be the .p8 file Apple gave you.".into());
    }
    STANDARD.decode(body).map_err(|_| "That isn't a push key: it should be the .p8 file Apple gave you.".to_string())
}

fn ten_letters_or_digits(s: &str) -> bool {
    s.len() == 10 && s.chars().all(|c| c.is_ascii_alphanumeric())
}

/// The key, ready to sign with.
pub struct Signer {
    key_id: String,
    team_id: String,
    pair: EcdsaKeyPair,
    /// The signed token in use, and when it was made.
    cached: Mutex<Option<(String, u64)>>,
}

impl Signer {
    /// Reads a `.p8` and proves it signs: a key that parses but can't sign is told now, not by Apple's first refusal.
    pub fn from_p8(key_id: &str, team_id: &str, p8: &str) -> Result<Self, String> {
        if !ten_letters_or_digits(key_id) {
            return Err("A Key ID is 10 letters and digits (it is in the file's name: AuthKey_XXXXXXXXXX.p8).".into());
        }
        if !ten_letters_or_digits(team_id) {
            return Err("A Team ID is 10 letters and digits.".into());
        }
        let rng = SystemRandom::new();
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &der_of_pem(p8)?, &rng).map_err(|_| "That isn't a push key Lantern can use (a P-256 key from Apple).".to_string())?;
        pair.sign(&rng, b"lantern").map_err(|_| "That key couldn't sign anything.".to_string())?;
        Ok(Self { key_id: key_id.into(), team_id: team_id.into(), pair, cached: Mutex::new(None) })
    }

    pub fn key_id(&self) -> &str {
        &self.key_id
    }

    /// Drops the signed token in use: Apple refused it, so the next push makes a new one.
    pub fn forget_bearer(&self) {
        *self.cached.lock().unwrap() = None;
    }

    /// The signed token for `now` (seconds): the one already made, until it is nearly old enough for Apple to refuse it.
    pub fn bearer(&self, now: u64) -> Result<String, String> {
        let mut cached = self.cached.lock().unwrap();
        if let Some((jwt, at)) = cached.as_ref() {
            if now < at + JWT_REUSE_SECS {
                return Ok(jwt.clone());
            }
        }
        let header = URL_SAFE.encode(json!({"alg": "ES256", "kid": self.key_id}).to_string());
        let claims = URL_SAFE.encode(json!({"iss": self.team_id, "iat": now}).to_string());
        let signing_input = format!("{header}.{claims}");
        let signature = self.pair.sign(&SystemRandom::new(), signing_input.as_bytes()).map_err(|_| "Couldn't sign the push.".to_string())?;
        let jwt = format!("{signing_input}.{}", URL_SAFE.encode(signature.as_ref()));
        *cached = Some((jwt.clone(), now));
        Ok(jwt)
    }
}

/// What is kept in the Keychain for the push key: the key and the two ids it goes with.
#[derive(Serialize, Deserialize)]
struct KeyRecord {
    key_id: String,
    team_id: String,
    p8: String,
}

const ACCOUNT_NOTE: &str = "apns-key";

/// The login Keychain's slot for the push key (a separate item from the Mac's own key, under the same service).
pub struct LiveKeychain {
    pub service: &'static str,
}

const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

impl KeyStore for LiveKeychain {
    fn get(&self) -> Result<Option<Vec<u8>>, String> {
        match security_framework::passwords::get_generic_password(self.service, ACCOUNT_NOTE) {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(e) => Err(format!("Couldn't read the push key from the Keychain: {e}")),
        }
    }

    fn set(&self, value: &[u8]) -> Result<(), String> {
        security_framework::passwords::set_generic_password(self.service, ACCOUNT_NOTE, value).map_err(|e| format!("Couldn't save the push key in the Keychain: {e}"))
    }
}

/// The push key and where it lives: imported in Settings, read when the first push goes.
pub struct LiveKey {
    store: Mutex<Arc<dyn KeyStore>>,
    /// What reading the store came to, once it has: the signer, or none (nothing was imported). Kept, so that asking again
    /// (Settings does, on every refresh) never goes to the Keychain again.
    loaded: Mutex<Option<Option<Arc<Signer>>>>,
}

impl Default for LiveKey {
    fn default() -> Self {
        Self::new(Arc::new(super::keys::Memory::default()))
    }
}

impl LiveKey {
    pub fn new(store: Arc<dyn KeyStore>) -> Self {
        Self { store: Mutex::new(store), loaded: Mutex::new(None) }
    }

    /// Keeps the key in `store` from now on (the app puts the Keychain here at launch).
    pub fn use_store(&self, store: Arc<dyn KeyStore>) {
        *self.store.lock().unwrap() = store;
        *self.loaded.lock().unwrap() = None;
    }

    /// Checks a `.p8`, keeps it, and uses it from now on. Nothing about the key is in the error.
    pub fn import(&self, key_id: &str, team_id: &str, p8: &str) -> Result<(), String> {
        let signer = Signer::from_p8(key_id.trim(), team_id.trim(), p8)?;
        let record = serde_json::to_vec(&KeyRecord { key_id: key_id.trim().into(), team_id: team_id.trim().into(), p8: p8.into() }).map_err(|e| e.to_string())?;
        self.store.lock().unwrap().set(&record)?;
        *self.loaded.lock().unwrap() = Some(Some(Arc::new(signer)));
        Ok(())
    }

    /// The signer, read from the store the first time: None when no key was imported. A store that can't be read, or holds
    /// what isn't a key, is an error each time, so it is tried again rather than taken for "none".
    pub fn signer(&self) -> Result<Option<Arc<Signer>>, String> {
        if let Some(known) = self.loaded.lock().unwrap().clone() {
            return Ok(known);
        }
        let known = match self.store.lock().unwrap().get()? {
            None => None,
            Some(raw) => {
                let record: KeyRecord = serde_json::from_slice(&raw).map_err(|_| "The push key kept in the Keychain isn't readable: import it again.".to_string())?;
                Some(Arc::new(Signer::from_p8(&record.key_id, &record.team_id, &record.p8)?))
            }
        };
        *self.loaded.lock().unwrap() = Some(known.clone());
        Ok(known)
    }

    /// The imported key's id, for Settings: only what is known already, never a read of the Keychain (see `signer`).
    pub fn key_id(&self) -> Option<String> {
        self.loaded.lock().unwrap().as_ref().and_then(|known| known.as_ref()).map(|s| s.key_id().to_string())
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// What is pushed, and to whom.

/// One push to a card.
#[derive(Debug, Clone, PartialEq)]
pub struct Push {
    /// "update" or "end".
    pub event: &'static str,
    /// 10 wakes the card at once (it needs you, or it is over); 5 is for the ticking along of Working.
    pub priority: u8,
    pub body: Value,
}

/// What Apple answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub status: u16,
    pub reason: Option<String>,
}

impl Reply {
    fn ok(&self) -> bool {
        self.status == 200
    }

    /// The card or the phone is gone (Apple answers 410, or 400 BadDeviceToken / 404 for a token it doesn't know).
    fn gone(&self) -> bool {
        self.status == 410 || self.status == 404 || (self.status == 400 && matches!(self.reason.as_deref(), Some("BadDeviceToken" | "DeviceTokenNotForTopic")))
    }

    fn words(&self) -> String {
        match &self.reason {
            Some(r) => format!("Apple answered {} ({r}).", self.status),
            None => format!("Apple answered {}.", self.status),
        }
    }
}

pub trait Apns: Send + Sync + 'static {
    fn send(&self, token: &str, push: &Push) -> BoxFut<Result<Reply, String>>;
}

/// Apple's push service over HTTP/2.
pub struct ApnsHttp {
    client: reqwest::Client,
    key: Arc<LiveKey>,
}

impl ApnsHttp {
    pub fn new(key: Arc<LiveKey>) -> Result<Self, String> {
        // The notifier and the updater install this too; whichever comes first does.
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        reqwest::Client::builder().timeout(Duration::from_secs(15)).build().map(|client| Self { client, key }).map_err(|e| e.to_string())
    }
}

fn now_secs() -> u64 {
    super::now_ms() / 1000
}

impl Apns for ApnsHttp {
    fn send(&self, token: &str, push: &Push) -> BoxFut<Result<Reply, String>> {
        let client = self.client.clone();
        let signer = self.key.signer();
        let (url, push) = (format!("{APNS_URL}{token}"), push.clone());
        Box::pin(async move {
            let signer = signer?.ok_or("No push key has been imported (Settings > Remote control).")?;
            let response = client
                .post(url)
                .header("authorization", format!("bearer {}", signer.bearer(now_secs())?))
                .header("apns-push-type", "liveactivity")
                .header("apns-topic", TOPIC)
                .header("apns-priority", push.priority.to_string())
                .json(&push.body)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = response.status().as_u16();
            let reason = response.json::<Value>().await.ok().and_then(|b| b["reason"].as_str().map(str::to_string));
            // A signed token Apple refused isn't used again: the next push makes a new one.
            if status == 403 && matches!(reason.as_deref(), Some("ExpiredProviderToken" | "InvalidProviderToken")) {
                signer.forget_bearer();
            }
            Ok(Reply { status, reason })
        })
    }
}

/// The card's data, as the phone's layout reads it (a JSON string inside the push: `props`).
fn props_json(project: &str, status: Status, since: u64) -> String {
    json!({"project": project, "status": status.as_str(), "since": since}).to_string()
}

/// The body of a push to a card: `event` ("update" or "end"), what it shows, and for an end when the phone should clear it.
pub fn payload(event: &str, status: Status, project: &str, since: u64, now: u64) -> Value {
    let mut aps = json!({
        "timestamp": now,
        "event": event,
        "content-state": {"name": ACTIVITY_NAME, "props": props_json(project, status, since)},
    });
    if event == "end" {
        aps["dismissal-date"] = json!(now + DISMISS_AFTER_SECS);
    } else {
        aps["stale-date"] = json!(now + STALE_AFTER_SECS);
    }
    json!({"aps": aps})
}

// ---------------------------------------------------------------------------------------------------------------------
// The service: chat events in, card pushes out.

pub struct LiveActivities {
    store: Arc<RemoteStore>,
    hub: Arc<SessionHub>,
    apns: Arc<dyn Apns>,
    now_ms: fn() -> u64,
}

/// What an event does to a chat's card: the push to send, and the state it leaves the card in.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Next {
    Update(Status),
    /// A new turn on the same card: the timer starts again.
    Restart,
    /// The same state again, so the phone doesn't take the card for one that is no longer kept up to date.
    Refresh,
    End(Status),
}

impl LiveActivities {
    pub fn new(store: Arc<RemoteStore>, hub: Arc<SessionHub>, apns: Arc<dyn Apns>) -> Arc<Self> {
        Self::with_clock(store, hub, apns, super::now_ms)
    }

    fn with_clock(store: Arc<RemoteStore>, hub: Arc<SessionHub>, apns: Arc<dyn Apns>, now_ms: fn() -> u64) -> Arc<Self> {
        Arc::new(Self { store, hub, apns, now_ms })
    }

    /// Follows the bus until it closes (the task `start_remote` runs and `stop` aborts), and looks again at the cards
    /// whenever a phone registers one.
    pub async fn run(self: Arc<Self>, bus: Arc<EventBus>) {
        let mut events = bus.subscribe();
        let mut beat = tokio::time::interval(HEARTBEAT);
        loop {
            tokio::select! {
                _ = beat.tick() => self.heartbeat().await,
                ev = events.recv() => match ev {
                    Ok(ev) => self.handle(&ev).await,
                    // Behind: the cards are brought right the next time anything about them happens.
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return,
                },
                _ = self.store.live.changed.notified() => self.reconcile().await,
            }
        }
    }

    /// The state a chat is in now, when its card is shown for the first time (a quick turn may be over before the phone
    /// had the card's token to hand over).
    fn current(&self, slot: &str) -> Option<Next> {
        match self.hub.chat(slot)?.status {
            ChatStatus::NeedsYou => Some(Next::Update(Status::NeedsYou)),
            ChatStatus::Idle | ChatStatus::Asleep => Some(Next::End(Status::Done)),
            ChatStatus::Ended => Some(Next::End(Status::Failed)),
            // The card was started as Working.
            ChatStatus::Working => None,
        }
    }

    /// Pushes again to each card that is live and hasn't had one for a while, so it stays fresh while this Mac is awake (and
    /// goes stale on the phone, as it should, when the Mac is not).
    async fn heartbeat(&self) {
        let now = (self.now_ms)();
        for (device, card) in self.store.live.cards() {
            if !card.ended && now.saturating_sub(card.last_push) >= REFRESH_AFTER_MS {
                self.push(&device, Next::Refresh).await;
            }
        }
    }

    async fn reconcile(&self) {
        for (device, card) in self.store.live.cards() {
            if card.ended || card.status != Status::Working {
                continue;
            }
            if let Some(next) = self.current(&card.slot) {
                self.push(&device, next).await;
            }
        }
    }

    fn next_for(&self, slot: &str, ev: &UiEvent) -> Option<Next> {
        match ev {
            UiEvent::PermissionRequested { .. } | UiEvent::MergeProposed { .. } => Some(Next::Update(Status::NeedsYou)),
            // Nothing waits any more (answered anywhere, or withdrawn): Claude is on with it.
            UiEvent::PermissionResolved { .. } | UiEvent::PermissionWithdrawn { .. } | UiEvent::MergeResolved { .. } => {
                (self.hub.chat(slot).is_none_or(|c| c.status != ChatStatus::NeedsYou)).then_some(Next::Update(Status::Working))
            }
            UiEvent::UserText { .. } => Some(Next::Restart),
            UiEvent::TurnDone { is_error: false, .. } => Some(Next::End(Status::Done)),
            UiEvent::TurnDone { is_error: true, .. } => Some(Next::End(Status::Failed)),
            UiEvent::SessionEnded { code: Some(c), .. } if *c != 0 => Some(Next::End(Status::Failed)),
            _ => None,
        }
    }

    /// What one event does: a push to each phone whose card is this chat's.
    pub async fn handle(&self, ev: &BusEvent) {
        if !self.store.saved().enabled {
            return;
        }
        let Some(next) = self.next_for(&ev.slot, &ev.event) else { return };
        for (device, card) in self.store.live.cards() {
            if card.slot == ev.slot {
                self.push(&device, next).await;
            }
        }
    }

    async fn push(&self, device: &str, next: Next) {
        let Some(card) = self.store.live.state(device).and_then(|s| s.card) else { return };
        let now = (self.now_ms)();
        // A card that is over is sent nothing more; one that iOS has ended by now is forgotten.
        if card.ended {
            return;
        }
        if now.saturating_sub(card.registered_at) > CARD_LIFETIME_MS {
            self.store.live.drop_card(device);
            return;
        }
        let (event, status, since) = match next {
            Next::Update(s) if s == card.status => return,
            Next::Update(s) => ("update", s, card.since),
            Next::Refresh => ("update", card.status, card.since),
            Next::Restart => ("update", Status::Working, now),
            Next::End(s) => ("end", s, card.since),
        };
        let push = Push { event, priority: if status == Status::Working { 5 } else { 10 }, body: payload(event, status, &card.project, since, now / 1000) };
        match self.apns.send(&card.token, &push).await {
            Ok(reply) if reply.ok() => {
                self.store.live.said("Apple accepted the last update.".into());
                self.store.live.edit(device, |c| {
                    c.status = status;
                    c.since = since;
                    c.ended = event == "end";
                    c.last_push = now;
                });
            }
            Ok(reply) => {
                self.store.live.said(reply.words());
                if reply.gone() {
                    self.store.live.drop_card(device);
                }
            }
            Err(e) => self.store.live.said(e),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ring::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_FIXED, KeyPair};

    /// A fresh P-256 key in Apple's file format.
    pub fn p8() -> String {
        let der = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new()).unwrap();
        let body = STANDARD.encode(der.as_ref());
        let lines: Vec<&str> = body.as_bytes().chunks(64).map(|c| std::str::from_utf8(c).unwrap()).collect();
        format!("-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n", lines.join("\n"))
    }

    /// A phone token of the right shape.
    pub const TOKEN: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

    #[derive(Default)]
    pub struct Outbox {
        pub sent: Mutex<Vec<(String, Push)>>,
        pub answer: Mutex<Option<Result<Reply, String>>>,
    }

    impl Apns for Outbox {
        fn send(&self, token: &str, push: &Push) -> BoxFut<Result<Reply, String>> {
            self.sent.lock().unwrap().push((token.to_string(), push.clone()));
            let answer = self.answer.lock().unwrap().clone().unwrap_or(Ok(Reply { status: 200, reason: None }));
            Box::pin(async move { answer })
        }
    }

    fn props(push: &Push) -> Value {
        serde_json::from_str(push.body["aps"]["content-state"]["props"].as_str().unwrap()).unwrap()
    }

    struct Rig {
        service: Arc<LiveActivities>,
        outbox: Arc<Outbox>,
        store: Arc<RemoteStore>,
        hub: Arc<SessionHub>,
        seq: Mutex<u64>,
    }

    fn clock() -> u64 {
        2_000_000_000_000
    }

    fn rig() -> Rig {
        let remote = crate::remote::Remote::default();
        remote.store.set_enabled(true).unwrap();
        let outbox = Arc::new(Outbox::default());
        let service = LiveActivities::with_clock(remote.store.clone(), remote.hub.clone(), outbox.clone(), clock);
        Rig { service, outbox, store: remote.store.clone(), hub: remote.hub.clone(), seq: Mutex::new(0) }
    }

    impl Rig {
        /// A phone with a card on `slot`, as the gateway registers it.
        fn card(&self, device: &str, slot: &str) {
            self.store.live.register(device, Some(TOKEN.into()), Some(LiveCard { slot: slot.into(), token: TOKEN.into(), project: "lantern".into(), since: clock() - 5_000, status: Status::Working, ended: false, registered_at: clock() - 5_000, last_push: clock() - 5_000 }));
        }

        async fn event(&self, slot: &str, event: UiEvent) {
            let seq = {
                let mut s = self.seq.lock().unwrap();
                *s += 1;
                *s
            };
            let ev = BusEvent { slot: slot.into(), seq, event };
            self.hub.record(&ev);
            self.service.handle(&ev).await;
        }

        fn sent(&self) -> Vec<(String, Push)> {
            self.outbox.sent.lock().unwrap().clone()
        }
    }

    fn done(is_error: bool) -> UiEvent {
        UiEvent::TurnDone { is_error, result: Some("SECRET-RESULT".into()), cost_usd: None, tokens: None, session_cost_usd: None, session_tokens: 0, duration_ms: None, auth_hint: false, denied: 0, context_window: None }
    }

    fn asked() -> UiEvent {
        UiEvent::PermissionRequested { request_id: "p1".into(), tool_name: "Bash".into(), input: json!({"command": "rm -rf secrets"}) }
    }

    fn resolved() -> UiEvent {
        UiEvent::PermissionResolved { request_id: "p1".into(), allow: true, by: "phone".into() }
    }

    #[test]
    fn a_push_key_is_read_from_the_file_apple_gives_and_signs_tokens_apple_can_check() {
        let pem = p8();
        let signer = Signer::from_p8("ABCDE12345", "2NT5QR24SX", &pem).unwrap();
        let jwt = signer.bearer(1_700_000_000).unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header: Value = serde_json::from_slice(&URL_SAFE.decode(parts[0]).unwrap()).unwrap();
        let claims: Value = serde_json::from_slice(&URL_SAFE.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(header, json!({"alg": "ES256", "kid": "ABCDE12345"}));
        assert_eq!(claims, json!({"iss": "2NT5QR24SX", "iat": 1_700_000_000u64}));
        // The signature is the 64 bytes Apple wants, and checks out against the key's public half.
        let signature = URL_SAFE.decode(parts[2]).unwrap();
        assert_eq!(signature.len(), 64);
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, signer.pair.public_key().as_ref()).verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature).unwrap();
    }

    /// A real key from Apple: `LANTERN_PUSH_KEY_FILE=…/AuthKey_XXXXXXXXXX.p8 LANTERN_PUSH_KEY_ID=XXXXXXXXXX cargo test
    /// real_push_key -- --ignored`. Prints nothing of the key.
    #[test]
    #[ignore]
    fn real_push_key() {
        let (file, id) = (std::env::var("LANTERN_PUSH_KEY_FILE").unwrap(), std::env::var("LANTERN_PUSH_KEY_ID").unwrap());
        let signer = Signer::from_p8(&id, "2NT5QR24SX", &std::fs::read_to_string(file).unwrap()).unwrap();
        assert_eq!(signer.bearer(1_700_000_000).unwrap().split('.').count(), 3);
    }

    /// One real request to Apple with a device token that doesn't exist, through the real sender: Apple answering 400
    /// BadDeviceToken means the connection (HTTP/2), the signed token, the Key and Team IDs and the topic are all accepted; only
    /// a phone is left to try. Nothing reaches any phone. `LANTERN_PUSH_KEY_FILE=… LANTERN_PUSH_KEY_ID=… cargo test
    /// real_apns -- --ignored --nocapture`. Prints Apple's status and reason, nothing of the key.
    #[tokio::test]
    #[ignore]
    async fn real_apns_takes_the_request() {
        let (file, id) = (std::env::var("LANTERN_PUSH_KEY_FILE").unwrap(), std::env::var("LANTERN_PUSH_KEY_ID").unwrap());
        let key = Arc::new(LiveKey::default());
        key.import(&id, "2NT5QR24SX", &std::fs::read_to_string(file).unwrap()).unwrap();
        let apns = ApnsHttp::new(key).unwrap();
        let push = Push { event: "update", priority: 10, body: payload("update", Status::Working, "lantern", 0, now_secs()) };
        let reply = apns.send(&"ab".repeat(32), &push).await.unwrap();
        println!("Apple answered {} {:?}", reply.status, reply.reason);
        assert_eq!((reply.status, reply.reason.as_deref()), (400, Some("BadDeviceToken")));
    }

    #[test]
    fn a_signed_token_is_reused_for_fifty_minutes_and_then_made_again() {
        let signer = Signer::from_p8("ABCDE12345", "2NT5QR24SX", &p8()).unwrap();
        let first = signer.bearer(1000).unwrap();
        assert_eq!(signer.bearer(1000 + JWT_REUSE_SECS - 1).unwrap(), first);
        let later = signer.bearer(1000 + JWT_REUSE_SECS).unwrap();
        assert_ne!(later, first);
        let claims: Value = serde_json::from_slice(&URL_SAFE.decode(later.split('.').nth(1).unwrap()).unwrap()).unwrap();
        assert_eq!(claims["iat"], 1000 + JWT_REUSE_SECS);
    }

    #[test]
    fn what_isnt_a_push_key_is_refused_without_saying_anything_about_the_key() {
        let pem = p8();
        for (key_id, team, text) in [("short", "2NT5QR24SX", pem.as_str()), ("ABCDE12345", "no", pem.as_str()), ("ABCDE12345", "2NT5QR24SX", "not a key"), ("ABCDE12345", "2NT5QR24SX", ""), ("ABCDE12345", "2NT5QR24SX", "-----BEGIN PRIVATE KEY-----\n!!!\n-----END PRIVATE KEY-----"), ("ABCDE1234!", "2NT5QR24SX", pem.as_str())] {
            let err = Signer::from_p8(key_id, team, text).err().unwrap_or_else(|| panic!("{key_id} {team} {text:?} was taken"));
            assert!(!err.contains("BEGIN") && !err.contains(&pem[40..60]), "{err}");
        }
    }

    #[test]
    fn the_key_is_kept_and_read_back_and_a_bad_one_changes_nothing() {
        let store = Arc::new(super::super::keys::Memory::default());
        let key = LiveKey::new(store.clone());
        assert!(key.signer().unwrap().is_none() && key.key_id().is_none());
        assert!(key.import("ABCDE12345", "2NT5QR24SX", "nope").is_err());
        assert!(store.get().unwrap().is_none(), "a bad key was kept");
        key.import("ABCDE12345", "2NT5QR24SX", &p8()).unwrap();
        assert_eq!(key.key_id().as_deref(), Some("ABCDE12345"));
        // A fresh LiveKey over the same store (the next launch) finds it once it is read (the app does at launch).
        let again = LiveKey::new(store.clone());
        assert!(again.key_id().is_none(), "asking for the id never reads the store");
        assert!(again.signer().unwrap().is_some());
        assert_eq!(again.key_id().as_deref(), Some("ABCDE12345"));
        // What is kept but isn't readable is an error, not "no key".
        store.set(b"garbage").unwrap();
        assert!(LiveKey::new(store).signer().is_err());
    }

    /// A store that counts how often it is read.
    #[derive(Default)]
    struct Counting {
        reads: Mutex<usize>,
        value: Mutex<Option<Vec<u8>>>,
    }

    impl KeyStore for Counting {
        fn get(&self) -> Result<Option<Vec<u8>>, String> {
            *self.reads.lock().unwrap() += 1;
            Ok(self.value.lock().unwrap().clone())
        }
        fn set(&self, value: &[u8]) -> Result<(), String> {
            *self.value.lock().unwrap() = Some(value.to_vec());
            Ok(())
        }
    }

    #[test]
    fn the_keychain_is_read_once_whether_or_not_there_is_a_key_and_never_to_say_the_id_in_settings() {
        let store = Arc::new(Counting::default());
        let key = LiveKey::new(store.clone());
        for _ in 0..5 {
            assert!(key.key_id().is_none());
        }
        assert_eq!(*store.reads.lock().unwrap(), 0, "Settings asking for the id read the Keychain");
        for _ in 0..5 {
            assert!(key.signer().unwrap().is_none());
        }
        assert_eq!(*store.reads.lock().unwrap(), 1, "no key is remembered as no key");
        key.import("ABCDE12345", "2NT5QR24SX", &p8()).unwrap();
        for _ in 0..5 {
            assert!(key.signer().unwrap().is_some());
        }
        assert_eq!(*store.reads.lock().unwrap(), 1);
    }

    #[test]
    fn a_signed_token_apple_refused_is_made_again() {
        let signer = Signer::from_p8("ABCDE12345", "2NT5QR24SX", &p8()).unwrap();
        let first = signer.bearer(1000).unwrap();
        assert_eq!(signer.bearer(1001).unwrap(), first);
        signer.forget_bearer();
        assert_ne!(signer.bearer(1001).unwrap(), first);
    }

    #[test]
    fn only_hex_tokens_and_clean_project_names_are_taken() {
        assert!(valid_token(TOKEN) && valid_token(&TOKEN.to_uppercase()));
        for bad in ["", "abc", &"a".repeat(31), &"a".repeat(201), &format!("{TOKEN}/../../x"), &format!("{} ", TOKEN), "zz".repeat(20).as_str(), "../../3/device/x"] {
            assert!(!valid_token(bad), "{bad:?}");
        }
        assert_eq!(clean_project("  lantern\u{7}\n "), "lantern");
        assert_eq!(clean_project(""), "Lantern");
        assert_eq!(clean_project(&"é".repeat(100)).chars().count(), PROJECT_MAX);
    }

    #[test]
    fn a_push_says_the_projects_name_a_state_and_when_the_turn_began_and_an_end_says_when_to_clear_it() {
        let update = payload("update", Status::NeedsYou, "lantern", 1_700_000_000_000, 1_700_000_100);
        assert_eq!(update["aps"]["event"], "update");
        assert_eq!(update["aps"]["timestamp"], 1_700_000_100u64);
        assert_eq!(update["aps"]["content-state"]["name"], ACTIVITY_NAME);
        assert!(update["aps"].get("dismissal-date").is_none());
        // An update says when the phone should take the card for one that isn't kept up to date any more; an end doesn't.
        assert_eq!(update["aps"]["stale-date"], 1_700_000_100u64 + STALE_AFTER_SECS);
        let props: Value = serde_json::from_str(update["aps"]["content-state"]["props"].as_str().unwrap()).unwrap();
        assert_eq!(props, json!({"project": "lantern", "status": "needs_you", "since": 1_700_000_000_000u64}));
        let end = payload("end", Status::Done, "lantern", 1, 1_700_000_100);
        assert_eq!(end["aps"]["dismissal-date"], 1_700_000_100 + DISMISS_AFTER_SECS);
        assert_eq!(end["aps"]["event"], "end");
        assert!(end["aps"].get("stale-date").is_none());
    }

    #[tokio::test]
    async fn a_card_follows_its_chat_through_working_needs_you_and_done_and_is_told_nothing_after() {
        let r = rig();
        r.card("phone-1", "a");
        r.event("a", asked()).await;
        r.event("a", resolved()).await;
        r.event("a", done(false)).await;
        // Nothing more is sent to a card that was ended, whatever the chat does.
        r.event("a", asked()).await;
        r.event("a", done(true)).await;
        let sent = r.sent();
        let shown: Vec<(&str, String, u8)> = sent.iter().map(|(_, p)| (p.event, props(p)["status"].as_str().unwrap().to_string(), p.priority)).collect();
        assert_eq!(shown, vec![("update", "needs_you".into(), 10), ("update", "working".into(), 5), ("end", "done".into(), 10)]);
        assert!(sent.iter().all(|(t, _)| t == TOKEN));
        assert!(r.store.live.cards()[0].1.ended);
    }

    #[tokio::test]
    async fn an_error_ends_the_card_as_failed() {
        let r = rig();
        r.card("phone-1", "a");
        r.event("a", done(true)).await;
        assert_eq!(props(&r.sent()[0].1)["status"], "failed");
        let r = rig();
        r.card("phone-1", "a");
        r.event("a", UiEvent::SessionEnded { code: Some(1), stderr_tail: String::new() }).await;
        assert_eq!(r.sent()[0].1.event, "end");
        let r = rig();
        r.card("phone-1", "a");
        r.event("a", UiEvent::SessionEnded { code: Some(0), stderr_tail: String::new() }).await;
        assert!(r.sent().is_empty(), "a session that closed cleanly isn't a failure");
    }

    #[tokio::test]
    async fn only_the_chat_a_card_is_for_moves_it_and_a_second_message_starts_the_timer_again() {
        let r = rig();
        r.card("phone-1", "a");
        r.event("b", asked()).await;
        r.event("b", done(false)).await;
        assert!(r.sent().is_empty());
        r.event("a", UiEvent::UserText { text: "SECRET MESSAGE".into(), at: None, sent_by: None, images: 0 }).await;
        let sent = r.sent();
        assert_eq!(props(&sent[0].1)["since"], clock());
        assert_eq!(sent[0].1.priority, 5);
    }

    #[tokio::test]
    async fn two_phones_each_get_their_own_cards_pushes() {
        let r = rig();
        r.card("phone-1", "a");
        r.store.live.register("phone-2", None, Some(LiveCard { slot: "a".into(), token: "f".repeat(64), project: "lantern".into(), since: 1, status: Status::Working, ended: false, registered_at: clock(), last_push: clock() }));
        r.event("a", asked()).await;
        let tokens: Vec<String> = r.sent().into_iter().map(|(t, _)| t).collect();
        assert_eq!(tokens.len(), 2);
        assert!(tokens.contains(&TOKEN.to_string()) && tokens.contains(&"f".repeat(64)));
    }

    #[tokio::test]
    async fn a_card_that_finds_its_turn_already_over_when_it_registers_is_ended_at_once() {
        let r = rig();
        r.hub.opened("a", "/p/lantern");
        r.event("a", UiEvent::UserText { text: "go".into(), at: None, sent_by: None, images: 0 }).await;
        r.event("a", done(false)).await;
        r.card("phone-1", "a");
        r.service.reconcile().await;
        assert_eq!(r.sent().len(), 1);
        assert_eq!((r.sent()[0].1.event, props(&r.sent()[0].1)["status"].clone()), ("end", json!("done")));
        // A chat that is still working is left to the card's own first state.
        let r = rig();
        r.hub.opened("a", "/p/lantern");
        r.event("a", UiEvent::UserText { text: "go".into(), at: None, sent_by: None, images: 0 }).await;
        r.card("phone-1", "a");
        r.service.reconcile().await;
        assert!(r.sent().is_empty());
    }

    #[tokio::test]
    async fn nothing_goes_while_remote_control_is_off_and_a_card_over_eight_hours_old_is_dropped() {
        let r = rig();
        r.card("phone-1", "a");
        r.store.set_enabled(false).unwrap();
        r.event("a", asked()).await;
        assert!(r.sent().is_empty());
        r.store.set_enabled(true).unwrap();
        r.store.live.edit("phone-1", |c| c.registered_at = clock() - CARD_LIFETIME_MS - 1);
        r.event("a", asked()).await;
        assert!(r.sent().is_empty() && r.store.live.cards().is_empty());
    }

    #[tokio::test]
    async fn a_card_apple_says_is_gone_is_forgotten_and_other_refusals_are_shown_in_settings_without_the_token() {
        let r = rig();
        r.card("phone-1", "a");
        *r.outbox.answer.lock().unwrap() = Some(Ok(Reply { status: 403, reason: Some("InvalidProviderToken".into()) }));
        r.event("a", asked()).await;
        assert_eq!(r.store.live.cards().len(), 1, "a refusal of the key says nothing about the card");
        let said = r.store.live.last.lock().unwrap().clone().unwrap();
        assert!(said.contains("403") && said.contains("InvalidProviderToken") && !said.contains(TOKEN), "{said}");
        *r.outbox.answer.lock().unwrap() = Some(Ok(Reply { status: 410, reason: Some("Unregistered".into()) }));
        r.event("a", asked()).await;
        assert!(r.store.live.cards().is_empty());
        let r = rig();
        r.card("phone-1", "a");
        *r.outbox.answer.lock().unwrap() = Some(Err("no network".into()));
        r.event("a", asked()).await;
        assert_eq!(r.store.live.last.lock().unwrap().as_deref(), Some("no network"));
        assert_eq!(r.store.live.cards().len(), 1, "a push that didn't get through leaves the card as it was");
    }

    #[tokio::test]
    async fn a_card_nothing_has_happened_to_for_a_while_is_pushed_again_so_it_isnt_taken_for_stale() {
        let r = rig();
        r.card("phone-1", "a");
        // Just pushed to: left be. A card that is over: left be.
        r.store.live.edit("phone-1", |c| c.last_push = clock() - REFRESH_AFTER_MS + 1);
        r.service.heartbeat().await;
        assert!(r.sent().is_empty());
        // Due: pushed in the state it is in, with a new stale date.
        r.store.live.edit("phone-1", |c| c.last_push = clock() - REFRESH_AFTER_MS);
        r.service.heartbeat().await;
        let sent = r.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!((sent[0].1.event, props(&sent[0].1)["status"].clone(), sent[0].1.priority), ("update", json!("working"), 5));
        assert_eq!(sent[0].1.body["aps"]["stale-date"], clock() / 1000 + STALE_AFTER_SECS);
        assert_eq!(r.store.live.cards()[0].1.last_push, clock());
        // Pushed just now, so not again.
        r.service.heartbeat().await;
        assert_eq!(r.sent().len(), 1);
        r.store.live.edit("phone-1", |c| {
            c.last_push = 0;
            c.ended = true;
        });
        r.service.heartbeat().await;
        assert_eq!(r.sent().len(), 1, "a card that is over isn't refreshed");
    }

    #[tokio::test]
    async fn the_same_card_said_again_is_the_same_card_but_another_token_starts_over() {
        let r = rig();
        r.card("phone-1", "a");
        r.event("a", done(false)).await;
        assert_eq!(r.sent().len(), 1);
        // The phone says the card again when it reconnects: what the Mac knows of it (it ended) is kept, so nothing is sent again.
        r.card("phone-1", "a");
        assert!(r.store.live.cards()[0].1.ended);
        r.event("a", asked()).await;
        assert_eq!(r.sent().len(), 1);
        // A card with a token of its own is a new card.
        r.store.live.register("phone-1", None, Some(LiveCard { slot: "a".into(), token: "e".repeat(64), project: "lantern".into(), since: 1, status: Status::Working, ended: false, registered_at: clock(), last_push: clock() }));
        assert!(!r.store.live.cards()[0].1.ended);
        r.event("a", asked()).await;
        assert_eq!(r.sent().len(), 2);
    }

    #[tokio::test]
    async fn settings_says_when_apple_took_an_update_so_an_old_refusal_isnt_left_standing() {
        let r = rig();
        r.card("phone-1", "a");
        *r.outbox.answer.lock().unwrap() = Some(Ok(Reply { status: 403, reason: Some("InvalidProviderToken".into()) }));
        r.event("a", asked()).await;
        assert!(r.store.live.last.lock().unwrap().clone().unwrap().contains("403"));
        // The card stayed as it was (a refused key says nothing about it), so the same event is sent again, and taken.
        *r.outbox.answer.lock().unwrap() = None;
        r.event("a", asked()).await;
        assert_eq!(r.store.live.last.lock().unwrap().as_deref(), Some("Apple accepted the last update."));
    }

    #[tokio::test]
    async fn the_same_state_is_not_pushed_twice() {
        let r = rig();
        r.card("phone-1", "a");
        r.event("a", asked()).await;
        r.event("a", asked()).await;
        assert_eq!(r.sent().len(), 1);
    }

    #[tokio::test]
    async fn no_push_says_anything_a_lock_screen_shouldnt() {
        let r = rig();
        r.card("phone-1", "a");
        r.event("a", asked()).await;
        r.event("a", UiEvent::UserText { text: "my password is hunter2".into(), at: None, sent_by: None, images: 0 }).await;
        r.event("a", done(false)).await;
        for (_, push) in r.sent() {
            let text = push.body.to_string();
            for secret in ["rm -rf", "secrets", "hunter2", "SECRET", "Bash", "SECRET-RESULT"] {
                assert!(!text.contains(secret), "{secret} in {text}");
            }
        }
    }
}
