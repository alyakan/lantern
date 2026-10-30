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
/// The app's bundle id: the topic of an ordinary notification.
pub const BUNDLE_ID: &str = "com.alyakan.lantern";
/// Where a push to a broadcast channel goes (a card the Mac started on a phone listens to its channel, not a token of its own).
pub const BROADCAST_URL: &str = "https://api.push.apple.com/4/broadcasts/apps/com.alyakan.lantern";
/// Where broadcast channels are made and deleted.
pub const CHANNELS_URL: &str = "https://api-manage-broadcast.push.apple.com:2196/1/apps/com.alyakan.lantern/channels";
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
/// The longest a chat's title on a card is, in characters.
const TITLE_MAX: usize = 60;
/// How often a card is pushed to for what only moves its numbers (the plan's progress, how much of the usage window is
/// gone): a push of a status change is always sent at once. Apple limits pushes at low priority, and a number that moves a
/// few times a minute isn't worth a push each.
const DETAIL_EVERY_MS: u64 = 45 * 1000;

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

/// What a chat that needs you is asking for, in one word: never the command, the file or the question itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Needs {
    Command,
    Edit,
    Question,
    Approval,
    Tool,
}

impl Needs {
    pub fn as_str(self) -> &'static str {
        match self {
            Needs::Command => "command",
            Needs::Edit => "edit",
            Needs::Question => "question",
            Needs::Approval => "approval",
            Needs::Tool => "tool",
        }
    }

    /// What a prompt for this tool is asking for.
    pub fn of_tool(tool: &str) -> Self {
        match tool {
            "Bash" | "BashOutput" | "KillShell" => Needs::Command,
            "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => Needs::Edit,
            "AskUserQuestion" => Needs::Question,
            "mcp__lantern__request_approval" | "ExitPlanMode" => Needs::Approval,
            _ => Needs::Tool,
        }
    }
}

/// What a card says besides the project and the state: the chat's title, how far its plan has got, what it is asking for and how
/// much of the plan's usage window is gone. Every part may be missing (a Mac that has none of it, a chat with no plan), and a
/// phone's layout copes with each being absent. Never Claude's words, a command, a file or a question: only counts, one word, and
/// the chat's own title, which the user chose to put on a lock screen.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Detail {
    pub title: Option<String>,
    /// Steps done and steps in all, of the plan Claude is keeping.
    pub steps: Option<(u32, u32)>,
    pub needs: Option<Needs>,
    /// How much of the plan's five-hour window is used, 0 to 100.
    pub plan: Option<u8>,
}

/// A chat's title as it may appear on a lock screen: one line, no control characters, not long; None when nothing is left.
pub fn clean_title(title: &str) -> Option<String> {
    let one_line: String = title.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let squeezed = one_line.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = squeezed.chars().take(TITLE_MAX).collect();
    (!cut.is_empty()).then_some(cut)
}

/// Whether `token` could be a push token: hex, of a length Apple's tokens have. (It goes into a URL.)
pub fn valid_token(token: &str) -> bool {
    (32..=200).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Whether `channel` could be Apple's id for a broadcast channel: base64, not long. (It comes back from Apple in a header and
/// goes into one, and onto disk.)
pub fn valid_channel(channel: &str) -> bool {
    (8..=128).contains(&channel.len()) && channel.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
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
    /// What the chat is asking for now, from the prompt that made it need you.
    pub needs: Option<Needs>,
    /// What the card shows besides the project and state, as it was last pushed.
    pub detail: Detail,
    /// A summary card (a phone that asked for one, of a Mac that lists "livesummary"): about every chat, not `slot`'s.
    pub summary: Option<SummaryState>,
    /// A card this Mac started on the phone (by push, while the app was closed): it is updated through this broadcast channel,
    /// since Apple gives the Mac no token of its own for it. `token` is empty.
    pub channel: Option<String>,
}

/// How many chats a summary card lists; the rest are only counted. A card's push is at most 4 KB.
pub const SUMMARY_ROWS: usize = 3;
/// The longest a chat's title is on a summary card's row, in characters.
const ROW_TITLE_MAX: usize = 40;
/// How long nothing has to be working or waiting before a summary card is ended: a queued message starts the next turn a
/// moment after the last one ends, and that is not the end of the card.
pub const SUMMARY_END_AFTER_MS: u64 = 60 * 1000;
/// How often summary cards are looked at for one whose quiet spell is long enough to end it.
const SUMMARY_CHECK: Duration = Duration::from_secs(20);
/// How long chats have to be working or waiting, with no card on a phone, before the Mac starts one there itself: a phone
/// with the app in front starts its own a moment after a chat starts, and that one is better (it needs no alert).
pub const START_AFTER_MS: u64 = 8 * 1000;
/// How often the Mac looks for a phone that should have a card and has none.
const START_CHECK: Duration = Duration::from_secs(3);
/// The least time between two cards the Mac starts on one phone: each start comes with an alert.
pub const START_EVERY_MS: u64 = 15 * 60 * 1000;
/// How long after a start that couldn't reach Apple it is tried again.
const START_RETRY_MS: u64 = 60 * 1000;

/// What a summary card keeps between pushes.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SummaryState {
    /// The chats whose turn ended while the card was up, and how (Done or Failed), oldest first.
    pub finished: Vec<(String, Status)>,
    /// When each chat's turn began, as the card saw it (ms since the epoch).
    pub started: HashMap<String, u64>,
    /// What was last pushed: a push that would change nothing is not sent.
    pub last_props: Option<String>,
    /// How many chats needed you then: one more is pushed at once and wakes the screen.
    pub last_needs: usize,
    /// Since when nothing has been working or waiting (ms): after SUMMARY_END_AFTER_MS of it the card is ended.
    pub idle_since: Option<u64>,
}

/// One chat on a summary card.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub project: String,
    pub title: Option<String>,
    pub status: Status,
    /// When its turn began, for one that is working (the card's timer counts from it).
    pub since: Option<u64>,
}

/// What a summary card shows: the state it is in as a whole, its rows, and how many chats are in each state.
#[derive(Debug, Clone, PartialEq)]
pub struct Summary {
    pub status: Status,
    pub rows: Vec<Row>,
    pub needs_you: usize,
    pub working: usize,
    pub done: usize,
    pub failed: usize,
    /// When the oldest working turn began (ms): the card's own timer.
    pub since: u64,
}

impl Summary {
    /// Something is working or waits for you: the card stays up. Otherwise it is ended, showing what finished.
    pub fn active(&self) -> bool {
        self.needs_you + self.working > 0
    }

    /// The card's data, as the phone's layout reads it (a JSON string inside the push: `props`).
    pub fn props(&self) -> String {
        let rows: Vec<Value> = self
            .rows
            .iter()
            .map(|r| {
                let mut row = json!({"project": r.project, "status": r.status.as_str()});
                if let Some(t) = &r.title {
                    row["title"] = json!(t);
                }
                if let Some(since) = r.since {
                    row["since"] = json!(since);
                }
                row
            })
            .collect();
        json!({
            "project": "Lantern",
            "status": self.status.as_str(),
            "since": self.since,
            "chats": rows,
            "counts": {"needs_you": self.needs_you, "working": self.working, "done": self.done, "failed": self.failed},
        })
        .to_string()
    }
}

/// A project's name from a chat's folder: its last part, as the lock screen may show it.
fn project_of(folder: Option<&str>) -> String {
    clean_project(&folder.and_then(|f| std::path::Path::new(f).file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
}

/// What a phone has told the Mac about its Live Activities.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LiveState {
    /// The phone's token for starting a card by push (kept for when a card may be started from the Mac).
    pub start_token: Option<String>,
    pub card: Option<LiveCard>,
    /// The tokens of the phone's own cards the Mac has let go of (one it started took their place, or Apple said they were
    /// gone), newest last: a phone woken in the background says its old card again, and that is no card at all.
    pub spent: Vec<String>,
}

/// How many let-go tokens are remembered for each phone.
const SPENT_KEPT: usize = 8;

impl LiveState {
    fn spend(&mut self, card: Option<&LiveCard>) {
        if let Some(c) = card.filter(|c| c.channel.is_none() && !c.token.is_empty()) {
            self.spent.retain(|t| *t != c.token);
            self.spent.push(c.token.clone());
            let extra = self.spent.len().saturating_sub(SPENT_KEPT);
            self.spent.drain(..extra);
        }
    }
}

/// Every phone's Live Activity state, in memory only: a phone says it again each time it connects, and a card's token is
/// no use for long. `changed` wakes the service when a phone has registered a card, so that a turn that already ended
/// is shown as ended.
#[derive(Default)]
pub struct LiveBook {
    states: Mutex<HashMap<String, LiveState>>,
    /// Cards this Mac started that a phone's own card has replaced: each is ended (at once) the next time the service looks.
    retired: Mutex<Vec<LiveCard>>,
    pub changed: Notify,
    /// What Apple last answered, for Settings (never a token, a payload or the key).
    pub last: Mutex<Option<String>>,
}

impl LiveBook {
    /// A phone's whole Live Activity state: replaces what it said before. True when the card it names is one the Mac has
    /// already let go of (it is over, whatever the phone thinks): what the Mac follows is left as it was.
    pub fn register(&self, device: &str, start_token: Option<String>, card: Option<LiveCard>) -> bool {
        let mut states = self.states.lock().unwrap();
        let spent = states.get(device).map(|s| s.spent.clone()).unwrap_or_default();
        if card.as_ref().is_some_and(|c| c.channel.is_none() && spent.contains(&c.token)) {
            return true;
        }
        // The same card said again (a phone does, each time it connects) is the card the Mac already follows: what it knows
        // of where it stands is kept, rather than started over (and an end it already sent sent again).
        let old = states.get(device).and_then(|s| s.card.clone());
        let card = match (card, old.as_ref()) {
            (Some(new), Some(old)) if new.slot == old.slot && new.token == old.token && new.summary.is_some() == old.summary.is_some() => Some(old.clone()),
            // A card this Mac started is one the phone can't know of: a phone that says it shows none leaves it be.
            (None, Some(old)) if old.channel.is_some() && !old.ended => Some(old.clone()),
            (new, _) => new,
        };
        // The phone put up its own card in place of one this Mac started: that one is ended, so the two aren't both on screen.
        if let Some(old) = old.filter(|o| o.channel.is_some() && !o.ended) {
            if card.as_ref().is_some_and(|c| c.channel.is_none()) {
                self.retired.lock().unwrap().push(old);
            }
        }
        states.insert(device.to_string(), LiveState { start_token, card, spent });
        drop(states);
        self.changed.notify_one();
        false
    }

    pub fn forget(&self, device: &str) {
        self.states.lock().unwrap().remove(device);
    }

    /// A card this Mac started on a phone: kept as the phone's card, with what the phone said before.
    fn put(&self, device: &str, card: LiveCard) {
        let mut states = self.states.lock().unwrap();
        let state = states.entry(device.to_string()).or_default();
        let old = state.card.replace(card);
        state.spend(old.as_ref());
    }

    fn take_retired(&self) -> Vec<LiveCard> {
        std::mem::take(&mut *self.retired.lock().unwrap())
    }

    pub fn cards(&self) -> Vec<(String, LiveCard)> {
        self.states.lock().unwrap().iter().filter_map(|(d, s)| s.card.clone().map(|c| (d.clone(), c))).collect()
    }

    pub fn state(&self, device: &str) -> Option<LiveState> {
        self.states.lock().unwrap().get(device).cloned()
    }

    pub(crate) fn edit(&self, device: &str, f: impl FnOnce(&mut LiveCard)) {
        if let Some(card) = self.states.lock().unwrap().get_mut(device).and_then(|s| s.card.as_mut()) {
            f(card);
        }
    }

    fn drop_card(&self, device: &str) {
        if let Some(s) = self.states.lock().unwrap().get_mut(device) {
            let old = s.card.take();
            s.spend(old.as_ref());
        }
    }

    pub(crate) fn said(&self, what: String) {
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
    pub fn ok(&self) -> bool {
        self.status == 200
    }

    /// The card or the phone is gone (Apple answers 410, or 400 BadDeviceToken / 404 for a token it doesn't know).
    pub fn gone(&self) -> bool {
        self.status == 410 || self.status == 404 || (self.status == 400 && matches!(self.reason.as_deref(), Some("BadDeviceToken" | "DeviceTokenNotForTopic")))
    }

    /// The broadcast channel is gone (Apple doesn't know it, or it was deleted): a new one is made for the next card.
    pub fn channel_gone(&self) -> bool {
        self.status == 410 || self.status == 404 || (self.status == 400 && matches!(self.reason.as_deref(), Some("BadChannelId" | "ChannelNotRegistered")))
    }

    fn words(&self) -> String {
        match &self.reason {
            Some(r) => format!("Apple answered {} ({r}).", self.status),
            None => format!("Apple answered {}.", self.status),
        }
    }
}

/// One ordinary notification (an alert), straight to Apple: its whole body, `aps` and the data the app reads.
#[derive(Debug, Clone, PartialEq)]
pub struct Alert {
    pub body: Value,
}

pub trait Apns: Send + Sync + 'static {
    /// A push to a card's own token, or (an event of "start") to the phone's token for starting one.
    fn send(&self, token: &str, push: &Push) -> BoxFut<Result<Reply, String>>;
    /// A notification for the phone itself (not a card): see notifier.rs.
    fn alert(&self, token: &str, alert: &Alert) -> BoxFut<Result<Reply, String>>;
    /// A push to every card listening to a broadcast channel (the cards this Mac started).
    fn broadcast(&self, _channel: &str, _push: &Push) -> BoxFut<Result<Reply, String>> {
        Box::pin(async { Err("Broadcast channels aren't supported here.".to_string()) })
    }
    /// A new broadcast channel: Apple's id for it.
    fn create_channel(&self) -> BoxFut<Result<String, String>> {
        Box::pin(async { Err("Broadcast channels aren't supported here.".to_string()) })
    }
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

/// How long Apple keeps an alert it couldn't deliver (a phone that is off): a prompt that waited longer is probably answered.
const ALERT_KEEP_SECS: u64 = 10 * 60;

impl ApnsHttp {
    /// One push: `kind` is Apple's push type, `topic` the app's (with the suffix a card's pushes take), and `expiration` when
    /// Apple may stop trying to deliver it (none: it keeps Apple's default).
    fn post(&self, token: &str, kind: &'static str, topic: &'static str, priority: u8, expiration: Option<u64>, body: Value) -> BoxFut<Result<Reply, String>> {
        let mut headers = vec![("apns-topic", topic.to_string())];
        if let Some(at) = expiration {
            headers.push(("apns-expiration", at.to_string()));
        }
        self.post_to(format!("{APNS_URL}{token}"), kind, kind, priority, headers, body)
    }

    /// One push to `url`: `kind` is what the log calls it, `push_type` Apple's header for it.
    fn post_to(&self, url: String, kind: &'static str, push_type: &'static str, priority: u8, headers: Vec<(&'static str, String)>, body: Value) -> BoxFut<Result<Reply, String>> {
        let client = self.client.clone();
        let signer = self.key.signer();
        Box::pin(async move {
            let answer = Self::deliver(client, signer, url, push_type, priority, headers, body).await;
            // Never the token (a send error carries the address it went to) or anything of the body.
            match &answer {
                Ok(reply) => super::push_log::note(&format!("apple {kind} priority {priority}: {}", reply.words())),
                Err(why) => super::push_log::note(&format!("apple {kind} priority {priority}: not sent, {why}")),
            }
            answer
        })
    }

    async fn deliver(client: reqwest::Client, signer: Result<Option<Arc<Signer>>, String>, url: String, push_type: &'static str, priority: u8, headers: Vec<(&'static str, String)>, body: Value) -> Result<Reply, String> {
        let signer = signer?.ok_or("No push key has been imported (Settings > Remote control).")?;
        let mut request = client
            .post(url)
            .header("authorization", format!("bearer {}", signer.bearer(now_secs())?))
            .header("apns-push-type", push_type)
            .header("apns-priority", priority.to_string());
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let response = request.json(&body).send().await.map_err(failed)?;
        let status = response.status().as_u16();
        let reason = response.json::<Value>().await.ok().and_then(|b| b["reason"].as_str().map(str::to_string));
        Self::refused(&signer, status, reason.as_deref());
        Ok(Reply { status, reason })
    }

    /// A signed token Apple refused isn't used again: the next push makes a new one.
    fn refused(signer: &Signer, status: u16, reason: Option<&str>) {
        if status == 403 && matches!(reason, Some("ExpiredProviderToken" | "InvalidProviderToken")) {
            signer.forget_bearer();
        }
    }
}

/// What went wrong reaching Apple, in words (never the address it went to: it can carry a token).
fn failed(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "Apple did not answer in time.".to_string()
    } else if e.is_connect() {
        "Couldn't reach Apple.".to_string()
    } else {
        "The push to Apple failed.".to_string()
    }
}

impl Apns for ApnsHttp {
    fn send(&self, token: &str, push: &Push) -> BoxFut<Result<Reply, String>> {
        self.post(token, "liveactivity", TOPIC, push.priority, None, push.body.clone())
    }

    fn alert(&self, token: &str, alert: &Alert) -> BoxFut<Result<Reply, String>> {
        self.post(token, "alert", BUNDLE_ID, 10, Some(now_secs() + ALERT_KEEP_SECS), alert.body.clone())
    }

    fn broadcast(&self, channel: &str, push: &Push) -> BoxFut<Result<Reply, String>> {
        // Apple keeps the latest push on the channel (see create_channel) for a phone that was offline when it was sent, and
        // wants to be told until when: as long as the card would show it before going stale.
        let headers = vec![("apns-channel-id", channel.to_string()), ("apns-expiration", (now_secs() + STALE_AFTER_SECS).to_string())];
        self.post_to(BROADCAST_URL.to_string(), "broadcast", "Liveactivity", push.priority, headers, push.body.clone())
    }

    fn create_channel(&self) -> BoxFut<Result<String, String>> {
        let client = self.client.clone();
        let signer = self.key.signer();
        Box::pin(async move {
            let answer = async {
                let signer = signer?.ok_or("No push key has been imported (Settings > Remote control).")?;
                let response = client
                    .post(CHANNELS_URL)
                    .header("authorization", format!("bearer {}", signer.bearer(now_secs())?))
                    // 1: Apple keeps the most recent push, so a phone that was offline still gets the card's latest state.
                    .json(&json!({"message-storage-policy": 1, "push-type": "LiveActivity"}))
                    .send()
                    .await
                    .map_err(failed)?;
                let status = response.status().as_u16();
                let channel = response.headers().get("apns-channel-id").and_then(|v| v.to_str().ok()).map(str::to_string);
                let reason = response.json::<Value>().await.ok().and_then(|b| b["reason"].as_str().map(str::to_string));
                Self::refused(&signer, status, reason.as_deref());
                match channel {
                    Some(c) if (200..300).contains(&status) && valid_channel(&c) => Ok(c),
                    _ => Err(format!("Apple didn't make a channel: {}", Reply { status, reason }.words())),
                }
            }
            .await;
            match &answer {
                Ok(_) => super::push_log::note("apple channel: made"),
                Err(why) => super::push_log::note(&format!("apple channel: {why}")),
            }
            answer
        })
    }
}

impl ApnsHttp {
    /// Deletes a broadcast channel (for the test that makes one against Apple, so it leaves none behind).
    pub async fn delete_channel(&self, channel: &str) -> Result<u16, String> {
        let signer = self.key.signer()?.ok_or("No push key has been imported.")?;
        let response = self
            .client
            .delete(CHANNELS_URL)
            .header("authorization", format!("bearer {}", signer.bearer(now_secs())?))
            .header("apns-channel-id", channel)
            .send()
            .await
            .map_err(failed)?;
        Ok(response.status().as_u16())
    }
}

/// The card's data, as the phone's layout reads it (a JSON string inside the push: `props`).
fn props_json(project: &str, status: Status, since: u64, detail: &Detail) -> String {
    let mut props = json!({"project": project, "status": status.as_str(), "since": since});
    if let Some(title) = &detail.title {
        props["title"] = json!(title);
    }
    if let Some((done, total)) = detail.steps {
        props["steps_done"] = json!(done);
        props["steps_total"] = json!(total);
    }
    if let Some(needs) = detail.needs {
        props["needs"] = json!(needs.as_str());
    }
    if let Some(plan) = detail.plan {
        props["plan"] = json!(plan);
    }
    props.to_string()
}

/// The body of a push to a card: `event` ("update" or "end"), what it shows, and for an end when the phone should clear it.
pub fn payload(event: &str, status: Status, project: &str, since: u64, now: u64) -> Value {
    payload_with(event, status, project, since, now, &Detail::default())
}

/// The same, with what the card shows besides the project and state.
pub fn payload_with(event: &str, status: Status, project: &str, since: u64, now: u64, detail: &Detail) -> Value {
    payload_of(event, props_json(project, status, since, detail), now)
}

/// The body of the push that starts a card on a phone (its push-to-start token): the summary it shows, the channel it is
/// updated through from then on, and the alert iOS insists a start comes with (no sound, and only counts: never a chat's name).
pub fn start_payload(props: String, channel: &str, words: &str, now: u64) -> Value {
    json!({"aps": {
        "timestamp": now,
        "event": "start",
        "content-state": {"name": ACTIVITY_NAME, "props": props},
        "attributes-type": ATTRIBUTES_TYPE,
        "attributes": {},
        "input-push-channel": channel,
        "stale-date": now + STALE_AFTER_SECS,
        "alert": {"title": "Lantern", "body": words},
    }})
}

/// What a card's start says: how many chats need you, else how many are working.
fn start_words(summary: &Summary) -> String {
    match (summary.needs_you, summary.working) {
        (1, _) => "A chat needs you".into(),
        (n, _) if n > 1 => format!("{n} chats need you"),
        (_, 1) => "A chat is working".into(),
        (_, n) if n > 1 => format!("{n} chats are working"),
        _ => "Your chats".into(),
    }
}

/// The body of a push to a card, from the props it shows.
fn payload_of(event: &str, props: String, now: u64) -> Value {
    let mut aps = json!({
        "timestamp": now,
        "event": event,
        "content-state": {"name": ACTIVITY_NAME, "props": props},
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
    /// Since when some chat has been working or waiting (ms), without a break: a spell of work.
    busy_since: Mutex<Option<u64>>,
    /// The spell of work each phone was last started a card for: one start a spell, so a card that ended (or that Apple
    /// refused) isn't started over and over, each with its alert.
    started_for: Mutex<HashMap<String, u64>>,
    /// When each phone was last tried (ms): a start Apple couldn't be reached for is tried again a while later, and one
    /// that went through is the last for a while (each comes with an alert that lights the screen).
    tried: Mutex<HashMap<String, (u64, bool)>>,
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
    /// Only what the card shows besides its state has moved (the plan's steps, the usage): pushed no more often than
    /// DETAIL_EVERY_MS, and only if it changed.
    Detail,
}

impl LiveActivities {
    pub fn new(store: Arc<RemoteStore>, hub: Arc<SessionHub>, apns: Arc<dyn Apns>) -> Arc<Self> {
        Self::with_clock(store, hub, apns, super::now_ms)
    }

    fn with_clock(store: Arc<RemoteStore>, hub: Arc<SessionHub>, apns: Arc<dyn Apns>, now_ms: fn() -> u64) -> Arc<Self> {
        Arc::new(Self { store, hub, apns, now_ms, busy_since: Mutex::new(None), started_for: Mutex::new(HashMap::new()), tried: Mutex::new(HashMap::new()) })
    }

    /// Follows the bus until it closes (the task `start_remote` runs and `stop` aborts), and looks again at the cards
    /// whenever a phone registers one.
    pub async fn run(self: Arc<Self>, bus: Arc<EventBus>) {
        let mut events = bus.subscribe();
        let mut beat = tokio::time::interval(HEARTBEAT);
        let mut quiet = tokio::time::interval(SUMMARY_CHECK);
        let mut start = tokio::time::interval(START_CHECK);
        loop {
            tokio::select! {
                _ = beat.tick() => self.heartbeat().await,
                _ = quiet.tick() => self.end_quiet_summaries().await,
                _ = start.tick() => self.start_cards().await,
                ev = events.recv() => match ev {
                    Ok(ev) => self.handle(&ev).await,
                    // Behind: events were missed (a turn's end among them, perhaps), so the cards are brought right with the chats now.
                    Err(broadcast::error::RecvError::Lagged(_)) => self.settle().await,
                    Err(broadcast::error::RecvError::Closed) => return,
                },
                _ = self.store.live.changed.notified() => self.reconcile().await,
            }
        }
    }

    /// The state a chat is in now: when its card is shown for the first time (a quick turn may be over before the phone had
    /// the card's token to hand over), and whenever a card may have missed something.
    fn current(&self, slot: &str) -> Option<Next> {
        match self.hub.chat(slot)?.status {
            ChatStatus::NeedsYou => Some(Next::Update(Status::NeedsYou)),
            ChatStatus::Idle | ChatStatus::Asleep => Some(Next::End(Status::Done)),
            ChatStatus::Ended => Some(Next::End(Status::Failed)),
            // The card was started as Working; a card that says anything else is brought back to it.
            ChatStatus::Working => Some(Next::Update(Status::Working)),
        }
    }

    /// Pushes again to each card that is live and hasn't had one for a while, so it stays fresh while this Mac is awake (and
    /// goes stale on the phone, as it should, when the Mac is not).
    async fn heartbeat(&self) {
        // Before it is refreshed in the state it is in, a card is checked against its chat: a push that didn't get through, or an
        // event that was missed, would otherwise be kept up to date as Working for as long as the card lives.
        self.settle().await;
        let now = (self.now_ms)();
        for (device, card) in self.store.live.cards() {
            if !card.ended && now.saturating_sub(card.last_push) >= REFRESH_AFTER_MS {
                if card.summary.is_some() {
                    self.push_summary(&device, true).await;
                } else {
                    self.push(&device, Next::Refresh).await;
                }
            }
        }
    }

    /// Brings each live card to the state its chat is in now (nothing is sent to one that already says it).
    async fn settle(&self) {
        if !self.store.saved().enabled {
            return;
        }
        for (device, card) in self.store.live.cards() {
            if card.ended {
                continue;
            }
            if card.summary.is_some() {
                self.push_summary(&device, false).await;
                continue;
            }
            if let Some(next) = self.current(&card.slot) {
                self.push(&device, next).await;
            }
        }
    }

    async fn reconcile(&self) {
        self.end_retired().await;
        self.settle().await;
    }

    /// Ends, at once, each card this Mac started that a phone's own card has replaced.
    async fn end_retired(&self) {
        let now = (self.now_ms)();
        for card in self.store.live.take_retired() {
            let Some(channel) = card.channel.as_deref() else { continue };
            let props = card.summary.as_ref().and_then(|s| s.last_props.clone()).unwrap_or_else(|| self.summary_for(&card).props());
            let mut body = payload_of("end", props, now / 1000);
            body["aps"]["dismissal-date"] = json!(now / 1000);
            let push = Push { event: "end", priority: 5, body };
            match self.apns.broadcast(channel, &push).await {
                Ok(reply) if reply.ok() => {}
                Ok(reply) => self.store.live.said(reply.words()),
                Err(e) => self.store.live.said(e),
            }
        }
    }

    /// Puts a card on each phone that can have one started by push and has none, once chats have been working or waiting for
    /// START_AFTER_MS: the phone with the app closed (or away) can't start one itself. One start a spell of work.
    pub(crate) async fn start_cards(&self) {
        let saved = self.store.saved();
        if !saved.enabled {
            return;
        }
        let now = (self.now_ms)();
        let busy = self.hub.chats().iter().any(|c| matches!(c.status, ChatStatus::Working | ChatStatus::NeedsYou));
        let since = {
            let mut at = self.busy_since.lock().unwrap();
            if !busy {
                *at = None;
                return;
            }
            *at.get_or_insert(now)
        };
        if now.saturating_sub(since) < START_AFTER_MS {
            return;
        }
        for device in saved.devices {
            let Some(start_token) = device.start_token.clone() else { continue };
            let up = self.store.live.state(&device.id).and_then(|s| s.card).is_some_and(|c| !c.ended && now.saturating_sub(c.registered_at) <= CARD_LIFETIME_MS);
            let done_this_spell = self.started_for.lock().unwrap().get(&device.id) == Some(&since);
            let too_soon = self.tried.lock().unwrap().get(&device.id).is_some_and(|&(at, started)| now.saturating_sub(at) < if started { START_EVERY_MS } else { START_RETRY_MS });
            if up || done_this_spell || too_soon {
                continue;
            }
            let answer = self.start_card(&device, &start_token, now).await;
            self.tried.lock().unwrap().insert(device.id.clone(), (now, answer == Some(true)));
            // Apple answered (yes or no): that is this spell's start. Not reached: tried again after START_RETRY_MS.
            if answer.is_some() {
                self.started_for.lock().unwrap().insert(device.id.clone(), since);
            }
        }
    }

    /// Starts a card on a phone: Some(true) when Apple took it, Some(false) when it refused, None when it couldn't be asked.
    async fn start_card(&self, device: &super::pairing::Device, start_token: &str, now: u64) -> Option<bool> {
        let channel = match device.live_channel.clone() {
            Some(c) => c,
            None => match self.apns.create_channel().await {
                Ok(c) => {
                    if let Err(e) = self.store.set_live_channel(&device.id, Some(&c)) {
                        self.store.live.said(e);
                    }
                    c
                }
                Err(e) => {
                    self.store.live.said(e);
                    return None;
                }
            },
        };
        let mut card = LiveCard { slot: String::new(), token: String::new(), project: "Lantern".into(), since: now, status: Status::Working, ended: false, registered_at: now, last_push: now, needs: None, detail: Detail::default(), summary: Some(SummaryState::default()), channel: Some(channel.clone()) };
        let summary = self.summary_for(&card);
        let props = summary.props();
        let push = Push { event: "start", priority: 10, body: start_payload(props.clone(), &channel, &start_words(&summary), now / 1000) };
        match self.apns.send(start_token, &push).await {
            Ok(reply) if reply.ok() => {
                self.store.live.said("Apple accepted the start of a card.".into());
                card.status = summary.status;
                card.since = summary.since;
                if let Some(s) = card.summary.as_mut() {
                    s.last_props = Some(props);
                    s.last_needs = summary.needs_you;
                }
                self.store.live.put(&device.id, card);
                Some(true)
            }
            Ok(reply) => {
                self.store.live.said(reply.words());
                // The phone's token for starting cards is no good any more: it says a new one when it next connects.
                if reply.gone() {
                    let _ = self.store.set_start_token(&device.id, None);
                }
                Some(false)
            }
            Err(e) => {
                self.store.live.said(e);
                None
            }
        }
    }

    /// A push to a card: through its channel (one this Mac started), or to its own token.
    fn send_card(&self, card: &LiveCard, push: &Push) -> BoxFut<Result<Reply, String>> {
        match card.channel.as_deref() {
            Some(channel) => self.apns.broadcast(channel, push),
            None => self.apns.send(&card.token, push),
        }
    }

    /// Apple refused a push to a card: a card (or a channel) it says is gone is forgotten.
    fn refused(&self, device: &str, card: &LiveCard, reply: &Reply) {
        self.store.live.said(reply.words());
        if card.channel.is_some() {
            if reply.channel_gone() {
                let _ = self.store.set_live_channel(device, None);
                self.store.live.drop_card(device);
            }
        } else if reply.gone() {
            self.store.live.drop_card(device);
        }
    }

    fn next_for(&self, slot: &str, ev: &UiEvent) -> Option<Next> {
        match ev {
            UiEvent::PermissionRequested { .. } | UiEvent::MergeProposed { .. } => Some(Next::Update(Status::NeedsYou)),
            // Nothing waits any more (answered anywhere, or withdrawn): Claude is on with it.
            UiEvent::PermissionResolved { .. } | UiEvent::PermissionWithdrawn { .. } | UiEvent::MergeResolved { .. } => {
                (self.hub.chat(slot).is_none_or(|c| c.status != ChatStatus::NeedsYou)).then_some(Next::Update(Status::Working))
            }
            // A Stop hook keeping Claude going is the same turn, still on its clock.
            UiEvent::UserText { text, .. } if text.starts_with(crate::hooks::STOP_PREFIX) => None,
            UiEvent::UserText { .. } => Some(Next::Restart),
            UiEvent::Todos { parent: None, .. } | UiEvent::PlanUsage { .. } => Some(Next::Detail),
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
        // What a prompt asks for is kept on the card, to be said while the chat needs you (one word: never the prompt itself).
        let asks = match &ev.event {
            UiEvent::PermissionRequested { tool_name, .. } => Some(Needs::of_tool(tool_name)),
            UiEvent::MergeProposed { .. } => Some(Needs::Approval),
            _ => None,
        };
        for (device, card) in self.store.live.cards() {
            // A summary card is about every chat: what this one did is kept, and the card pushed if it now looks different.
            if card.summary.is_some() {
                if next != Next::Detail {
                    self.track(&device, &ev.slot, next);
                    self.push_summary(&device, false).await;
                }
                continue;
            }
            if card.slot == ev.slot {
                if let Some(needs) = asks {
                    self.store.live.edit(&device, |c| c.needs = Some(needs));
                }
                self.push(&device, next).await;
            }
        }
    }

    /// What the card says besides the project and state, from what the hub knows of the chat now. What a chat asks for is said
    /// only while it needs you; a finished card shows how far the plan got.
    fn detail_for(&self, card: &LiveCard, status: Status) -> Detail {
        Detail {
            title: self.hub.real_title(&card.slot).and_then(|t| clean_title(&t)),
            steps: self.hub.steps(&card.slot),
            needs: if status == Status::NeedsYou { card.needs } else { None },
            plan: self.hub.plan().map(|(used, _, _)| (used * 100.0).round().clamp(0.0, 100.0) as u8),
        }
    }

    /// Ends each summary card whose chats have all been quiet for long enough.
    async fn end_quiet_summaries(&self) {
        let now = (self.now_ms)();
        for (device, card) in self.store.live.cards() {
            let due = card.summary.as_ref().and_then(|s| s.idle_since).is_some_and(|at| now.saturating_sub(at) >= SUMMARY_END_AFTER_MS);
            if !card.ended && due {
                self.push_summary(&device, false).await;
            }
        }
    }

    /// What a summary card keeps of one chat's event: when its turn began, and how it ended.
    fn track(&self, device: &str, slot: &str, next: Next) {
        let now = (self.now_ms)();
        self.store.live.edit(device, |c| {
            let Some(s) = c.summary.as_mut() else { return };
            match next {
                Next::Restart => {
                    s.started.insert(slot.to_string(), now);
                    s.finished.retain(|(f, _)| f != slot);
                }
                Next::End(status) => {
                    s.started.remove(slot);
                    s.finished.retain(|(f, _)| f != slot);
                    s.finished.push((slot.to_string(), status));
                }
                _ => {}
            }
        });
    }

    /// What a summary card shows now, from the chats the hub knows: those that need you, then those working (the longest
    /// first), then those that ended while it was up (the latest first). A chat closed since is simply not there.
    fn summary_for(&self, card: &LiveCard) -> Summary {
        let state = card.summary.clone().unwrap_or_default();
        // The titles of every chat, not only one the phone messaged: on the lock screen only if the user turned titles on.
        let show_titles = self.store.saved().show_titles;
        let mut needs = Vec::new();
        let mut working = Vec::new();
        let mut ended = Vec::new();
        for chat in self.hub.chats() {
            let row = |status: Status, since: Option<u64>| Row {
                project: project_of(chat.folder.as_deref()),
                title: if show_titles { self.hub.real_title(&chat.slot).and_then(|t| clean_title(&t)).map(|t| t.chars().take(ROW_TITLE_MAX).collect()) } else { None },
                status,
                since,
            };
            match chat.status {
                ChatStatus::NeedsYou => needs.push(row(Status::NeedsYou, None)),
                ChatStatus::Working => {
                    let since = state.started.get(&chat.slot).copied().unwrap_or(card.since);
                    working.push(row(Status::Working, Some(since)));
                }
                _ => {
                    if let Some(at) = state.finished.iter().position(|(f, _)| *f == chat.slot) {
                        ended.push((at, row(state.finished[at].1, None)));
                    }
                }
            }
        }
        working.sort_by_key(|r| r.since);
        ended.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
        let failed = ended.iter().filter(|(_, r)| r.status == Status::Failed).count();
        let done = ended.len() - failed;
        let since = working.iter().filter_map(|r| r.since).min().unwrap_or(card.since);
        let status = if !needs.is_empty() {
            Status::NeedsYou
        } else if !working.is_empty() {
            Status::Working
        } else if failed > 0 {
            Status::Failed
        } else {
            Status::Done
        };
        let (needs_you, working_n) = (needs.len(), working.len());
        let rows = needs.into_iter().chain(working).chain(ended.into_iter().map(|(_, r)| r)).take(SUMMARY_ROWS).collect();
        Summary { status, rows, needs_you, working: working_n, done, failed, since }
    }

    /// Brings a summary card up to date: an update while anything works or waits for you, and when that stops, an update
    /// showing what finished; once nothing has worked or waited for SUMMARY_END_AFTER_MS, its end (the phone keeps it, still
    /// showing what finished, for DISMISS_AFTER_SECS). Nothing is sent when it would look the same, unless `refresh` (the
    /// heartbeat, which keeps it from going stale) or it is time to end it.
    async fn push_summary(&self, device: &str, refresh: bool) {
        let Some(card) = self.store.live.state(device).and_then(|s| s.card) else { return };
        let now = (self.now_ms)();
        if card.ended {
            return;
        }
        if now.saturating_sub(card.registered_at) > CARD_LIFETIME_MS {
            self.store.live.drop_card(device);
            return;
        }
        // The chats the Mac no longer has are forgotten.
        let known: std::collections::HashSet<String> = self.hub.chats().into_iter().map(|c| c.slot).collect();
        self.store.live.edit(device, |c| {
            if let Some(s) = c.summary.as_mut() {
                s.finished.retain(|(f, _)| known.contains(f));
                s.started.retain(|f, _| known.contains(f));
            }
        });
        let Some(card) = self.store.live.state(device).and_then(|s| s.card) else { return };
        let kept = card.summary.clone().unwrap_or_default();
        let summary = self.summary_for(&card);
        let props = summary.props();
        let idle_since = if summary.active() { None } else { Some(kept.idle_since.unwrap_or(now)) };
        let end = idle_since.is_some_and(|at| now.saturating_sub(at) >= SUMMARY_END_AFTER_MS);
        if idle_since != kept.idle_since {
            self.store.live.edit(device, |c| {
                if let Some(s) = c.summary.as_mut() {
                    s.idle_since = idle_since;
                }
            });
        }
        if !refresh && !end && kept.last_props.as_deref() == Some(props.as_str()) {
            return;
        }
        let event = if end { "end" } else { "update" };
        // At once (and lighting the screen) only for one more chat that needs you; what finished is no reason to wake anyone.
        let priority = if summary.needs_you > kept.last_needs { 10 } else { 5 };
        let push = Push { event, priority, body: payload_of(event, props.clone(), now / 1000) };
        match self.send_card(&card, &push).await {
            Ok(reply) if reply.ok() => {
                self.store.live.said("Apple accepted the last update.".into());
                self.store.live.edit(device, |c| {
                    c.status = summary.status;
                    c.since = summary.since;
                    c.ended = event == "end";
                    c.last_push = now;
                    if let Some(s) = c.summary.as_mut() {
                        s.last_props = Some(props.clone());
                        s.last_needs = summary.needs_you;
                    }
                });
            }
            Ok(reply) => self.refused(device, &card, &reply),
            Err(e) => self.store.live.said(e),
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
            Next::Refresh | Next::Detail => ("update", card.status, card.since),
            Next::Restart => ("update", Status::Working, now),
            Next::End(s) => ("end", s, card.since),
        };
        let detail = self.detail_for(&card, status);
        // A number that moved is pushed only if the card would look different, and not within a short while of the last push
        // (it goes out with the next status change, the end of the turn or the heartbeat otherwise): the plan's progress and the
        // usage move with nearly every event.
        if next == Next::Detail && (detail == card.detail || now.saturating_sub(card.last_push) < DETAIL_EVERY_MS) {
            return;
        }
        let push = Push { event, priority: if status == Status::Working { 5 } else { 10 }, body: payload_with(event, status, &card.project, since, now / 1000, &detail) };
        match self.apns.send(&card.token, &push).await {
            Ok(reply) if reply.ok() => {
                self.store.live.said("Apple accepted the last update.".into());
                self.store.live.edit(device, |c| {
                    c.status = status;
                    c.since = since;
                    c.ended = event == "end";
                    c.last_push = now;
                    c.detail = detail.clone();
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
        /// Pushes to a broadcast channel, by channel.
        pub broadcasts: Mutex<Vec<(String, Push)>>,
        pub broadcast_answer: Mutex<Option<Result<Reply, String>>>,
        /// How many channels were made.
        pub channels: Mutex<u32>,
    }

    /// The id Apple gives the first channel the Outbox makes.
    pub const CHANNEL: &str = "dHJ5aW5nLWNoYW5uZWw=";

    impl Apns for Outbox {
        fn send(&self, token: &str, push: &Push) -> BoxFut<Result<Reply, String>> {
            self.sent.lock().unwrap().push((token.to_string(), push.clone()));
            let answer = self.answer.lock().unwrap().clone().unwrap_or(Ok(Reply { status: 200, reason: None }));
            Box::pin(async move { answer })
        }

        fn alert(&self, _token: &str, _alert: &Alert) -> BoxFut<Result<Reply, String>> {
            Box::pin(async { Ok(Reply { status: 200, reason: None }) })
        }

        fn broadcast(&self, channel: &str, push: &Push) -> BoxFut<Result<Reply, String>> {
            self.broadcasts.lock().unwrap().push((channel.to_string(), push.clone()));
            let answer = self.broadcast_answer.lock().unwrap().clone().unwrap_or(Ok(Reply { status: 200, reason: None }));
            Box::pin(async move { answer })
        }

        fn create_channel(&self) -> BoxFut<Result<String, String>> {
            let mut made = self.channels.lock().unwrap();
            *made += 1;
            let id = if *made == 1 { CHANNEL.to_string() } else { format!("bm{}V3LWNoYW5uZWw=", *made) };
            Box::pin(async move { Ok(id) })
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
            self.store.live.register(device, Some(TOKEN.into()), Some(LiveCard { slot: slot.into(), token: TOKEN.into(), project: "lantern".into(), since: clock() - 5_000, status: Status::Working, ended: false, registered_at: clock() - 5_000, last_push: clock() - 5_000, needs: None, detail: Detail::default(), summary: None, channel: None }));
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
        r.store.live.register("phone-2", None, Some(LiveCard { slot: "a".into(), token: "f".repeat(64), project: "lantern".into(), since: 1, status: Status::Working, ended: false, registered_at: clock(), last_push: clock(), needs: None, detail: Detail::default(), summary: None, channel: None }));
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
    async fn a_card_that_missed_its_chats_end_or_answer_is_brought_right_on_the_heartbeat_not_kept_fresh_as_working() {
        let r = rig();
        r.hub.opened("a", "/p/lantern");
        r.event("a", UiEvent::UserText { text: "go".into(), at: None, sent_by: None, images: 0 }).await;
        r.card("phone-1", "a");
        // The turn ended, but the card never heard (the bus was behind, or the push didn't get through).
        r.hub.record(&BusEvent { slot: "a".into(), seq: 100, event: done(false) });
        r.store.live.edit("phone-1", |c| c.last_push = clock());
        r.service.heartbeat().await;
        let sent = r.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!((sent[0].1.event, props(&sent[0].1)["status"].clone()), ("end", json!("done")));
        assert!(r.store.live.cards()[0].1.ended);
        // A card that says it needs you after the prompt was answered somewhere else is put back to Working.
        let r = rig();
        r.hub.opened("a", "/p/lantern");
        r.event("a", UiEvent::UserText { text: "go".into(), at: None, sent_by: None, images: 0 }).await;
        r.card("phone-1", "a");
        r.event("a", asked()).await;
        assert_eq!(r.sent().len(), 1);
        r.hub.record(&BusEvent { slot: "a".into(), seq: 101, event: resolved() });
        r.service.heartbeat().await;
        let sent = r.sent();
        assert_eq!(sent.len(), 2);
        assert_eq!((sent[1].1.event, props(&sent[1].1)["status"].clone()), ("update", json!("working")));
        // One that is right already is sent nothing.
        r.service.heartbeat().await;
        assert_eq!(r.sent().len(), 2);
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
        r.store.live.register("phone-1", None, Some(LiveCard { slot: "a".into(), token: "e".repeat(64), project: "lantern".into(), since: 1, status: Status::Working, ended: false, registered_at: clock(), last_push: clock(), needs: None, detail: Detail::default(), summary: None, channel: None }));
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

    fn todo(status: &str) -> crate::ui_event::Todo {
        crate::ui_event::Todo { content: "SECRET-STEP".into(), status: status.into(), active_form: "Doing SECRET-STEP".into() }
    }

    fn plan(items: Vec<crate::ui_event::Todo>) -> UiEvent {
        UiEvent::Todos { parent: None, items }
    }

    fn usage(used: f64) -> UiEvent {
        UiEvent::PlanUsage { used, resets_at: None, status: "allowed".into() }
    }

    impl Rig {
        /// A card whose last push was `age_ms` ago.
        fn card_aged(&self, device: &str, slot: &str, age_ms: u64) {
            self.store.live.register(device, Some(TOKEN.into()), Some(LiveCard { slot: slot.into(), token: TOKEN.into(), project: "lantern".into(), since: clock() - 5_000, status: Status::Working, ended: false, registered_at: clock() - age_ms - 5_000, last_push: clock() - age_ms, needs: None, detail: Detail::default(), summary: None, channel: None }));
        }
    }

    #[test]
    fn a_push_carries_the_title_the_steps_what_it_needs_and_the_usage_only_when_it_has_them() {
        let bare = props_json("lantern", Status::Working, 5, &Detail::default());
        assert_eq!(serde_json::from_str::<Value>(&bare).unwrap(), json!({"project": "lantern", "status": "working", "since": 5}));
        let all = Detail { title: Some("Release 0.1.63".into()), steps: Some((3, 5)), needs: Some(Needs::Command), plan: Some(43) };
        let props: Value = serde_json::from_str(&props_json("lantern", Status::NeedsYou, 5, &all)).unwrap();
        assert_eq!(props, json!({"project": "lantern", "status": "needs_you", "since": 5, "title": "Release 0.1.63", "steps_done": 3, "steps_total": 5, "needs": "command", "plan": 43}));
        // The whole push stays far below what a Live Activity may carry (4 KB), even with the longest title.
        let long = Detail { title: Some("é".repeat(TITLE_MAX)), ..all };
        assert!(payload_with("update", Status::NeedsYou, &"é".repeat(PROJECT_MAX), 1, 1, &long).to_string().len() < 1024);
    }

    #[test]
    fn a_title_is_one_clean_short_line_and_nothing_when_nothing_is_left() {
        assert_eq!(clean_title("  Release\n0.1.63\u{7}\t now  ").as_deref(), Some("Release 0.1.63 now"));
        assert_eq!(clean_title(&"x".repeat(200)).unwrap().chars().count(), TITLE_MAX);
        assert_eq!(clean_title(" \n\u{7} "), None);
        assert_eq!(clean_title(""), None);
    }

    #[test]
    fn a_prompt_is_one_word_for_what_it_asks() {
        for (tool, want) in [("Bash", Needs::Command), ("Edit", Needs::Edit), ("Write", Needs::Edit), ("AskUserQuestion", Needs::Question), ("mcp__lantern__request_approval", Needs::Approval), ("WebFetch", Needs::Tool), ("", Needs::Tool)] {
            assert_eq!(Needs::of_tool(tool), want, "{tool}");
        }
    }

    #[tokio::test]
    async fn a_card_that_needs_you_says_what_for_in_a_word_and_stops_saying_it_when_it_is_answered() {
        let r = rig();
        r.card("phone-1", "a");
        r.event("a", asked()).await;
        r.event("a", resolved()).await;
        let sent = r.sent();
        assert_eq!(props(&sent[0].1)["needs"], "command");
        assert!(props(&sent[1].1).get("needs").is_none(), "{:?}", props(&sent[1].1));
        let text = sent.iter().map(|(_, p)| p.body.to_string()).collect::<String>();
        assert!(!text.contains("rm -rf") && !text.contains("secrets"));
    }

    #[tokio::test]
    async fn the_card_says_the_chats_title_but_never_the_stand_in_made_from_the_first_thing_said() {
        let r = rig();
        r.card("phone-1", "a");
        r.event("a", UiEvent::UserText { text: "my password is hunter2".into(), at: None, sent_by: None, images: 0 }).await;
        r.event("a", asked()).await;
        assert!(r.sent().iter().all(|(_, p)| props(p).get("title").is_none()), "the first message stood in as a title");
        r.hub.titled("a", "  Cut the\nrelease  ");
        r.event("a", resolved()).await;
        assert_eq!(props(&r.sent().last().unwrap().1)["title"], "Cut the release");
    }

    #[tokio::test]
    async fn the_plans_progress_and_the_usage_go_out_when_they_change_not_more_often_than_every_so_often_and_never_as_words() {
        let r = rig();
        // A card pushed to a minute ago: a change goes out, once; the same numbers again don't, and nor does a change a moment later.
        r.card_aged("phone-1", "a", 60_000);
        r.event("a", UiEvent::UserText { text: "go".into(), at: None, sent_by: None, images: 0 }).await;
        let before = r.sent().len();
        r.store.live.edit("phone-1", |c| c.last_push = clock() - 60_000);
        r.event("a", plan(vec![todo("completed"), todo("in_progress"), todo("pending")])).await;
        let sent = r.sent();
        assert_eq!(sent.len(), before + 1);
        let p = props(&sent.last().unwrap().1);
        assert_eq!((p["steps_done"].clone(), p["steps_total"].clone()), (json!(1), json!(3)));
        assert!(!sent.last().unwrap().1.body.to_string().contains("SECRET-STEP"));
        // Moments later (the card was just pushed to) a further change waits for the next push.
        r.event("a", plan(vec![todo("completed"), todo("completed"), todo("pending")])).await;
        r.event("a", usage(0.43)).await;
        assert_eq!(r.sent().len(), before + 1);
        // A minute on, it goes out with the new numbers, and the same again changes nothing.
        r.store.live.edit("phone-1", |c| c.last_push = clock() - 60_000);
        r.event("a", usage(0.43)).await;
        let p = props(&r.sent().last().unwrap().1);
        assert_eq!((p["steps_done"].clone(), p["plan"].clone()), (json!(2), json!(43)));
        let n = r.sent().len();
        r.store.live.edit("phone-1", |c| c.last_push = clock() - 60_000);
        r.event("a", usage(0.43)).await;
        assert_eq!(r.sent().len(), n, "nothing changed, so nothing was pushed");
    }

    #[tokio::test]
    async fn the_end_of_a_turn_says_how_far_the_plan_got_and_nothing_it_needs() {
        let r = rig();
        r.card("phone-1", "a");
        r.event("a", plan(vec![todo("completed"), todo("completed")])).await;
        r.event("a", asked()).await;
        r.event("a", done(false)).await;
        let last = r.sent().last().unwrap().clone();
        assert_eq!(last.1.event, "end");
        let p = props(&last.1);
        assert_eq!((p["steps_done"].clone(), p["steps_total"].clone()), (json!(2), json!(2)));
        assert!(p.get("needs").is_none());
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

    // ---- summary cards

    fn go() -> UiEvent {
        UiEvent::UserText { text: "SECRET MESSAGE".into(), at: None, sent_by: None, images: 0 }
    }

    impl Rig {
        /// A phone with a summary card, as the gateway registers it.
        fn summary_card(&self, device: &str) {
            self.store.live.register(device, None, Some(LiveCard { slot: String::new(), token: TOKEN.into(), project: "Lantern".into(), since: clock() - 5_000, status: Status::Working, ended: false, registered_at: clock() - 5_000, last_push: clock() - 5_000, needs: None, detail: Detail::default(), summary: Some(SummaryState::default()), channel: None }));
        }
    }

    #[tokio::test]
    async fn a_summary_card_follows_every_chat_and_pushes_only_what_changes_it() {
        let r = rig();
        r.hub.opened("a", "/code/app");
        r.hub.opened("b", "/code/web");
        r.summary_card("phone-1");
        r.event("a", go()).await;
        r.event("b", go()).await;
        // Something that doesn't change the card (the plan's usage, a second message to a chat that is working) sends nothing.
        r.event("a", UiEvent::Todos { parent: None, items: vec![] }).await;
        let sent = r.sent();
        assert_eq!(sent.len(), 2);
        let p = props(&sent[1].1);
        assert_eq!(p["status"], "working");
        assert_eq!(p["counts"], json!({"needs_you": 0, "working": 2, "done": 0, "failed": 0}));
        // Both began on the same tick of the tests' still clock, so either may come first.
        let mut projects = p["chats"].as_array().unwrap().iter().map(|c| c["project"].as_str().unwrap()).collect::<Vec<_>>();
        projects.sort();
        assert_eq!(projects, vec!["app", "web"]);
        assert_eq!(sent[1].1.body["aps"]["event"], "update");
        assert_eq!(sent[1].1.priority, 5);
    }

    #[tokio::test]
    async fn a_chat_that_needs_you_leads_the_summary_and_is_pushed_at_once() {
        let r = rig();
        r.hub.opened("a", "/code/app");
        r.hub.opened("b", "/code/web");
        r.summary_card("phone-1");
        r.event("a", go()).await;
        r.event("b", go()).await;
        r.event("b", asked()).await;
        let last = r.sent().last().unwrap().1.clone();
        assert_eq!(last.priority, 10);
        let p = props(&last);
        assert_eq!(p["status"], "needs_you");
        assert_eq!(p["chats"][0], json!({"project": "web", "status": "needs_you"}));
        assert_eq!(p["chats"][1]["status"], "working");
        // Answered: back to working, not urgent.
        r.event("b", resolved()).await;
        let last = r.sent().last().unwrap().1.clone();
        assert_eq!((last.priority, props(&last)["status"].clone()), (5, json!("working")));
    }

    #[tokio::test]
    async fn a_summary_card_ends_showing_what_finished_once_nothing_works_or_waits() {
        let r = rig();
        r.hub.opened("a", "/code/app");
        r.hub.opened("b", "/code/web");
        r.summary_card("phone-1");
        r.event("a", go()).await;
        r.event("b", go()).await;
        r.event("a", done(true)).await;
        let mid = r.sent().last().unwrap().1.clone();
        assert_eq!(mid.body["aps"]["event"], "update", "b is still working");
        r.event("b", done(false)).await;
        // Quiet now: shown at once, but not ended yet (a queued message may start the next turn a moment later).
        let quiet = r.sent().last().unwrap().1.clone();
        assert_eq!((quiet.body["aps"]["event"].clone(), quiet.priority), (json!("update"), 5));
        let before = r.sent().len();
        r.service.end_quiet_summaries().await;
        assert_eq!(r.sent().len(), before, "not quiet for long enough");
        r.store.live.edit("phone-1", |c| c.summary.as_mut().unwrap().idle_since = Some(clock() - SUMMARY_END_AFTER_MS));
        r.service.end_quiet_summaries().await;
        let last = r.sent().last().unwrap().1.clone();
        assert_eq!(last.body["aps"]["event"], "end");
        assert_eq!(last.priority, 5, "what finished wakes nobody");
        assert!(last.body["aps"]["dismissal-date"].is_u64());
        let p = props(&last);
        assert_eq!(p["counts"], json!({"needs_you": 0, "working": 0, "done": 1, "failed": 1}));
        // The latest to finish first.
        assert_eq!(p["chats"], json!([{"project": "web", "status": "done"}, {"project": "app", "status": "failed"}]));
        // Over: nothing more goes to it, however the chats go on.
        let count = r.sent().len();
        r.event("a", go()).await;
        assert_eq!(r.sent().len(), count);
    }

    #[tokio::test]
    async fn a_summary_card_lists_a_few_chats_and_counts_the_rest() {
        let r = rig();
        for i in 0..6 {
            r.hub.opened(&format!("c{i}"), &format!("/code/p{i}"));
        }
        r.summary_card("phone-1");
        for i in 0..6 {
            r.event(&format!("c{i}"), go()).await;
        }
        let p = props(&r.sent().last().unwrap().1);
        assert_eq!(p["chats"].as_array().unwrap().len(), SUMMARY_ROWS);
        assert_eq!(p["counts"]["working"], 6);
        assert!(r.sent().last().unwrap().1.body.to_string().len() < 4096);
    }

    #[tokio::test]
    async fn a_summary_card_is_refreshed_by_the_heartbeat_even_when_nothing_changed() {
        let r = rig();
        r.hub.opened("a", "/code/app");
        r.summary_card("phone-1");
        r.event("a", go()).await;
        assert_eq!(r.sent().len(), 1);
        r.store.live.edit("phone-1", |c| c.last_push = clock() - REFRESH_AFTER_MS);
        r.service.heartbeat().await;
        assert_eq!(r.sent().len(), 2);
        assert_eq!(props(&r.sent()[1].1), props(&r.sent()[0].1));
    }

    #[tokio::test]
    async fn a_plain_card_beside_a_summary_card_still_follows_only_its_chat() {
        let r = rig();
        r.hub.opened("a", "/code/app");
        r.hub.opened("b", "/code/web");
        r.card("phone-old", "a");
        r.summary_card("phone-new");
        r.event("b", go()).await;
        // Only the summary card heard of b.
        assert_eq!(r.sent().len(), 1);
        assert!(props(&r.sent()[0].1).get("chats").is_some());
        r.event("a", done(false)).await;
        let ends: Vec<_> = r.sent().iter().filter(|(_, p)| p.body["aps"]["event"] == "end").map(|(_, p)| props(p)).collect();
        assert_eq!(ends.len(), 1, "a's plain card ends; the summary card goes on, b is working");
        assert!(ends[0].get("chats").is_none());
    }

    #[tokio::test]
    async fn a_turn_that_starts_right_after_another_ends_keeps_the_summary_card() {
        let r = rig();
        r.hub.opened("a", "/code/app");
        r.summary_card("phone-1");
        r.event("a", go()).await;
        r.event("a", done(false)).await;
        r.event("a", go()).await;
        r.store.live.edit("phone-1", |c| assert_eq!(c.summary.as_ref().unwrap().idle_since, None));
        r.service.end_quiet_summaries().await;
        assert!(r.sent().iter().all(|(_, p)| p.body["aps"]["event"] == "update"));
        assert_eq!(props(&r.sent().last().unwrap().1)["status"], "working");
    }

    #[tokio::test]
    async fn a_summary_card_shows_chats_titles_only_when_the_user_turned_titles_on() {
        let r = rig();
        r.hub.opened("a", "/code/app");
        r.hub.titled("a", "Release 0.1.90");
        r.summary_card("phone-1");
        r.event("a", go()).await;
        assert!(props(&r.sent()[0].1)["chats"][0].get("title").is_none());
        r.store.set_show_titles(true).unwrap();
        r.event("a", asked()).await;
        assert_eq!(props(&r.sent().last().unwrap().1)["chats"][0]["title"], "Release 0.1.90");
    }

    #[tokio::test]
    async fn a_summary_card_says_nothing_a_lock_screen_shouldnt() {
        let r = rig();
        r.hub.opened("a", "/code/app");
        r.summary_card("phone-1");
        r.event("a", UiEvent::UserText { text: "my password is hunter2".into(), at: None, sent_by: None, images: 0 }).await;
        r.event("a", asked()).await;
        r.event("a", done(false)).await;
        for (_, push) in r.sent() {
            let text = push.body.to_string();
            for secret in ["rm -rf", "secrets", "hunter2", "SECRET", "Bash"] {
                assert!(!text.contains(secret), "{secret} in {text}");
            }
        }
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Cards the Mac starts itself, on a phone with the app closed.

    /// A paired phone that gave its token for starting cards; chats `a` and `b`, with `a` working long enough for a card.
    fn closed_phone(r: &Rig) -> String {
        let device = r.store.add_device(&[7; 32], "Phone", 0).unwrap().id;
        r.store.set_start_token(&device, Some(TOKEN)).unwrap();
        r.hub.opened("a", "/code/app");
        r.hub.opened("b", "/code/web");
        device
    }

    async fn work_long_enough(r: &Rig) {
        r.event("a", go()).await;
        // The clock stands still in these tests: each spell of work is told apart by when it began.
        let spell = *r.seq.lock().unwrap();
        *r.service.busy_since.lock().unwrap() = Some(clock() - START_AFTER_MS - spell);
    }

    fn broadcasts(r: &Rig) -> Vec<(String, Push)> {
        r.outbox.broadcasts.lock().unwrap().clone()
    }

    #[tokio::test]
    async fn a_phone_with_no_card_gets_one_started_by_the_mac_once_chats_have_worked_a_while() {
        let r = rig();
        let device = closed_phone(&r);
        r.event("a", go()).await;
        r.service.start_cards().await;
        assert!(r.sent().is_empty(), "not straight away: a phone with the app in front starts its own");
        work_long_enough(&r).await;
        r.service.start_cards().await;
        let sent = r.sent();
        assert_eq!(sent.len(), 1);
        let (token, push) = &sent[0];
        assert_eq!(token, TOKEN, "to the phone's token for starting cards");
        let aps = &push.body["aps"];
        assert_eq!((aps["event"].as_str(), aps["input-push-channel"].as_str(), aps["attributes-type"].as_str()), (Some("start"), Some(CHANNEL), Some(ATTRIBUTES_TYPE)));
        assert_eq!(aps["attributes"], json!({}));
        assert_eq!(aps["content-state"]["name"], ACTIVITY_NAME);
        // The alert iOS insists on: counts only, never a project or a title, and no sound.
        assert_eq!(aps["alert"], json!({"title": "Lantern", "body": "A chat is working"}));
        assert!(aps.get("sound").is_none());
        assert_eq!(props(push)["counts"], json!({"needs_you": 0, "working": 1, "done": 0, "failed": 0}));
        // The channel is kept for the next card, and the card is the phone's now: updated through the channel.
        assert_eq!(r.store.saved().devices[0].live_channel.as_deref(), Some(CHANNEL));
        let card = r.store.live.state(&device).unwrap().card.unwrap();
        assert_eq!((card.channel.as_deref(), card.summary.is_some()), (Some(CHANNEL), true));
        r.event("b", go()).await;
        let b = broadcasts(&r);
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].0, CHANNEL);
        assert_eq!(props(&b[0].1)["counts"]["working"], 2);
        assert_eq!(r.sent().len(), 1, "nothing to a token");
        // One start a spell of work: looking again starts nothing, nor does one more chat starting.
        r.service.start_cards().await;
        assert_eq!(r.sent().len(), 1);
    }

    #[tokio::test]
    async fn a_card_that_was_started_is_not_started_again_until_the_chats_have_been_quiet() {
        let r = rig();
        let device = closed_phone(&r);
        work_long_enough(&r).await;
        r.service.start_cards().await;
        // Apple says the card is gone (the user swiped it away): not started over in the same spell of work.
        r.store.live.edit(&device, |c| c.ended = true);
        r.service.start_cards().await;
        assert_eq!(r.sent().len(), 1);
        // Quiet, then working again: a new spell, but within START_EVERY_MS of the last start (each comes with an alert).
        r.event("a", done(false)).await;
        r.service.start_cards().await;
        work_long_enough(&r).await;
        r.service.start_cards().await;
        assert_eq!(r.sent().len(), 1);
        // Later on (the tests' clock stands still: what the Mac remembers of its last start is forgotten instead), a new card,
        // through the same channel.
        r.service.tried.lock().unwrap().clear();
        r.service.start_cards().await;
        assert_eq!(r.sent().len(), 2);
        assert_eq!(*r.outbox.channels.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn a_start_that_couldnt_reach_apple_is_tried_again_a_minute_later() {
        let r = rig();
        closed_phone(&r);
        *r.outbox.answer.lock().unwrap() = Some(Err("Couldn't reach Apple.".into()));
        work_long_enough(&r).await;
        r.service.start_cards().await;
        r.service.start_cards().await;
        assert_eq!(r.sent().len(), 1, "not again straight away");
        *r.outbox.answer.lock().unwrap() = None;
        r.service.tried.lock().unwrap().insert(r.store.saved().devices[0].id.clone(), (clock() - 60_000, false));
        r.service.start_cards().await;
        assert_eq!(r.sent().len(), 2, "the same spell of work, tried again");
    }

    #[tokio::test]
    async fn a_phone_woken_in_the_background_saying_its_old_card_again_leaves_the_macs_card_be() {
        let r = rig();
        let device = closed_phone(&r);
        // The phone's own card, ended by the Mac when the chats went quiet; the app is then closed.
        r.summary_card(&device);
        r.store.live.edit(&device, |c| c.ended = true);
        work_long_enough(&r).await;
        r.service.start_cards().await;
        assert_eq!(r.store.live.state(&device).unwrap().card.unwrap().channel.as_deref(), Some(CHANNEL));
        // Woken to answer a notification, it says the card it still holds: that is no card, and the phone hears it is over.
        let old = LiveCard { slot: String::new(), token: TOKEN.into(), project: "Lantern".into(), since: clock(), status: Status::Working, ended: false, registered_at: clock(), last_push: clock(), needs: None, detail: Detail::default(), summary: Some(SummaryState::default()), channel: None };
        assert!(r.store.live.register(&device, None, Some(old.clone())));
        assert_eq!(r.store.live.state(&device).unwrap().card.unwrap().channel.as_deref(), Some(CHANNEL));
        r.service.reconcile().await;
        assert!(broadcasts(&r).iter().all(|(_, p)| p.event != "end"));
        // A card the phone has just started (a new token) does replace it.
        assert!(!r.store.live.register(&device, None, Some(LiveCard { token: "fe".repeat(32), ..old })));
        r.service.reconcile().await;
        assert!(broadcasts(&r).iter().any(|(_, p)| p.event == "end"));
    }

    #[tokio::test]
    async fn the_mac_starts_nothing_on_a_phone_that_shows_its_own_card_or_gave_no_token() {
        let r = rig();
        let device = closed_phone(&r);
        r.summary_card(&device);
        work_long_enough(&r).await;
        r.service.start_cards().await;
        assert!(r.sent().iter().all(|(_, p)| p.event != "start"));
        r.store.live.forget(&device);
        r.store.set_start_token(&device, None).unwrap();
        r.service.start_cards().await;
        assert!(r.sent().iter().all(|(_, p)| p.event != "start"));
        // Nor with Remote control off.
        r.store.set_start_token(&device, Some(TOKEN)).unwrap();
        r.store.set_enabled(false).unwrap();
        r.service.start_cards().await;
        assert!(r.sent().iter().all(|(_, p)| p.event != "start"));
    }

    #[tokio::test]
    async fn the_phones_own_card_replaces_the_one_the_mac_started_which_is_ended_at_once() {
        let r = rig();
        let device = closed_phone(&r);
        work_long_enough(&r).await;
        r.service.start_cards().await;
        // A phone that says it shows no card (it connected in the background) leaves the Mac's card be.
        r.store.live.register(&device, None, None);
        assert_eq!(r.store.live.state(&device).unwrap().card.unwrap().channel.as_deref(), Some(CHANNEL));
        r.service.reconcile().await;
        assert!(broadcasts(&r).iter().all(|(_, p)| p.event != "end"));
        // The app opened and put up its own (a token the Mac hasn't seen): the Mac's is ended through its channel, and gone from
        // the screen at once.
        r.summary_card(&device);
        r.service.reconcile().await;
        let end = broadcasts(&r).into_iter().find(|(_, p)| p.event == "end").expect("the Mac's card is ended");
        assert_eq!(end.0, CHANNEL);
        assert_eq!(end.1.body["aps"]["dismissal-date"], json!(clock() / 1000));
        let card = r.store.live.state(&device).unwrap().card.unwrap();
        assert_eq!((card.channel, card.token.as_str()), (None, TOKEN));
    }

    #[tokio::test]
    async fn a_start_token_or_a_channel_apple_says_is_gone_is_forgotten() {
        let r = rig();
        let device = closed_phone(&r);
        *r.outbox.answer.lock().unwrap() = Some(Ok(Reply { status: 410, reason: Some("Unregistered".into()) }));
        work_long_enough(&r).await;
        r.service.start_cards().await;
        assert_eq!(r.store.saved().devices[0].start_token, None);
        assert!(r.store.live.state(&device).is_none_or(|s| s.card.is_none()));
        // A channel Apple no longer knows: the card goes, and the next is started on a new channel.
        *r.outbox.answer.lock().unwrap() = None;
        r.store.set_start_token(&device, Some(TOKEN)).unwrap();
        r.event("a", done(false)).await;
        r.service.start_cards().await;
        work_long_enough(&r).await;
        r.service.tried.lock().unwrap().clear();
        r.service.start_cards().await;
        *r.outbox.broadcast_answer.lock().unwrap() = Some(Ok(Reply { status: 400, reason: Some("BadChannelId".into()) }));
        r.event("b", go()).await;
        assert_eq!(r.store.saved().devices[0].live_channel, None);
        assert!(r.store.live.state(&device).unwrap().card.is_none());
    }

    /// Makes a real broadcast channel with Apple and deletes it again: Apple making one means the app's Broadcast Capability is
    /// on and the key may manage channels. Nothing reaches any phone. `LANTERN_PUSH_KEY_FILE=… LANTERN_PUSH_KEY_ID=… cargo test
    /// real_channel -- --ignored --nocapture`. Prints Apple's statuses, nothing of the key.
    #[tokio::test]
    #[ignore]
    async fn real_channel_is_made_and_deleted() {
        let (file, id) = (std::env::var("LANTERN_PUSH_KEY_FILE").unwrap(), std::env::var("LANTERN_PUSH_KEY_ID").unwrap());
        let key = Arc::new(LiveKey::default());
        key.import(&id, "2NT5QR24SX", &std::fs::read_to_string(file).unwrap()).unwrap();
        let apns = ApnsHttp::new(key).unwrap();
        let channel = apns.create_channel().await;
        println!("make: {channel:?}");
        let channel = channel.unwrap();
        // A push to it with no card listening is still taken.
        let push = Push { event: "update", priority: 5, body: payload_of("update", Summary { status: Status::Done, rows: vec![], needs_you: 0, working: 0, done: 0, failed: 0, since: 0 }.props(), now_secs()) };
        let sent = apns.broadcast(&channel, &push).await;
        println!("broadcast: {sent:?}");
        let deleted = apns.delete_channel(&channel).await;
        println!("delete: {deleted:?}");
        assert!(matches!(deleted, Ok(200..=299)));
        assert!(sent.unwrap().ok());
    }

    #[test]
    fn a_channel_id_is_only_ever_base64() {
        assert!(valid_channel(CHANNEL));
        for bad in ["short", "has space in it", "../../../x/y/z", "a\r\nInjected: header", &"A".repeat(200)] {
            assert!(!valid_channel(bad), "{bad:?}");
        }
    }
}
