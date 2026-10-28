//! The only door from the network into Lantern. A phone comes in on a transport (see transport.rs), proves it is paired
//! (or pairs, with the QR code's one-time secret) through the secure channel (see secure.rs), then may ask exactly what
//! `protocol::Request` lists and nothing else. It is sent the events of the chats it subscribes to, mapped by
//! `protocol::to_remote`. What the gateway does for a request is the app's to do (`Host`), so it can be tested alone.

use super::answers;
use super::bus::{BusEvent, EventBus};
use super::hub::{SessionHub, Since};
use super::pairing::RemoteStore;
use super::protocol::{self, ClientMessage, RemoteChat, RemoteEvent, Request, ServerMessage, Waiting, PROTOCOL_VERSION};
use super::secure::{self, Channel, Handshake, Keypair};
use super::transport::Link;
use crate::permission::bridge::Pending;
use crate::ui_event::UiEvent;
use futures_util::stream::{FuturesUnordered, StreamExt};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, watch, Semaphore};

pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// How long a phone has to finish its handshake and say hello.
pub const HANDSHAKE_WAIT: Duration = Duration::from_secs(10);
/// How many phones may be in their handshake at once: a crowd of half-open connections can't hold the door.
pub const HANDSHAKES_AT_ONCE: usize = 4;
/// The longest message a phone may send to a chat.
pub const TEXT_MAX: usize = 100_000;
/// About how big a page of a Reset is, in bytes of JSON.
const PAGE_BYTES: usize = 512 << 10;
/// How many slow requests (what Claude suggests, a chat starting) one phone may have going at once. They run beside the
/// phone's other requests and its chats' events, not in front of them, so a phone waiting on Claude isn't stuck.
pub const SLOW_AT_ONCE: usize = 3;
/// The longest first message a phone may start a chat with (the menu bar panel's limit, in characters).
pub const NEW_CHAT_TEXT_MAX: usize = 20_000;
/// How many chats one phone may start, in how long: a stuck or hostile phone can't fill the Mac with them.
pub const NEW_CHATS_PER_WINDOW: usize = 5;
pub const NEW_CHAT_WINDOW_MS: u64 = 10 * 60 * 1000;

/// Whether a phone's request to start a chat is well formed (whether the project is one is for the gateway to decide).
fn check_new_chat(project: &str, text: &str) -> Result<(), String> {
    if !project.starts_with('/') || project.len() > 4096 || project.contains('\0') {
        Err("That isn't a project folder.".into())
    } else if text.trim().is_empty() {
        Err("Write what the chat should start with.".into())
    } else if text.chars().count() > NEW_CHAT_TEXT_MAX {
        Err("That message is too long.".into())
    } else {
        Ok(())
    }
}

/// A character that can't be seen, or that changes how the text around it is drawn: a control (a tab is fine), a zero-width or
/// joining mark, a bidirectional override or isolate, a word joiner, the byte order mark, the soft hyphen. A command with one
/// can read one way where it is shown to be approved and run another.
fn hidden(c: char) -> bool {
    (c.is_control() && c != '\t') || matches!(c, '\u{ad}' | '\u{61c}' | '\u{180e}' | '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206f}' | '\u{feff}')
}

/// Whether a phone's request about a command is well formed: the id is one of a phone's own (so a phone can never type into or
/// stop a command started on the Mac), and a command to run is not empty, not too long, and has nothing in it that can't be seen.
fn check_shell(id: &str, command: Option<&str>) -> Result<(), String> {
    if !protocol::phone_shell_id(id) {
        return Err("That isn't a command id.".into());
    }
    if let Some(command) = command {
        if command.trim().is_empty() {
            return Err("Type a command to run.".into());
        }
        if command.len() > protocol::SHELL_COMMAND_MAX {
            return Err("That command is too long.".into());
        }
        if command.chars().any(hidden) {
            return Err("That command has a character that can't be seen.".into());
        }
    }
    Ok(())
}

/// What a phone is told when it asks for Auto and the Mac's setting says no.
/// What a phone is told when it asks for a team.
const TEAM_ON_MAC: &str = "A team is started on your Mac.";

const NO_STORAGE: &str = "This Mac can't show its storage.";

/// The most ids a phone may name in one clear: a little over what it is ever shown.
const STORAGE_IDS_MAX: usize = 80;

const AUTO_OFF: &str = "Auto from a phone is off. Turn it on in Lantern's Settings, under Remote control.";

/// What the gateway asks of the app. `by` is who asked: the phone's device id (with its message id for a send).
pub trait Host: Send + Sync + 'static {
    /// Says `text` in the chat, with `images` (the gateway has checked them: see protocol::check_images).
    fn send(&self, slot: String, text: String, by: String, images: Vec<protocol::RemoteImage>) -> BoxFut<Result<(), String>>;
    fn interrupt(&self, slot: String) -> BoxFut<Result<(), String>>;
    fn pending(&self, slot: &str) -> Vec<Pending>;
    fn answer(&self, slot: &str, request_id: &str, allow: bool, message: Option<String>, updated_input: Option<serde_json::Value>, by: &str) -> Result<(), String>;
    fn wake(&self, slot: &str) -> Result<(), String>;
    /// Asks the window to close a chat for a phone (the gateway has checked it is listed and idle, asleep or stopped; the window
    /// checks again, and refuses a team's Lead or agent).
    fn close(&self, slot: &str) -> Result<(), String>;
    /// Runs a command a phone typed after "!" in the chat's folder, in a terminal of its own, as the window's own "!" mode does
    /// (the gateway has checked the chat is open and awake, and that the id and the command are well formed). Its output comes
    /// back as the chat's events.
    fn shell_run(&self, slot: String, id: String, command: String) -> BoxFut<Result<(), String>>;
    /// Types `text` and Enter into a command a phone started (the gateway has checked the id is one of a phone's).
    fn shell_input(&self, slot: String, id: String, text: String) -> BoxFut<Result<(), String>>;
    /// Stops a command a phone started, and what it started (the gateway has checked the id is one of a phone's).
    fn shell_stop(&self, slot: &str, id: &str) -> Result<(), String>;
    /// The projects a chat may be started in from a phone, as (folder, name): those the user already works in.
    fn projects(&self) -> BoxFut<Vec<(String, String)>>;
    /// Starts a chat in `folder` (the gateway has checked it is one of `projects`) with `text` as its first message, on
    /// `permissions` (Auto only when the Mac lets phones use it: the gateway has checked, and the window checks again) and
    /// the `preset` (one of the presets listed), without changing what the window shows; the new chat's slot once it is open.
    /// `provider` (one of the providers listed, or None for the project's own) is where it runs.
    #[allow(clippy::too_many_arguments)]
    fn new_chat(&self, folder: String, text: String, by: String, permissions: protocol::RemotePermissions, preset: Option<String>, workflow: protocol::RemoteWorkflow, provider: Option<String>) -> BoxFut<Result<String, String>>;
    /// Puts an open chat on Chat or Step by step: its claude restarts on the same session (the gateway has checked it may; never a team).
    fn set_workflow(&self, slot: &str, workflow: protocol::RemoteWorkflow) -> Result<(), String>;
    /// Puts an open chat on Ask or Auto: its claude restarts on the same session (the gateway has checked it may).
    fn set_permissions(&self, slot: &str, permissions: protocol::RemotePermissions) -> Result<(), String>;
    /// Puts an open chat on one of the presets listed, as above.
    fn set_preset(&self, slot: &str, preset: &str) -> Result<(), String>;
    /// Asks a small model, with no tools and no saved session, and gives its reply (see suggest.rs, which asks for this
    /// rarely and checks what comes back).
    fn suggest_reply(&self, prompt: String) -> BoxFut<Result<String, String>>;
    /// A file the chat changed, as a unified diff from the chat's start; any other file is refused.
    fn diff(&self, slot: String, path: String) -> BoxFut<Result<String, String>>;
    /// A page of the chat's transcript: its last turns (`before` None), or the turns before the `before` it hasn't
    /// shown yet (see history::page).
    fn history(&self, slot: String, before: Option<usize>) -> BoxFut<Result<crate::history::Page, String>>;
    /// The Mac's disk and the items of it a phone may clear (see storage/phone.rs). A host with no storage says so.
    fn storage(&self) -> Result<protocol::RemoteStorage, String> {
        Err(NO_STORAGE.into())
    }
    /// Starts a scan of the Mac's storage in the background; false when one is running already.
    fn storage_scan(&self) -> BoxFut<Result<bool, String>> {
        Box::pin(async { Err(NO_STORAGE.to_string()) })
    }
    /// Starts clearing these items in the background, those of them the Mac finds safe now: how many, and about how many bytes.
    fn storage_clear(&self, _ids: Vec<String>) -> BoxFut<Result<(usize, u64), String>> {
        Box::pin(async { Err(NO_STORAGE.to_string()) })
    }
    fn mac_name(&self) -> String;
    fn app_version(&self) -> String;
    /// The addresses this Mac can be reached at now (a phone keeps them for next time, see ServerMessage::Welcome).
    fn hosts(&self) -> Vec<String> {
        Vec::new()
    }
}

struct Conn {
    device: String,
    kill: watch::Sender<bool>,
}

/// Called whenever a phone connects or goes (the window shows who is connected).
pub type OnChange = Arc<dyn Fn() + Send + Sync>;
/// Called with the chat when a phone opens it.
pub type OnOpen = Arc<dyn Fn(&str) + Send + Sync>;

pub struct Gateway {
    bus: Arc<EventBus>,
    hub: Arc<SessionHub>,
    store: Arc<RemoteStore>,
    host: Arc<dyn Host>,
    mac: Keypair,
    conns: Mutex<HashMap<u64, Conn>>,
    handshakes: Arc<Semaphore>,
    next: AtomicU64,
    now: fn() -> u64,
    on_change: Mutex<Option<OnChange>>,
    /// This run of Lantern's (see Request::Subscribe): event numbers from another one mean nothing here.
    epoch: u64,
    /// Remote control was turned off: nothing more gets in, not even a phone in the middle of its handshake.
    shut: std::sync::atomic::AtomicBool,
    /// How many phones follow each chat now (a chat nobody follows is one a push may be about).
    watchers: Mutex<HashMap<String, u32>>,
    on_open: Mutex<Option<OnOpen>>,
    /// When each phone started its latest chats (ms), for the limit on how fast it may.
    started: Mutex<HashMap<String, Vec<u64>>>,
    /// What Claude suggests next, kept and shared by every phone.
    suggester: super::suggest::Suggester,
    /// Which phone started each command, so only that phone answers or stops it.
    shells: Mutex<ShellOwners>,
}

/// How many commands' owners are remembered: the oldest is forgotten first, and its command ended long ago.
const SHELL_OWNERS_MAX: usize = 512;

/// The phone (its device id) that started each command, by chat and command id.
#[derive(Default)]
struct ShellOwners {
    by: HashMap<(String, String), String>,
    order: std::collections::VecDeque<(String, String)>,
}

impl ShellOwners {
    fn claim(&mut self, slot: &str, id: &str, device: &str) {
        let key = (slot.to_string(), id.to_string());
        if self.by.insert(key.clone(), device.to_string()).is_none() {
            self.order.push_back(key);
            if self.order.len() > SHELL_OWNERS_MAX {
                if let Some(old) = self.order.pop_front() {
                    self.by.remove(&old);
                }
            }
        }
    }

    fn owns(&self, slot: &str, id: &str, device: &str) -> bool {
        self.by.get(&(slot.to_string(), id.to_string())).is_some_and(|d| d == device)
    }
}

/// Why a connection ended before it was in (for tests and logs; the phone just sees it close).
#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    Busy,
    TooSlow,
    NotPaired,
    NoCode,
    Handshake(String),
    Protocol(String),
}

impl Gateway {
    pub fn new(bus: Arc<EventBus>, hub: Arc<SessionHub>, store: Arc<RemoteStore>, host: Arc<dyn Host>, mac: Keypair, epoch: u64) -> Arc<Self> {
        Arc::new(Self {
            bus,
            hub,
            store,
            host,
            mac,
            conns: Mutex::default(),
            handshakes: Arc::new(Semaphore::new(HANDSHAKES_AT_ONCE)),
            next: AtomicU64::new(1),
            now: super::now_ms,
            on_change: Mutex::new(None),
            epoch,
            shut: Default::default(),
            watchers: Mutex::default(),
            on_open: Mutex::new(None),
            started: Mutex::default(),
            suggester: Default::default(),
            shells: Mutex::default(),
        })
    }

    /// What Claude suggests for the chats as they are (see suggest.rs): the answer to Request::Suggest.
    async fn suggest(&self, refresh: bool) -> Result<serde_json::Value, String> {
        let host = self.host.clone();
        let projects = host.projects().await;
        let chats = super::suggest::digests(&self.hub);
        let suggestions = self.suggester.get((self.now)(), &chats, &projects, refresh, |prompt| host.suggest_reply(prompt)).await?;
        serde_json::to_value(&suggestions).map_err(|e| e.to_string())
    }

    /// Starts a chat for `device` in `project` with `text`: the answer to Request::NewChat. The folder must be exactly one
    /// of the projects, and the phone may only start so many.
    #[allow(clippy::too_many_arguments)]
    async fn start_chat(&self, device: &str, project: String, text: String, permissions: Option<protocol::RemotePermissions>, preset: Option<String>, workflow: Option<protocol::RemoteWorkflow>, provider: Option<String>) -> Result<serde_json::Value, String> {
        check_new_chat(&project, &text)?;
        // A plain chat unless Step by step was asked for: a team is started and led on the Mac.
        let workflow = workflow.unwrap_or(protocol::RemoteWorkflow::Chat);
        if workflow == protocol::RemoteWorkflow::Team {
            return Err(TEAM_ON_MAC.into());
        }
        // Ask unless the phone asked for Auto and the Mac lets phones have it.
        let permissions = permissions.unwrap_or(protocol::RemotePermissions::Ask);
        self.check_choice(permissions, preset.as_deref())?;
        self.check_provider(provider.as_deref(), permissions, preset.as_deref())?;
        // The phone names a folder; whether it is one of the user's projects is decided here, by exact match.
        if !self.host.projects().await.iter().any(|(folder, _)| *folder == project) {
            return Err("That isn't one of your projects.".into());
        }
        self.allow_new_chat(device)?;
        let slot = self.host.new_chat(project, text, device.to_string(), permissions, preset, workflow, provider).await?;
        serde_json::to_value(protocol::StartedChat { slot }).map_err(|e| e.to_string())
    }

    /// Whether a phone may start a chat where it asks to: only on a provider the window listed (never a name the phone made up),
    /// and not on Auto or a Claude preset where that provider has none: the phone's sheet doesn't offer them, and a request that
    /// does is refused in words rather than quietly run as something else. None is the project's own, whatever that is.
    fn check_provider(&self, provider: Option<&str>, permissions: protocol::RemotePermissions, preset: Option<&str>) -> Result<(), String> {
        let Some(id) = provider else { return Ok(()) };
        let listed = self.hub.providers();
        let Some(p) = listed.iter().find(|p| p.id == id) else { return Err("That isn't one of your providers.".into()) };
        if permissions == protocol::RemotePermissions::Auto && !p.auto {
            return Err(format!("{} has no Auto mode: it asks before it acts.", p.name));
        }
        if preset.is_some() && !p.presets {
            return Err(format!("{} runs on its own model: the presets don't apply to it.", p.name));
        }
        Ok(())
    }

    /// Whether a phone may choose this for a chat: Auto only when the Mac's setting lets phones use it (read here, from what the
    /// user saved, never from what the phone says), and a preset only if it is one the window listed.
    fn check_choice(&self, permissions: protocol::RemotePermissions, preset: Option<&str>) -> Result<(), String> {
        if permissions == protocol::RemotePermissions::Auto && !self.store.saved().allow_phone_auto {
            return Err(AUTO_OFF.into());
        }
        if let Some(p) = preset {
            if !self.hub.presets().iter().any(|x| x.id == p) {
                return Err("That isn't one of your presets.".into());
            }
        }
        Ok(())
    }

    /// The chat, if it can be switched now: listed, awake and doing nothing. Switching restarts its claude, which would drop
    /// what it is doing and withdraw a question it asked.
    fn switchable(&self, slot: &str) -> Result<super::hub::ChatInfo, String> {
        use super::hub::ChatStatus as S;
        let chat = self.hub.chat(slot).ok_or("That chat isn't open on your Mac.")?;
        match chat.status {
            S::Idle => Ok(chat),
            S::Working | S::NeedsYou => Err("Claude is busy in this chat. Change it once it has finished.".into()),
            S::Asleep => Err("This chat is asleep. Wake it first.".into()),
            S::Ended => Err("This chat has stopped.".into()),
        }
    }

    /// Counts a chat started by `device`, or refuses it: too many lately.
    fn allow_new_chat(&self, device: &str) -> Result<(), String> {
        self.allow_new_chat_at(device, (self.now)())
    }

    fn allow_new_chat_at(&self, device: &str, now: u64) -> Result<(), String> {
        let mut started = self.started.lock().unwrap();
        let recent = started.entry(device.to_string()).or_default();
        recent.retain(|t| now.saturating_sub(*t) < NEW_CHAT_WINDOW_MS);
        if recent.len() >= NEW_CHATS_PER_WINDOW {
            return Err("This phone has started a lot of chats just now. Try again in a few minutes.".into());
        }
        recent.push(now);
        Ok(())
    }

    /// Whether a phone follows the chat right now.
    pub fn watched(&self, slot: &str) -> bool {
        self.watchers.lock().unwrap().get(slot).is_some_and(|n| *n > 0)
    }

    /// What to do when a phone opens a chat (the notifier forgets what it pushed about it).
    pub fn on_open(&self, f: OnOpen) {
        *self.on_open.lock().unwrap() = Some(f);
    }

    fn watch(&self, slot: &str) {
        *self.watchers.lock().unwrap().entry(slot.to_string()).or_insert(0) += 1;
    }

    fn unwatch(&self, slot: &str) {
        let mut w = self.watchers.lock().unwrap();
        if let Some(n) = w.get_mut(slot) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                w.remove(slot);
            }
        }
    }

    fn is_shut(&self) -> bool {
        self.shut.load(Ordering::SeqCst)
    }

    pub fn on_change(&self, f: OnChange) {
        *self.on_change.lock().unwrap() = Some(f);
    }

    fn changed(&self) {
        let f = self.on_change.lock().unwrap().clone();
        if let Some(f) = f {
            f();
        }
    }

    /// Takes a phone's connection: it is let in, or closed.
    pub fn accept(self: &Arc<Self>, link: Link) {
        if self.is_shut() {
            return;
        }
        let me = self.clone();
        tokio::spawn(async move {
            let _ = me.serve(link).await;
        });
    }

    /// The device ids of the phones connected now.
    pub fn connected(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.conns.lock().unwrap().values().map(|c| c.device.clone()).collect();
        ids.sort();
        ids.dedup();
        ids
    }

    /// Closes every connection of a device (it was removed).
    pub fn disconnect_device(&self, device: &str) {
        for c in self.conns.lock().unwrap().values().filter(|c| c.device == device) {
            let _ = c.kill.send(true);
        }
    }

    /// Closes every connection, and lets nothing in from now on (Remote control was turned off).
    pub fn disconnect_all(&self) {
        self.shut.store(true, Ordering::SeqCst);
        for c in self.conns.lock().unwrap().values() {
            let _ = c.kill.send(true);
        }
    }

    async fn serve(self: Arc<Self>, mut link: Link) -> Result<(), Refused> {
        let permit = self.handshakes.clone().try_acquire_owned().map_err(|_| Refused::Busy)?;
        let (device, mut channel, extras) = tokio::time::timeout(HANDSHAKE_WAIT, self.come_in(&mut link)).await.map_err(|_| Refused::TooSlow)??;
        drop(permit);
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (kill, mut killed) = watch::channel(false);
        self.conns.lock().unwrap().insert(id, Conn { device: device.clone(), kill });
        // Removed in the meantime (between its key being checked and now), or Remote control turned off: it doesn't stay.
        if self.is_shut() || self.store.saved().devices.iter().all(|d| d.id != device) {
            self.conns.lock().unwrap().remove(&id);
            return Err(Refused::NotPaired);
        }
        self.store.seen(&device, (self.now)());
        self.changed();
        let mut session = Session { gw: &self, device: device.clone(), extras, last_plan: None, subscribed: HashMap::new(), unnamed: HashSet::new(), last_chats: Vec::new() };
        let _ = session.run(&mut link, &mut channel, &mut killed).await;
        self.conns.lock().unwrap().remove(&id);
        self.store.seen(&device, (self.now)());
        self.changed();
        Ok(())
    }

    /// The handshake, then the phone's hello: who it is, once it has proved it.
    async fn come_in(&self, link: &mut Link) -> Result<(String, Channel, bool), Refused> {
        let mode = recv(link).await.ok_or(Refused::Protocol("closed".into()))?;
        let pairing = match mode.as_slice() {
            [secure::PAIR] => true,
            [secure::CONNECT] => false,
            _ => return Err(Refused::Protocol("an unknown mode".into())),
        };
        // No code on screen: nothing to pair with (and an open code isn't burned by a phone that only connects).
        if pairing && !self.store.offer_open((self.now)()) {
            return Err(Refused::NoCode);
        }
        let first = recv(link).await.ok_or(Refused::Protocol("closed".into()))?;
        let mut hs = if pairing {
            // Used up by this attempt whether it works or not: a code can be tried once.
            let secret = self.store.take_offer((self.now)()).ok_or(Refused::NoCode);
            // The code on screen is used up (Settings takes it away).
            self.changed();
            let secret = secret?;
            Handshake::pair_responder(&self.mac, &secret)
        } else {
            Handshake::connect_responder(&self.mac)
        }
        .map_err(Refused::Handshake)?;
        hs.read(&first).map_err(Refused::Handshake)?;
        send_raw(link, hs.write().map_err(Refused::Handshake)?).await?;
        let third = recv(link).await.ok_or(Refused::Protocol("closed".into()))?;
        hs.read(&third).map_err(Refused::Handshake)?;
        let (key, mut channel) = hs.finish().map_err(Refused::Handshake)?;
        let known = self.store.device_by_key(&key);
        if !pairing && known.is_none() {
            return Err(Refused::NotPaired);
        }
        let hello = recv_message(link, &mut channel).await.ok_or(Refused::Protocol("no hello".into()))?;
        let ClientMessage::Hello { protocol: theirs, device_name, features, .. } = hello else { return Err(Refused::Protocol("no hello".into())) };
        let welcome = ServerMessage::Welcome { protocol: PROTOCOL_VERSION, app_version: self.host.app_version(), mac_name: self.host.mac_name(), epoch: self.epoch, features: protocol::FEATURES.iter().map(|f| f.to_string()).collect(), hosts: self.host.hosts() };
        send_message(link, &mut channel, &welcome).map_err(Refused::Protocol)?;
        // Told which version this Mac speaks, so the phone can say what to update; it isn't paired or let in.
        if theirs != PROTOCOL_VERSION {
            return Err(Refused::Protocol(format!("protocol {theirs}")));
        }
        let device = match known {
            Some(d) if !pairing => d,
            _ => self.store.add_device(&key, &device_name, (self.now)()).map_err(Refused::Protocol)?,
        };
        Ok((device.id, channel, features.iter().any(|f| f == protocol::PHONE_EXTRAS)))
    }
}

async fn recv(link: &mut Link) -> Option<Vec<u8>> {
    link.from_peer.recv().await
}

async fn send_raw(link: &mut Link, frame: Vec<u8>) -> Result<(), Refused> {
    link.to_peer.send(frame).await.map_err(|_| Refused::Protocol("closed".into()))
}

/// The phone's next whole message, opened and read (None: it closed, or sent something that isn't one).
async fn recv_message(link: &mut Link, channel: &mut Channel) -> Option<ClientMessage> {
    loop {
        let frame = link.from_peer.recv().await?;
        match channel.open(&frame) {
            Ok(Some(plain)) => return serde_json::from_slice(&plain).ok(),
            Ok(None) => continue,
            Err(_) => return None,
        }
    }
}

/// Seals a message and queues its frames. A phone too slow to take them is dropped (Err): it catches up when it
/// connects again.
fn send_message(link: &Link, channel: &mut Channel, msg: &ServerMessage) -> Result<(), String> {
    let json = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
    for frame in channel.seal(&json)? {
        link.to_peer.try_send(frame).map_err(|_| "The phone is too slow; it was disconnected.".to_string())?;
    }
    Ok(())
}

/// Seals a message and sends its frames, waiting for the phone to take them: for a catch-up, which may be bigger than
/// what a phone's outbox holds at once (a live event goes with `send_message`, which doesn't wait).
async fn send_message_waiting(link: &Link, channel: &mut Channel, msg: &ServerMessage) -> Result<(), String> {
    let json = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
    for frame in channel.seal(&json)? {
        tokio::time::timeout(HANDSHAKE_WAIT, link.to_peer.send(frame)).await.map_err(|_| "The phone stopped reading.".to_string())?.map_err(|_| "The phone went.".to_string())?;
    }
    Ok(())
}

/// One phone's connection, once it is in.
struct Session<'a> {
    gw: &'a Gateway,
    device: String,
    /// Whether the phone said it can read the extras events (see protocol::PHONE_EXTRAS).
    extras: bool,
    /// The chats it subscribed to, with the number of the last event it was sent of each.
    subscribed: HashMap<String, u64>,
    /// The account's usage as it was last sent to this phone (it is sent again only when it changes).
    last_plan: Option<PlanSent>,
    /// Chats it was sent a reset of before the hub knew their session, so before their transcript could be found: they
    /// are reset again once it is known (a chat restored from History is opened on the phone before the window says which
    /// session it is).
    unnamed: HashSet<String>,
    last_chats: Vec<RemoteChat>,
}

impl Drop for Session<'_> {
    /// The phone is gone: it follows nothing now.
    fn drop(&mut self) {
        for slot in self.subscribed.keys() {
            self.gw.unwatch(slot);
        }
    }
}

/// The five-hour window and the weekly one, as a phone was last told them.
type PlanSent = ((f64, Option<u64>, String), Option<(f64, Option<u64>)>);

/// The answer to request `id`, sealed and queued for the phone.
fn respond(link: &Link, channel: &mut Channel, id: u64, answer: Result<serde_json::Value, String>) -> Result<(), String> {
    let (ok, error) = match answer {
        Ok(v) => (Some(v), None),
        Err(e) => (None, Some(e)),
    };
    send_message(link, channel, &ServerMessage::Response { id, ok, error })
}

/// A request's answer in the making: what takes long (see `SLOW_AT_ONCE`).
type Slow<'a> = Pin<Box<dyn Future<Output = (u64, Result<serde_json::Value, String>)> + Send + 'a>>;

impl<'a> Session<'a> {
    /// The phone follows `slot` from event `last` on; it has opened the chat (what was pushed about it has been seen).
    fn follow(&mut self, slot: &str, last: u64) {
        if self.subscribed.insert(slot.to_string(), last).is_none() {
            self.gw.watch(slot);
        }
        let open = self.gw.on_open.lock().unwrap().clone();
        if let Some(open) = open {
            open(slot);
        }
    }

    /// The chats it is following whose session has become known since they were last reset.
    fn named_since_reset(&mut self) -> Vec<String> {
        let named: Vec<String> = self.unnamed.iter().filter(|s| self.subscribed.contains_key(*s) && self.gw.hub.chat(s).is_some_and(|c| c.session_id.is_some())).cloned().collect();
        self.unnamed.retain(|s| self.subscribed.contains_key(s) && !named.contains(s));
        named
    }

    fn unfollow(&mut self, slot: &str) {
        if self.subscribed.remove(slot).is_some() {
            self.gw.unwatch(slot);
        }
    }

    async fn run(&mut self, link: &mut Link, channel: &mut Channel, killed: &mut watch::Receiver<bool>) -> Result<(), String> {
        let mut events = self.gw.bus.subscribe();
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        // What takes long (Claude thinking up suggestions, a chat opening) is waited for here, beside the loop's other work:
        // the phone's other requests are answered, and its chats' events keep coming, meanwhile. Dropped with the
        // connection, which stops what they were waiting on.
        let gw: &'a Gateway = self.gw;
        let mut slow: FuturesUnordered<Slow<'a>> = FuturesUnordered::new();
        self.send_chats(link, channel, true)?;
        self.send_plan(link, channel)?;
        loop {
            tokio::select! {
                _ = killed.changed() => return Ok(()),
                frame = link.from_peer.recv() => {
                    let Some(frame) = frame else { return Ok(()) };
                    let Some(plain) = channel.open(&frame)? else { continue };
                    let msg: ClientMessage = serde_json::from_slice(&plain).map_err(|e| e.to_string())?;
                    let ClientMessage::Request { id, request } = msg else { continue };
                    match request {
                        Request::Suggest { .. } | Request::NewChat { .. } if slow.len() >= SLOW_AT_ONCE => {
                            respond(link, channel, id, Err("That is one thing at a time: wait for the others to finish first.".into()))?;
                        }
                        Request::Suggest { refresh } => slow.push(Box::pin(async move { (id, gw.suggest(refresh).await) })),
                        Request::NewChat { project, text, permissions, preset, workflow, provider } => {
                            let device = self.device.clone();
                            slow.push(Box::pin(async move { (id, gw.start_chat(&device, project, text, permissions, preset, workflow, provider).await) }));
                        }
                        request => {
                            let answer = self.handle(link, channel, request).await;
                            respond(link, channel, id, answer)?;
                        }
                    }
                }
                Some((id, answer)) = slow.next(), if !slow.is_empty() => respond(link, channel, id, answer)?,
                ev = events.recv() => match ev {
                    Ok(ev) => self.forward(link, channel, &ev)?,
                    // Fell behind the bus: each chat it follows starts over from the hub.
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        for slot in self.subscribed.keys().cloned().collect::<Vec<_>>() {
                            self.reset(link, channel, &slot).await?;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => return Ok(()),
                },
                _ = tick.tick() => {
                    self.send_chats(link, channel, false)?;
                    self.send_plan(link, channel)?;
                    for slot in self.named_since_reset() {
                        self.reset(link, channel, &slot).await?;
                    }
                }
            }
        }
    }

    fn forward(&mut self, link: &Link, channel: &mut Channel, ev: &BusEvent) -> Result<(), String> {
        let Some(last) = self.subscribed.get_mut(&ev.slot) else { return Ok(()) };
        // Already sent (it came with what the hub had when the phone subscribed).
        if ev.seq <= *last {
            return Ok(());
        }
        *last = ev.seq;
        match protocol::to_remote_for(&ev.event, self.extras) {
            Some(event) => send_message(link, channel, &ServerMessage::Event { slot: ev.slot.clone(), seq: ev.seq, event }),
            None => Ok(()),
        }
    }

    /// The subscription's usage, to a phone that can read it: when it has been said and differs from what this phone was told.
    fn send_plan(&mut self, link: &Link, channel: &mut Channel) -> Result<(), String> {
        let sent: Option<PlanSent> = self.gw.hub.plan().map(|five| (five, self.gw.hub.week()));
        if !self.extras || sent.is_none() || sent == self.last_plan {
            return Ok(());
        }
        if let Some(((used, resets_at, status), week)) = sent.clone() {
            send_message(link, channel, &ServerMessage::Plan { used, resets_at, status, week_used: week.map(|w| w.0), week_resets_at: week.and_then(|w| w.1) })?;
        }
        self.last_plan = sent;
        Ok(())
    }

    fn send_chats(&mut self, link: &Link, channel: &mut Channel, always: bool) -> Result<(), String> {
        let chats: Vec<RemoteChat> = self.gw.hub.chats().into_iter().map(RemoteChat::from).collect();
        // Only what a list shows counts as a change, not every new event's number (a chat's mode and preset are shown).
        let shown = |c: &[RemoteChat]| c.iter().map(|c| (c.slot.clone(), c.title.clone(), c.status, c.permissions, c.preset.clone(), c.project_color.clone(), c.workflow, c.preview.clone())).collect::<Vec<_>>();
        if always || shown(&chats) != shown(&self.last_chats) {
            send_message(link, channel, &ServerMessage::Chats { chats: chats.clone() })?;
        }
        self.last_chats = chats;
        Ok(())
    }

    /// The chat's last turns, in pages: the transcript's, then the current turn as far as the hub has it. Earlier turns
    /// come when the phone asks (Request::Earlier).
    async fn reset(&mut self, link: &Link, channel: &mut Channel, slot: &str) -> Result<(), String> {
        let seq = self.gw.bus.last_seq(slot);
        if self.gw.hub.chat(slot).is_some_and(|c| c.session_id.is_none()) {
            self.unnamed.insert(slot.to_string());
        } else {
            self.unnamed.remove(slot);
        }
        let page = self.gw.host.history(slot.to_string(), None).await.unwrap_or(crate::history::Page { events: vec![], hidden: 0 });
        let hidden = page.hidden as u32;
        let extras = self.extras;
        let mut events: Vec<RemoteEvent> = page.events.iter().filter_map(|e| protocol::to_remote_for(e, extras)).collect();
        // A turn still going isn't all in the transcript yet: what the hub has of it since its message comes after. A turn
        // waiting on a prompt is still going.
        if self.gw.hub.chat(slot).is_some_and(|c| matches!(c.status, super::hub::ChatStatus::Working | super::hub::ChatStatus::NeedsYou)) {
            if let Some(Since::Events(kept) | Since::TooOld { kept }) = self.gw.hub.since(slot, 0) {
                // From the message the user sent: a hook's message after it is still that turn's.
                let start = kept.iter().rposition(|e| matches!(&e.event, UiEvent::UserText { text, .. } if crate::hooks::post_text(text).is_none())).unwrap_or(0);
                let live: Vec<RemoteEvent> = kept[start..].iter().filter(|e| e.seq <= seq).filter_map(|e| protocol::to_remote_for(&e.event, extras)).collect();
                events = merge_current_turn(events, live);
            }
        }
        // What claude offers after a "/", its plan and the context it holds: the latest of each, since the kept events may not reach them.
        if extras {
            events.extend(self.gw.hub.extras(slot));
        }
        for (page, (events, done)) in pages(events).into_iter().enumerate() {
            send_message_waiting(link, channel, &ServerMessage::Reset { slot: slot.to_string(), seq, page: page as u32, done, hidden, events }).await?;
        }
        self.follow(slot, seq);
        Ok(())
    }

    /// Whether this phone started the command: another phone's can't be answered (it may be reading a password) or stopped.
    fn owns_shell(&self, slot: &str, id: &str) -> Result<(), String> {
        if self.gw.shells.lock().unwrap().owns(slot, id, &self.device) {
            Ok(())
        } else {
            Err("That isn't a command this phone started.".into())
        }
    }

    fn chat_known(&self, slot: &str) -> Result<(), String> {
        self.gw.hub.chat(slot).map(|_| ()).ok_or_else(|| "That chat isn't open on your Mac.".to_string())
    }

    async fn handle(&mut self, link: &Link, channel: &mut Channel, request: Request) -> Result<serde_json::Value, String> {
        let host = self.gw.host.clone();
        let json = |v: &dyn erased::Ser| v.to_json();
        match request {
            Request::ListChats => Ok(json(&self.gw.hub.chats().into_iter().map(RemoteChat::from).collect::<Vec<_>>())),
            Request::ListWaiting => Ok(json(&self.waiting())),
            Request::Subscribe { slot, after, epoch } => {
                self.chat_known(&slot)?;
                // A number from another run of Lantern, or one it hasn't reached: the phone starts the chat over.
                let comparable = epoch == self.gw.epoch && after <= self.gw.bus.last_seq(&slot);
                match self.gw.hub.since(&slot, after) {
                    Some(Since::Events(events)) if after > 0 && comparable => {
                        let last = events.last().map_or(after, |e| e.seq);
                        for e in &events {
                            if let Some(event) = protocol::to_remote_for(&e.event, self.extras) {
                                send_message(link, channel, &ServerMessage::Event { slot: slot.clone(), seq: e.seq, event })?;
                            }
                        }
                        self.follow(&slot, last);
                    }
                    _ => self.reset(link, channel, &slot).await?,
                }
                Ok(serde_json::Value::Null)
            }
            Request::Earlier { slot, hidden } => {
                self.chat_known(&slot)?;
                let page = host.history(slot, Some(hidden as usize)).await?;
                Ok(json(&protocol::EarlierPage { events: page.events.iter().filter_map(|e| protocol::to_remote_for(e, self.extras)).collect(), hidden: page.hidden as u32 }))
            }
            Request::Unsubscribe { slot } => {
                self.unfollow(&slot);
                Ok(serde_json::Value::Null)
            }
            Request::Send { slot, text, client_id, images } => {
                self.chat_known(&slot)?;
                let images = images.unwrap_or_default();
                // Pictures may be all there is to a message.
                if (text.trim().is_empty() && images.is_empty()) || text.len() > TEXT_MAX {
                    return Err("That message is empty, or too long.".into());
                }
                if client_id.is_empty() || client_id.len() > 64 || !client_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                    return Err("That message has no proper id.".into());
                }
                protocol::check_images(&images)?;
                host.send(slot, text, format!("{}:{client_id}", self.device), images).await.map(|()| serde_json::Value::Null)
            }
            Request::Interrupt { slot } => {
                self.chat_known(&slot)?;
                host.interrupt(slot).await.map(|()| serde_json::Value::Null)
            }
            Request::Answer { slot, request_id, allow, message, answers } => {
                self.chat_known(&slot)?;
                let asked = host.pending(&slot).into_iter().find(|p| p.request_id == request_id).ok_or("That was answered already, or Claude stopped asking.")?;
                // On deny there is nothing to run, so no answers matter. Otherwise the tool runs with Claude's own input,
                // a question's with the answers added (see answers.rs).
                let updated = match answers {
                    Some(a) if allow => Some(answers::with_answers(&asked.tool_name, &asked.input, &a)?),
                    _ => None,
                };
                let message = message.map(|m| m.chars().take(10_000).collect());
                host.answer(&slot, &request_id, allow, message, updated, &self.device).map(|()| serde_json::Value::Null)
            }
            Request::Wake { slot } => {
                self.chat_known(&slot)?;
                host.wake(&slot).map(|()| serde_json::Value::Null)
            }
            Request::Close { slot } => {
                use super::hub::ChatStatus as S;
                let chat = self.gw.hub.chat(&slot).ok_or("That chat isn't open on your Mac.")?;
                // A chat that is doing something is stopped first: closing it would drop the work and the question it asked.
                if matches!(chat.status, S::Working | S::NeedsYou) {
                    return Err("Claude is busy in this chat. Stop it first, then close it.".into());
                }
                host.close(&slot).map(|()| serde_json::Value::Null)
            }
            Request::Projects => Ok(json(&host.projects().await.into_iter().map(|(id, name)| protocol::RemoteProject { id, name }).collect::<Vec<_>>())),
            // These two can take long: the connection's loop runs them beside everything else (see `run`); asked here, as a
            // plain request, they are the same thing.
            Request::NewChat { project, text, permissions, preset, workflow, provider } => self.gw.start_chat(&self.device, project, text, permissions, preset, workflow, provider).await,
            Request::SetWorkflow { slot, workflow } => {
                if workflow == protocol::RemoteWorkflow::Team {
                    return Err(TEAM_ON_MAC.into());
                }
                let chat = self.gw.switchable(&slot)?;
                if chat.workflow.as_deref() == Some("team") {
                    return Err("This chat leads a team: change it on your Mac.".into());
                }
                // What it already is is not asked again: each switch restarts claude.
                if chat.workflow.as_deref() == Some(workflow.as_str()) {
                    return Ok(serde_json::Value::Null);
                }
                host.set_workflow(&slot, workflow).map(|()| serde_json::Value::Null)
            }
            Request::Controls => Ok(json(&protocol::Controls { allow_auto: self.gw.store.saved().allow_phone_auto, presets: self.gw.hub.presets(), providers: Some(self.gw.hub.providers()) })),
            Request::SetPermissions { slot, permissions } => {
                self.gw.check_choice(permissions, None)?;
                let chat = self.gw.switchable(&slot)?;
                // A chat on another provider than Claude's has no auto mode (a model approving its own commands is no safety): a phone
                // that still offers Auto (an older one) is told why, and nothing is restarted. The window and the backend hold the line too.
                if let (protocol::RemotePermissions::Auto, Some(name)) = (permissions, &chat.provider) {
                    if !self.gw.hub.providers().iter().find(|p| &p.name == name).is_some_and(|p| p.auto) {
                        return Err(format!("{name} has no Auto mode: it asks before it acts."));
                    }
                }
                // What it already is is not asked again: each switch restarts claude, and a phone can't make it do so over and over.
                if chat.permissions.as_deref() == Some(permissions.as_str()) {
                    return Ok(serde_json::Value::Null);
                }
                host.set_permissions(&slot, permissions).map(|()| serde_json::Value::Null)
            }
            Request::SetPreset { slot, preset } => {
                self.gw.check_choice(protocol::RemotePermissions::Ask, Some(&preset))?;
                let chat = self.gw.switchable(&slot)?;
                // The Mac's presets are Claude Code's models: a chat on another provider runs on its own.
                if let Some(name) = &chat.provider {
                    return Err(format!("{name} runs on its own model: the presets don't apply to it."));
                }
                if chat.preset.as_deref() == Some(preset.as_str()) {
                    return Ok(serde_json::Value::Null);
                }
                host.set_preset(&slot, &preset).map(|()| serde_json::Value::Null)
            }
            Request::Diff { slot, path } => {
                self.chat_known(&slot)?;
                host.diff(slot, path).await.map(serde_json::Value::String)
            }
            Request::StepOutput { slot, tool_use_id } => {
                self.chat_known(&slot)?;
                self.gw.hub.step_output(&slot, &tool_use_id).map(serde_json::Value::String).ok_or_else(|| "That step's output isn't kept any more. It is on your Mac.".to_string())
            }
            // The same code as the Mac's own "Show a pairing code" (Remote::pair), made for a phone that is already paired and
            // shows it to a second device. Whoever holds the phone and can pass its Face ID check can make one: the phone is the
            // only place that is checked, as for the terminal. The link is never logged.
            Request::PairOffer => {
                let offer = self.gw.store.start_offer(super::now_ms())?;
                let link = super::pairing::pairing_link(&self.gw.mac.public, &offer, &host.hosts(), super::port(), &host.mac_name());
                Ok(json(&protocol::PairOffer { modules: super::pairing::qr_modules(&link)?, link, expires_at: offer.expires_at }))
            }
            Request::Storage => host.storage().map(|v| json(&v)),
            Request::StorageScan => host.storage_scan().await.map(|started| json(&started)),
            // The Mac decides what is safe: the ids are only a choice among what it would clear anyway (storage/phone.rs). The
            // phone has asked Face ID and a swipe; unpairing it is the kill switch, as for the terminal.
            Request::StorageClear { ids } => {
                if ids.is_empty() || ids.len() > STORAGE_IDS_MAX || ids.iter().any(|id| id.is_empty() || id.len() > 16 || !id.chars().all(|c| c.is_ascii_hexdigit())) {
                    return Err("That isn't a list the Mac sent.".into());
                }
                host.storage_clear(ids).await.map(|(count, bytes)| json(&serde_json::json!({ "started": count, "bytes": bytes })))
            }
            Request::Shell { slot, id, command } => {
                use super::hub::ChatStatus as S;
                let chat = self.gw.hub.chat(&slot).ok_or("That chat isn't open on your Mac.")?;
                check_shell(&id, Some(&command))?;
                if chat.status == S::Asleep {
                    return Err("This chat is asleep. Wake it first.".into());
                }
                host.shell_run(slot.clone(), id.clone(), command).await?;
                // It is this phone's: no other answers or stops it.
                self.gw.shells.lock().unwrap().claim(&slot, &id, &self.device);
                Ok(serde_json::Value::Null)
            }
            Request::ShellInput { slot, id, text } => {
                self.chat_known(&slot)?;
                check_shell(&id, None)?;
                self.owns_shell(&slot, &id)?;
                // Enter is added by the Mac: no control characters (a newline, ⌃D, an escape) come from a phone.
                if text.len() > protocol::SHELL_INPUT_MAX || text.chars().any(|c| c.is_control()) {
                    return Err("That reply is too long, or has a character a terminal reads as a key.".into());
                }
                host.shell_input(slot, id, text).await.map(|()| serde_json::Value::Null)
            }
            Request::ShellStop { slot, id } => {
                self.chat_known(&slot)?;
                check_shell(&id, None)?;
                self.owns_shell(&slot, &id)?;
                host.shell_stop(&slot, &id).map(|()| serde_json::Value::Null)
            }
            Request::Suggest { refresh } => self.gw.suggest(refresh).await,
            Request::PushToken { token } => self.gw.store.set_push_token(&self.device, &token).map(|()| serde_json::Value::Null),
            Request::PushKey { key } => self.gw.store.set_push_key(&self.device, &key).map(|()| serde_json::Value::Null),
            Request::LiveActivity { start_token, card } => {
                use super::live_activity::{clean_project, valid_token, LiveCard, Status};
                if start_token.as_deref().is_some_and(|t| !valid_token(t)) {
                    return Err("That isn't a push token.".into());
                }
                let now = (self.gw.now)();
                let card = match card {
                    Some(c) => {
                        self.chat_known(&c.slot)?;
                        if !valid_token(&c.token) {
                            return Err("That isn't a push token.".into());
                        }
                        // The turn it shows began a moment ago, not in the future or long ago: the card's timer counts from it.
                        let since = c.since.clamp(now.saturating_sub(60 * 60 * 1000), now);
                        Some(LiveCard { slot: c.slot, token: c.token, project: clean_project(&c.project), since, status: Status::Working, ended: false, registered_at: now, last_push: now, needs: None, detail: Default::default() })
                    }
                    None => None,
                };
                self.gw.store.live.register(&self.device, start_token, card);
                Ok(serde_json::Value::Null)
            }
        }
    }

    /// What waits on the user in every chat, the oldest first.
    fn waiting(&self) -> Vec<Waiting> {
        let mut all: Vec<Waiting> = self
            .gw
            .hub
            .chats()
            .into_iter()
            .flat_map(|chat| {
                self.gw.host.pending(&chat.slot).into_iter().map(move |p| Waiting { slot: chat.slot.clone(), chat_title: chat.title.clone(), request_id: p.request_id, tool_name: p.tool_name, input: protocol::trimmed(&p.input), at: p.at })
            })
            .collect();
        all.sort_by_key(|w| w.at);
        all
    }
}

/// The transcript's events with the hub's of the turn still going after them. The transcript may already hold that turn's
/// start (claude writes the message as it takes it), and it holds it from a different source than the hub's copy, so
/// the transcript is cut at that message and the hub's turn replaces what follows it: the same message, written no earlier
/// than the hub's copy (an earlier turn with the same words, like "Next", is not this one).
fn merge_current_turn(mut history: Vec<RemoteEvent>, live: Vec<RemoteEvent>) -> Vec<RemoteEvent> {
    if let Some(RemoteEvent::UserText { text, at: Some(sent), .. }) = live.first() {
        let begun = history.iter().rposition(|e| matches!(e, RemoteEvent::UserText { text: t, at: Some(at), .. } if t == text && *at + 500 >= *sent));
        if let Some(i) = begun {
            history.truncate(i);
        }
    }
    history.extend(live);
    history
}

/// Events in pages of about PAGE_BYTES, each with whether it is the last (an empty chat is one empty page).
fn pages(events: Vec<RemoteEvent>) -> Vec<(Vec<RemoteEvent>, bool)> {
    let mut out: Vec<Vec<RemoteEvent>> = vec![Vec::new()];
    let mut size = 0;
    for e in events {
        let n = serde_json::to_vec(&e).map_or(0, |v| v.len());
        if size + n > PAGE_BYTES && !out.last().is_some_and(Vec::is_empty) {
            out.push(Vec::new());
            size = 0;
        }
        size += n;
        out.last_mut().expect("there is always a page").push(e);
    }
    let last = out.len() - 1;
    out.into_iter().enumerate().map(|(i, p)| (p, i == last)).collect()
}

/// Turns any serializable answer into the Response's JSON.
mod erased {
    pub trait Ser {
        fn to_json(&self) -> serde_json::Value;
    }
    impl<T: serde::Serialize> Ser for T {
        fn to_json(&self) -> serde_json::Value {
            serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::remote::secure::generate_keypair;
    use crate::remote::transport::link_pair;
    use serde_json::json;

    /// An answer the fake app took: the request, allow, the input it runs with, who answered.
    pub type Answered = (String, bool, Option<serde_json::Value>, String);

    /// The app, as far as the gateway's tests need: it records what it was asked.
    #[derive(Default)]
    pub struct FakeHost {
        pub sent: Mutex<Vec<(String, String, String)>>,
        pub answered: Mutex<Vec<Answered>>,
        pub pending: Mutex<Vec<Pending>>,
        /// The pictures that went with each message in `sent`.
        pub sent_images: Mutex<Vec<Vec<protocol::RemoteImage>>>,
        pub woken: Mutex<Vec<String>>,
        pub closed: Mutex<Vec<String>>,
        /// What it was asked about storage ("scan", or "clear:" and the ids), and the disk it says it has.
        pub storage_asked: Mutex<Vec<String>>,
        pub storage_on: Mutex<bool>,
        pub history: Mutex<Vec<UiEvent>>,
        /// The projects it offers for starting a chat in, and the chats it was asked to start (folder, text, by).
        pub projects: Mutex<Vec<(String, String)>>,
        pub started: Mutex<Vec<(String, String, String)>>,
        /// What each chat it was asked to start was to run on (Ask or Auto, the preset), and the switches it was asked for.
        pub started_with: Mutex<Vec<(protocol::RemotePermissions, Option<String>)>>,
        pub switched: Mutex<Vec<String>>,
        pub started_flow: Mutex<Vec<protocol::RemoteWorkflow>>,
        /// Where each chat it was asked to start was to run (None: the project's own).
        pub started_provider: Mutex<Vec<Option<String>>>,
        /// What the model says next (the first is used first; "[]" when none are left), and what it was asked.
        pub replies: Mutex<Vec<Result<String, String>>>,
        pub prompts: Mutex<Vec<String>>,
        /// How long the model takes to answer, and a chat started from a phone takes to open.
        pub suggest_delay: Mutex<Duration>,
        pub new_chat_delay: Mutex<Duration>,
    }

    impl Host for FakeHost {
        fn send(&self, slot: String, text: String, by: String, images: Vec<protocol::RemoteImage>) -> BoxFut<Result<(), String>> {
            self.sent.lock().unwrap().push((slot, text, by));
            self.sent_images.lock().unwrap().push(images);
            Box::pin(async { Ok(()) })
        }
        fn interrupt(&self, _: String) -> BoxFut<Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
        fn pending(&self, _: &str) -> Vec<Pending> {
            self.pending.lock().unwrap().clone()
        }
        fn answer(&self, _: &str, request_id: &str, allow: bool, _: Option<String>, updated: Option<serde_json::Value>, by: &str) -> Result<(), String> {
            self.answered.lock().unwrap().push((request_id.into(), allow, updated, by.into()));
            self.pending.lock().unwrap().retain(|p| p.request_id != request_id);
            Ok(())
        }
        fn wake(&self, slot: &str) -> Result<(), String> {
            self.woken.lock().unwrap().push(slot.into());
            Ok(())
        }
        fn close(&self, slot: &str) -> Result<(), String> {
            self.closed.lock().unwrap().push(slot.into());
            Ok(())
        }
        fn storage(&self) -> Result<protocol::RemoteStorage, String> {
            if !*self.storage_on.lock().unwrap() {
                return Err("This Mac can't show its storage.".into());
            }
            Ok(protocol::RemoteStorage { free_bytes: Some(40), total_bytes: Some(100), scanned_at: Some(5), scanning: false, progress: String::new(), deleting: false, items: vec![protocol::RemoteStorageItem { id: "ab12".into(), kind: "cache".into(), name: "Xcode".into(), bytes: 9, to_trash: false, note: "n".into() }], more: 0, report: None })
        }
        fn storage_scan(&self) -> BoxFut<Result<bool, String>> {
            self.storage_asked.lock().unwrap().push("scan".into());
            Box::pin(async { Ok(true) })
        }
        fn storage_clear(&self, ids: Vec<String>) -> BoxFut<Result<(usize, u64), String>> {
            self.storage_asked.lock().unwrap().push(format!("clear:{}", ids.join(",")));
            let n = ids.len();
            Box::pin(async move { Ok((n, 9)) })
        }
        fn shell_run(&self, slot: String, id: String, command: String) -> BoxFut<Result<(), String>> {
            self.switched.lock().unwrap().push(format!("{slot}:shell:{id}:{command}"));
            Box::pin(async { Ok(()) })
        }
        fn shell_input(&self, slot: String, id: String, text: String) -> BoxFut<Result<(), String>> {
            self.switched.lock().unwrap().push(format!("{slot}:shell-input:{id}:{text}"));
            Box::pin(async { Ok(()) })
        }
        fn shell_stop(&self, slot: &str, id: &str) -> Result<(), String> {
            self.switched.lock().unwrap().push(format!("{slot}:shell-stop:{id}"));
            Ok(())
        }
        fn projects(&self) -> BoxFut<Vec<(String, String)>> {
            let p = self.projects.lock().unwrap().clone();
            Box::pin(async move { p })
        }
        fn set_permissions(&self, slot: &str, permissions: protocol::RemotePermissions) -> Result<(), String> {
            self.switched.lock().unwrap().push(format!("{slot}:{}", permissions.as_str()));
            Ok(())
        }
        fn set_preset(&self, slot: &str, preset: &str) -> Result<(), String> {
            self.switched.lock().unwrap().push(format!("{slot}:preset:{preset}"));
            Ok(())
        }
        fn set_workflow(&self, slot: &str, workflow: protocol::RemoteWorkflow) -> Result<(), String> {
            self.switched.lock().unwrap().push(format!("{slot}:workflow:{}", workflow.as_str()));
            Ok(())
        }
        fn new_chat(&self, folder: String, text: String, by: String, permissions: protocol::RemotePermissions, preset: Option<String>, workflow: protocol::RemoteWorkflow, provider: Option<String>) -> BoxFut<Result<String, String>> {
            self.started_provider.lock().unwrap().push(provider);
            self.started_flow.lock().unwrap().push(workflow);
            self.started_with.lock().unwrap().push((permissions, preset));
            self.started.lock().unwrap().push((folder, text, by));
            let delay = *self.new_chat_delay.lock().unwrap();
            Box::pin(async move {
                tokio::time::sleep(delay).await;
                Ok("s9".to_string())
            })
        }
        fn suggest_reply(&self, prompt: String) -> BoxFut<Result<String, String>> {
            self.prompts.lock().unwrap().push(prompt);
            let mut replies = self.replies.lock().unwrap();
            let reply = if replies.is_empty() { Ok("[]".to_string()) } else { replies.remove(0) };
            let delay = *self.suggest_delay.lock().unwrap();
            Box::pin(async move {
                tokio::time::sleep(delay).await;
                reply
            })
        }
        fn diff(&self, _: String, path: String) -> BoxFut<Result<String, String>> {
            Box::pin(async move { if path == "/p/a.rs" { Ok("--- a\n+++ b\n".into()) } else { Err("not changed".into()) } })
        }
        fn history(&self, _: String, _: Option<usize>) -> BoxFut<Result<crate::history::Page, String>> {
            let h = self.history.lock().unwrap().clone();
            Box::pin(async move { Ok(crate::history::Page { events: h, hidden: 0 }) })
        }
        fn mac_name(&self) -> String {
            "Test Mac".into()
        }
        fn app_version(&self) -> String {
            "0.0.0".into()
        }
        fn hosts(&self) -> Vec<String> {
            vec!["192.168.1.5".into(), "100.64.0.7".into()]
        }
    }

    pub struct Rig {
        pub gw: Arc<Gateway>,
        pub bus: Arc<EventBus>,
        pub hub: Arc<SessionHub>,
        pub store: Arc<RemoteStore>,
        pub host: Arc<FakeHost>,
    }

    /// This run's epoch in the tests.
    pub const EPOCH: u64 = 7;

    pub fn rig() -> Rig {
        let remote = crate::remote::Remote::default();
        let (bus, hub, store) = (remote.bus.clone(), remote.hub.clone(), remote.store.clone());
        store.set_enabled(true).unwrap();
        let host = Arc::new(FakeHost::default());
        let mac = generate_keypair().unwrap();
        let gw = Gateway::new(bus.clone(), hub.clone(), store.clone(), host.clone(), mac, EPOCH);
        Rig { gw, bus, hub, store, host }
    }

    /// A phone: its link, its channel once in, and its own request numbers.
    pub struct Phone {
        pub link: Link,
        pub channel: Channel,
        next: u64,
        /// The addresses its Welcome gave.
        pub hosts: Vec<String>,
    }

    impl Phone {
        pub async fn next(&mut self) -> Option<ServerMessage> {
            loop {
                let frame = tokio::time::timeout(Duration::from_secs(5), self.link.from_peer.recv()).await.ok()??;
                if let Some(plain) = self.channel.open(&frame).ok()? {
                    return serde_json::from_slice(&plain).ok();
                }
            }
        }

        pub fn send(&mut self, msg: &ClientMessage) {
            for f in self.channel.seal(&serde_json::to_vec(msg).unwrap()).unwrap() {
                self.link.to_peer.try_send(f).unwrap();
            }
        }

        /// Asks, and returns the answer (skipping whatever else comes first).
        pub async fn ask(&mut self, request: Request) -> (Option<serde_json::Value>, Option<String>, Vec<ServerMessage>) {
            self.next += 1;
            let id = self.next;
            self.send(&ClientMessage::Request { id, request });
            let mut before = Vec::new();
            loop {
                match self.next().await.expect("an answer") {
                    ServerMessage::Response { id: got, ok, error } if got == id => return (ok, error, before),
                    other => before.push(other),
                }
            }
        }
    }

    /// Runs a phone's side: pairing (with the QR secret) or connecting, then hello. Err: the gateway closed on it.
    pub async fn phone(gw: &Arc<Gateway>, key: &Keypair, secret: Option<[u8; 32]>, protocol: u32) -> Result<Phone, String> {
        phone_with(gw, key, secret, protocol, &[]).await
    }

    /// `phone`, saying in its hello what it can read (see protocol::PHONE_EXTRAS).
    pub async fn phone_with(gw: &Arc<Gateway>, key: &Keypair, secret: Option<[u8; 32]>, protocol: u32, features: &[&str]) -> Result<Phone, String> {
        let (mut mine, theirs) = link_pair();
        gw.accept(theirs);
        let mut hs = match secret {
            Some(s) => {
                mine.to_peer.send(vec![secure::PAIR]).await.map_err(|e| e.to_string())?;
                Handshake::pair_initiator(key, &s)?
            }
            None => {
                mine.to_peer.send(vec![secure::CONNECT]).await.map_err(|e| e.to_string())?;
                Handshake::connect_initiator(key)?
            }
        };
        mine.to_peer.send(hs.write()?).await.map_err(|e| e.to_string())?;
        let second = tokio::time::timeout(Duration::from_secs(5), mine.from_peer.recv()).await.map_err(|_| "timed out".to_string())?.ok_or("closed")?;
        hs.read(&second)?;
        mine.to_peer.send(hs.write()?).await.map_err(|e| e.to_string())?;
        let (_, channel) = hs.finish()?;
        let mut p = Phone { link: mine, channel, next: 0, hosts: Vec::new() };
        p.send(&ClientMessage::Hello { protocol, app_version: "1.0".into(), device_name: "Test phone".into(), features: features.iter().map(|f| f.to_string()).collect() });
        match p.next().await {
            Some(ServerMessage::Welcome { hosts, .. }) => {
                p.hosts = hosts;
                Ok(p)
            }
            other => Err(format!("no welcome: {other:?}")),
        }
    }

    pub fn offer_secret(store: &RemoteStore) -> [u8; 32] {
        store.start_offer(super::super::now_ms()).unwrap().secret
    }

    async fn paired(r: &Rig) -> (Keypair, Phone) {
        let key = generate_keypair().unwrap();
        let p = phone(&r.gw, &key, Some(offer_secret(&r.store)), PROTOCOL_VERSION).await.unwrap();
        (key, p)
    }

    fn user(t: &str) -> UiEvent {
        UiEvent::UserText { text: t.into(), at: None, sent_by: None, images: 0 }
    }

    #[tokio::test]
    async fn a_phone_with_the_code_pairs_and_is_listed_and_can_come_back_without_it() {
        let r = rig();
        let (key, mut p) = paired(&r).await;
        assert!(matches!(p.next().await, Some(ServerMessage::Chats { .. })), "it is sent the chat list first");
        let devices = r.store.saved().devices;
        assert_eq!((devices.len(), devices[0].name.as_str()), (1, "Test phone"));
        assert_eq!(r.gw.connected(), vec![devices[0].id.clone()]);
        drop(p);
        assert!(phone(&r.gw, &key, None, PROTOCOL_VERSION).await.is_ok(), "connecting again needs no code");
    }

    #[tokio::test]
    async fn the_welcome_gives_the_addresses_the_mac_can_be_reached_at_to_a_new_phone_and_one_coming_back() {
        let r = rig();
        let (key, p) = paired(&r).await;
        assert_eq!(p.hosts, vec!["192.168.1.5", "100.64.0.7"], "a phone that has just paired learns the Tailscale address too");
        drop(p);
        let again = phone(&r.gw, &key, None, PROTOCOL_VERSION).await.unwrap();
        assert_eq!(again.hosts, vec!["192.168.1.5", "100.64.0.7"], "and so does one paired before Tailscale was on");
    }

    #[tokio::test]
    async fn a_phone_that_never_paired_is_turned_away() {
        let r = rig();
        let stranger = generate_keypair().unwrap();
        assert!(phone(&r.gw, &stranger, None, PROTOCOL_VERSION).await.is_err());
        assert!(r.store.saved().devices.is_empty());
    }

    #[tokio::test]
    async fn a_code_works_once_and_not_at_all_when_none_is_on_screen() {
        let r = rig();
        assert!(phone(&r.gw, &generate_keypair().unwrap(), Some([1u8; 32]), PROTOCOL_VERSION).await.is_err(), "no code on screen");
        let secret = offer_secret(&r.store);
        let mut wrong = secret;
        wrong[0] ^= 1;
        assert!(phone(&r.gw, &generate_keypair().unwrap(), Some(wrong), PROTOCOL_VERSION).await.is_err(), "a wrong guess");
        assert!(phone(&r.gw, &generate_keypair().unwrap(), Some(secret), PROTOCOL_VERSION).await.is_err(), "the code was used up by the guess");
        assert!(r.store.saved().devices.is_empty());
    }

    #[tokio::test]
    async fn a_phone_on_another_protocol_is_welcomed_then_closed() {
        let r = rig();
        let mut p = phone(&r.gw, &generate_keypair().unwrap(), Some(offer_secret(&r.store)), PROTOCOL_VERSION + 1).await.unwrap();
        assert!(p.next().await.is_none(), "closed after its welcome");
    }

    #[tokio::test]
    async fn a_removed_phone_is_disconnected_at_once_and_cant_come_back() {
        let r = rig();
        let (key, mut p) = paired(&r).await;
        let id = r.store.saved().devices[0].id.clone();
        r.store.remove_device(&id).unwrap();
        r.gw.disconnect_device(&id);
        let started = std::time::Instant::now();
        while p.next().await.is_some() {}
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(phone(&r.gw, &key, None, PROTOCOL_VERSION).await.is_err());
    }

    #[tokio::test]
    async fn a_phone_too_slow_with_its_handshake_is_dropped_and_a_crowd_cant_hold_the_door() {
        let r = rig();
        tokio::time::pause();
        let mut half_open = Vec::new();
        for _ in 0..HANDSHAKES_AT_ONCE {
            let (mine, theirs) = link_pair();
            r.gw.accept(theirs);
            half_open.push(mine);
        }
        tokio::task::yield_now().await;
        // A fifth is refused while four are in their handshake.
        let (mut fifth, theirs) = link_pair();
        r.gw.accept(theirs);
        tokio::time::advance(Duration::from_millis(10)).await;
        assert!(fifth.from_peer.recv().await.is_none());
        // And the four are dropped when their time runs out.
        tokio::time::advance(HANDSHAKE_WAIT + Duration::from_secs(1)).await;
        for mut h in half_open {
            assert!(h.from_peer.recv().await.is_none());
        }
    }

    #[tokio::test]
    async fn a_phone_follows_a_chat_from_its_start_then_live_and_catches_up_from_where_it_was() {
        let r = rig();
        r.hub.opened("a", "/p/lantern");
        *r.host.history.lock().unwrap() = vec![user("earlier")];
        let (key, mut p) = paired(&r).await;
        let (ok, err, before) = p.ask(Request::Subscribe { slot: "a".into(), after: 0, epoch: EPOCH }).await;
        assert_eq!((ok, err), (None, None), "done: no result, no error");
        assert!(before.iter().any(|m| matches!(m, ServerMessage::Reset { slot, done: true, events, .. } if slot == "a" && events.len() == 1)));
        r.bus.publish("a", UiEvent::AssistantText { parent: None, block_id: "b".into(), text: "now".into() });
        r.bus.publish("b", user("another chat"));
        let live = loop {
            match p.next().await.unwrap() {
                ServerMessage::Event { slot, seq, event } => break (slot, seq, event),
                _ => continue,
            }
        };
        assert_eq!(live, ("a".into(), 1, RemoteEvent::AssistantText { block_id: "b".into(), text: "now".into() }));
        drop(p);
        // Away for a bit: two more events, then it comes back from number 1.
        r.bus.publish("a", user("x"));
        r.bus.publish("a", UiEvent::ContextUsed { tokens: 1 });
        let mut p = phone(&r.gw, &key, None, PROTOCOL_VERSION).await.unwrap();
        let (_, _, before) = p.ask(Request::Subscribe { slot: "a".into(), after: 1, epoch: EPOCH }).await;
        let caught: Vec<u64> = before.iter().filter_map(|m| if let ServerMessage::Event { seq, .. } = m { Some(*seq) } else { None }).collect();
        assert_eq!(caught, vec![2], "only what it missed, and only what a phone is sent");
    }

    #[tokio::test]
    async fn a_phone_is_sent_the_commands_plan_context_and_usage_only_if_it_said_it_can_read_them() {
        let r = rig();
        r.hub.opened("a", "/p");
        let todo = |status: &str| crate::ui_event::Todo { content: "Write tests".into(), status: status.into(), active_form: "Writing tests".into() };
        r.bus.publish("a", UiEvent::Commands { commands: vec![crate::ui_event::SlashCommand { name: "review".into(), description: "Review".into(), argument_hint: String::new() }] });
        r.bus.publish("a", UiEvent::Todos { parent: None, items: vec![todo("pending")] });
        r.bus.publish("a", UiEvent::Todos { parent: None, items: vec![todo("completed")] });
        r.bus.publish("a", UiEvent::ContextUsed { tokens: 90_000 });
        r.bus.publish("a", UiEvent::TurnDone { is_error: false, result: None, cost_usd: None, tokens: None, session_cost_usd: None, session_tokens: 0, duration_ms: None, auth_hint: false, denied: 0, context_window: Some(200_000) });
        r.bus.publish("b", UiEvent::PlanUsage { used: 0.4, resets_at: Some(99), status: "allowed".into() });
        r.bus.publish("b", UiEvent::WeekUsage { used: 0.25, resets_at: Some(777) });
        let reset_of = |before: Vec<ServerMessage>| -> Vec<RemoteEvent> { before.into_iter().filter_map(|m| if let ServerMessage::Reset { events, .. } = m { Some(events) } else { None }).flatten().collect() };

        let key = generate_keypair().unwrap();
        let mut old = phone(&r.gw, &key, Some(offer_secret(&r.store)), PROTOCOL_VERSION).await.unwrap();
        let (_, _, before) = old.ask(Request::Subscribe { slot: "a".into(), after: 0, epoch: EPOCH }).await;
        assert!(reset_of(before.to_vec()).iter().all(|e| !e.is_extra()), "an older phone is sent none of them");
        assert!(!before.iter().any(|m| matches!(m, ServerMessage::Plan { .. })));

        let key = generate_keypair().unwrap();
        let mut new = phone_with(&r.gw, &key, Some(offer_secret(&r.store)), PROTOCOL_VERSION, &[protocol::PHONE_EXTRAS]).await.unwrap();
        let (_, _, before) = new.ask(Request::Subscribe { slot: "a".into(), after: 0, epoch: EPOCH }).await;
        let usage = |msgs: &[ServerMessage]| msgs.iter().find_map(|m| if let ServerMessage::Plan { used, resets_at, week_used, week_resets_at, .. } = m { Some((*used, *resets_at, *week_used, *week_resets_at)) } else { None });
        let mut plan = usage(&before);
        let events: Vec<RemoteEvent> = reset_of(before).into_iter().filter(|e| e.is_extra()).collect();
        assert_eq!(events.len(), 3, "the latest of each, however many were said: {events:?}");
        assert!(matches!(&events[0], RemoteEvent::Commands { commands } if commands[0].name == "review"));
        assert!(matches!(&events[1], RemoteEvent::Todos { items } if items.len() == 1 && items[0].status == "completed"));
        assert_eq!(events[2], RemoteEvent::Context { tokens: 90_000, window: Some(200_000) });
        // The account's usage comes as a message of its own, once it has been said (by any chat).
        while plan.is_none() {
            plan = usage(&[new.next().await.unwrap()]);
        }
        assert_eq!(plan, Some((0.4, Some(99), Some(0.25), Some(777))), "the weekly window comes with it");

        // Live, too: one that said it can read them gets a new plan at once; the other doesn't.
        r.bus.publish("a", UiEvent::Todos { parent: None, items: vec![todo("in_progress")] });
        r.bus.publish("a", UiEvent::AssistantText { parent: None, block_id: "b".into(), text: "done".into() });
        async fn next_event(p: &mut Phone) -> RemoteEvent {
            loop {
                if let ServerMessage::Event { event, .. } = p.next().await.unwrap() {
                    return event;
                }
            }
        }
        assert!(matches!(next_event(&mut new).await, RemoteEvent::Todos { .. }));
        assert!(matches!(next_event(&mut old).await, RemoteEvent::AssistantText { .. }), "an older phone is sent the text and not the plan");
    }

    #[tokio::test]
    async fn a_phone_can_read_what_a_finished_step_printed_while_the_mac_keeps_it() {
        let r = rig();
        r.hub.opened("a", "/p");
        r.bus.publish("a", UiEvent::ToolStarted { parent: None, tool_use_id: "t1".into(), name: "Bash".into(), summary: "npm test".into() });
        r.bus.publish("a", UiEvent::ToolFinished { parent: None, tool_use_id: "t1".into(), is_error: false, output: "3 passed".into() });
        r.bus.publish("a", UiEvent::ToolStarted { parent: None, tool_use_id: "t2".into(), name: "Read".into(), summary: "/p/.env".into() });
        r.bus.publish("a", UiEvent::ToolFinished { parent: None, tool_use_id: "t2".into(), is_error: false, output: "API_KEY=hunter2".into() });
        let (_, mut p) = paired(&r).await;
        assert_eq!(p.ask(Request::StepOutput { slot: "a".into(), tool_use_id: "t1".into() }).await.0, Some(json!("3 passed")));
        let (ok, err, _) = p.ask(Request::StepOutput { slot: "a".into(), tool_use_id: "t2".into() }).await;
        assert!(ok.is_none() && err.is_some(), "what Claude read from a file is not sent to a phone");
        let (ok, err, _) = p.ask(Request::StepOutput { slot: "a".into(), tool_use_id: "gone".into() }).await;
        assert!(ok.is_none() && err.unwrap().contains("isn't kept"));
        assert!(p.ask(Request::StepOutput { slot: "nope".into(), tool_use_id: "t1".into() }).await.1.unwrap().contains("isn't open"));
    }

    #[tokio::test]
    async fn only_what_the_protocol_lists_can_be_asked_and_only_of_open_chats() {
        let r = rig();
        r.hub.opened("a", "/p");
        let (_, mut p) = paired(&r).await;
        let (_, err, _) = p.ask(Request::Send { slot: "nope".into(), text: "hi".into(), client_id: "c1".into(), images: None }).await;
        assert!(err.unwrap().contains("isn't open"));
        let (_, err, _) = p.ask(Request::Send { slot: "a".into(), text: "  ".into(), client_id: "c1".into(), images: None }).await;
        assert!(err.is_some());
        let (_, err, _) = p.ask(Request::Send { slot: "a".into(), text: "hi".into(), client_id: "../x".into(), images: None }).await;
        assert!(err.is_some());
        let (_, err, _) = p.ask(Request::Send { slot: "a".into(), text: "ship it".into(), client_id: "m-1".into(), images: None }).await;
        assert!(err.is_none());
        let device = r.store.saved().devices[0].id.clone();
        assert_eq!(r.host.sent.lock().unwrap()[0], ("a".into(), "ship it".into(), format!("{device}:m-1")));
        // Anything not in the protocol isn't even read: the connection ends.
        for f in p.channel.seal(br#"{"type":"request","id":99,"request":{"op":"run_shell","command":"rm -rf /"}}"#).unwrap() {
            p.link.to_peer.try_send(f).unwrap();
        }
        assert!(p.next().await.is_none());
    }

    #[tokio::test]
    async fn pictures_go_with_a_message_only_when_they_check_out() {
        use base64::Engine;
        let picture = |media_type: &str, bytes: &[u8]| protocol::RemoteImage { media_type: media_type.into(), data: base64::engine::general_purpose::STANDARD.encode(bytes) };
        let jpeg = picture("image/jpeg", &[0xFF, 0xD8, 0xFF, 0xE0, 0, 16]);
        let r = rig();
        r.hub.opened("a", "/p");
        let (_, mut p) = paired(&r).await;
        let send = |text: &str, id: &str, images: Option<Vec<protocol::RemoteImage>>| Request::Send { slot: "a".into(), text: text.into(), client_id: id.into(), images };
        // Words with a picture, and a picture alone.
        assert!(p.ask(send("what is this?", "m-1", Some(vec![jpeg.clone()]))).await.1.is_none());
        assert!(p.ask(send("  ", "m-2", Some(vec![jpeg.clone(), jpeg.clone()]))).await.1.is_none());
        // No words and no pictures is still empty, and an empty list is no pictures.
        assert!(p.ask(send(" ", "m-3", Some(vec![]))).await.1.is_some());
        // A file that isn't a picture, too many, and a bad id with a picture: none of them reaches the chat.
        assert!(p.ask(send("run it", "m-4", Some(vec![picture("image/jpeg", b"#!/bin/sh\nrm -rf ~")]))).await.1.is_some());
        assert!(p.ask(send("many", "m-5", Some(vec![jpeg.clone(); protocol::IMAGES_MAX + 1]))).await.1.is_some());
        assert!(p.ask(send("id", "../x", Some(vec![jpeg.clone()]))).await.1.is_some());
        let sent = r.host.sent.lock().unwrap().clone();
        assert_eq!(sent.iter().map(|s| s.1.as_str()).collect::<Vec<_>>(), vec!["what is this?", "  "]);
        let images = r.host.sent_images.lock().unwrap().clone();
        assert_eq!(images, vec![vec![jpeg.clone()], vec![jpeg.clone(), jpeg]]);
    }

    #[tokio::test]
    async fn a_phone_registers_its_lock_screen_card_only_with_real_tokens_for_chats_that_exist() {
        let r = rig();
        r.hub.opened("a", "/p/lantern");
        let (_, mut p) = paired(&r).await;
        let device = r.store.saved().devices[0].id.clone();
        let token = "ab".repeat(32);
        let card = |slot: &str, token: &str| Some(protocol::RemoteLiveCard { slot: slot.into(), token: token.into(), project: "lantern\u{7}".into(), since: 1 });
        let ask = |start_token: Option<String>, card| Request::LiveActivity { start_token, card };
        assert!(p.ask(ask(Some(token.clone()), card("a", &token))).await.1.is_none());
        let kept = r.store.live.cards();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].0, device);
        let c = &kept[0].1;
        assert_eq!((c.slot.as_str(), c.token.as_str(), c.project.as_str(), c.ended), ("a", token.as_str(), "lantern", false), "the project's name is cleaned of control characters");
        assert_eq!(r.store.live.state(&device).unwrap().start_token.as_deref(), Some(token.as_str()));
        // Not a chat that is open, not a token (it goes into a URL), not a start token: none of them changes what is kept.
        for bad in [ask(None, card("nope", &token)), ask(None, card("a", "../../3/device/x")), ask(None, card("a", &format!("{token}/"))), ask(Some("not hex".into()), None)] {
            assert!(p.ask(bad).await.1.is_some());
        }
        assert_eq!(r.store.live.cards(), kept);
        // No card any more (the phone cleared it): none is kept, and nothing else is lost.
        assert!(p.ask(ask(Some(token.clone()), None)).await.1.is_none());
        assert!(r.store.live.cards().is_empty());
        // Unpairing the phone forgets all of it.
        assert!(p.ask(ask(None, card("a", &token))).await.1.is_none());
        r.store.remove_device(&device).unwrap();
        assert!(r.store.live.cards().is_empty() && r.store.live.state(&device).is_none());
    }

    #[tokio::test]
    async fn an_answer_counts_once_and_cant_change_what_runs() {
        let r = rig();
        r.hub.opened("a", "/p");
        *r.host.pending.lock().unwrap() = vec![
            Pending { request_id: "p1".into(), tool_name: "Bash".into(), input: json!({"command": "npm test"}), at: 1 },
            Pending { request_id: "q1".into(), tool_name: answers::QUESTION_TOOL.into(), input: json!({"questions": [{"question": "Which?"}]}), at: 2 },
        ];
        let (_, mut p) = paired(&r).await;
        let (_, err, _) = p.ask(Request::Answer { slot: "a".into(), request_id: "p1".into(), allow: true, message: None, answers: Some([("command".to_string(), "rm -rf ~".to_string())].into()) }).await;
        assert!(err.unwrap().contains("Only a question"), "a phone can't give a command answers, or change what runs");
        assert!(r.host.answered.lock().unwrap().is_empty());
        let (_, err, _) = p.ask(Request::Answer { slot: "a".into(), request_id: "p1".into(), allow: true, message: None, answers: None }).await;
        assert!(err.is_none());
        let (_, err, _) = p.ask(Request::Answer { slot: "a".into(), request_id: "p1".into(), allow: false, message: None, answers: None }).await;
        assert!(err.unwrap().contains("answered already"));
        let answers = json!({"questions": [{"question": "Which?"}], "answers": {"Which?": "Dark"}});
        let (_, err, _) = p.ask(Request::Answer { slot: "a".into(), request_id: "q1".into(), allow: true, message: None, answers: Some([("Which?".to_string(), "Dark".to_string())].into()) }).await;
        assert!(err.is_none());
        let answered = r.host.answered.lock().unwrap();
        assert_eq!(answered.len(), 2);
        assert_eq!(answered[1].2, Some(answers));
        assert_eq!(answered[0].3, r.store.saved().devices[0].id);
    }

    #[tokio::test]
    async fn the_waiting_list_spans_every_chat_oldest_first_with_long_inputs_cut() {
        let r = rig();
        r.hub.opened("a", "/p");
        *r.host.pending.lock().unwrap() = vec![
            Pending { request_id: "late".into(), tool_name: "Write".into(), input: json!({"content": "x".repeat(10_000)}), at: 9 },
            Pending { request_id: "early".into(), tool_name: "Bash".into(), input: json!({"command": "ls"}), at: 3 },
        ];
        let (_, mut p) = paired(&r).await;
        let (ok, _, _) = p.ask(Request::ListWaiting).await;
        let list: Vec<Waiting> = serde_json::from_value(ok.unwrap()).unwrap();
        assert_eq!(list.iter().map(|w| w.request_id.as_str()).collect::<Vec<_>>(), vec!["early", "late"]);
        assert!(list[1].input["content"].as_str().unwrap().ends_with(protocol::CUT));
    }

    #[tokio::test]
    async fn waking_and_diffs_go_to_the_app_for_open_chats_only() {
        let r = rig();
        r.hub.asleep("z", "/p", Some("Asleep".into()), Some("s".into()));
        let (_, mut p) = paired(&r).await;
        assert!(p.ask(Request::Wake { slot: "z".into() }).await.1.is_none());
        assert_eq!(*r.host.woken.lock().unwrap(), vec!["z".to_string()]);
        assert_eq!(p.ask(Request::Diff { slot: "z".into(), path: "/p/a.rs".into() }).await.0, Some(json!("--- a\n+++ b\n")));
        assert!(p.ask(Request::Diff { slot: "z".into(), path: "/etc/passwd".into() }).await.1.is_some());
        assert!(p.ask(Request::Wake { slot: "unknown".into() }).await.1.is_some());
    }

    #[tokio::test]
    async fn a_phone_lists_the_projects_and_starts_a_chat_in_one_of_them() {
        let r = rig();
        *r.host.projects.lock().unwrap() = vec![("/Users/me/app".into(), "app".into()), ("/Users/me/site".into(), "site".into())];
        let (_, mut p) = paired(&r).await;
        let device = r.store.saved().devices[0].id.clone();
        assert_eq!(p.ask(Request::Projects).await.0, Some(json!([{"id": "/Users/me/app", "name": "app"}, {"id": "/Users/me/site", "name": "site"}])));
        let (ok, err, _) = p.ask(Request::NewChat { project: "/Users/me/app".into(), text: "Fix the login bug".into(), permissions: None, preset: None, workflow: None, provider: None }).await;
        assert_eq!((ok, err), (Some(json!({"slot": "s9"})), None));
        let started = r.host.started.lock().unwrap();
        assert_eq!(started.len(), 1);
        assert_eq!((started[0].0.as_str(), started[0].1.as_str()), ("/Users/me/app", "Fix the login bug"));
        assert_eq!(started[0].2, device, "the chat records which phone started it");
    }

    #[tokio::test]
    async fn a_chat_is_not_started_in_a_folder_the_user_doesnt_work_in_or_from_nothing_or_from_too_much() {
        let r = rig();
        *r.host.projects.lock().unwrap() = vec![("/Users/me/app".into(), "app".into())];
        let (_, mut p) = paired(&r).await;
        let ask = |project: &str, text: &str| Request::NewChat { project: project.into(), text: text.into(), permissions: None, preset: None, workflow: None, provider: None };
        for (project, text, why) in [
            ("/etc", "hi", "isn't one of your projects"),
            ("/Users/me/app/../../..", "hi", "isn't one of your projects"),
            ("/Users/me/app/", "hi", "isn't one of your projects"),
            ("app", "hi", "isn't a project folder"),
            ("/Users/me/a\0pp", "hi", "isn't a project folder"),
            ("/Users/me/app", "  \n ", "Write what the chat should start with"),
        ] {
            let (ok, err, _) = p.ask(ask(project, text)).await;
            assert!(ok.is_none() && err.as_deref().is_some_and(|e| e.contains(why)), "{project:?} {text:?}: {err:?}");
        }
        let (ok, err, _) = p.ask(ask("/Users/me/app", &"x".repeat(NEW_CHAT_TEXT_MAX + 1))).await;
        assert!(ok.is_none() && err.is_some_and(|e| e.contains("too long")));
        assert!(r.host.started.lock().unwrap().is_empty(), "nothing reached the app");
        // The longest allowed is allowed, counted in characters and not bytes.
        assert!(p.ask(ask("/Users/me/app", &"é".repeat(NEW_CHAT_TEXT_MAX))).await.1.is_none());
    }

    fn preset(id: &str) -> protocol::RemotePreset {
        protocol::RemotePreset { id: id.into(), name: id.to_uppercase(), summary: format!("{id} does it") }
    }

    #[tokio::test]
    async fn a_phone_closes_a_chat_that_is_idle_asleep_or_stopped_and_not_one_that_is_busy() {
        let r = rig();
        r.hub.opened("idle", "/p");
        r.hub.asleep("asleep", "/p", None, None);
        r.hub.opened("busy", "/p");
        r.hub.record(&BusEvent { slot: "busy".into(), seq: 1, event: user("go") });
        r.hub.opened("asks", "/p");
        r.hub.record(&BusEvent { slot: "asks".into(), seq: 1, event: UiEvent::PermissionRequested { request_id: "q".into(), tool_name: "Bash".into(), input: json!({}) } });
        let (_, mut p) = paired(&r).await;
        for slot in ["idle", "asleep"] {
            assert!(p.ask(Request::Close { slot: slot.into() }).await.1.is_none(), "{slot}");
        }
        assert_eq!(*r.host.closed.lock().unwrap(), vec!["idle".to_string(), "asleep".to_string()]);
        for slot in ["busy", "asks"] {
            let (_, err, _) = p.ask(Request::Close { slot: slot.into() }).await;
            assert!(err.is_some_and(|e| e.contains("Stop it first")), "{slot}");
        }
        let (_, err, _) = p.ask(Request::Close { slot: "nope".into() }).await;
        assert!(err.is_some_and(|e| e.contains("isn't open")));
        assert_eq!(r.host.closed.lock().unwrap().len(), 2, "nothing busy or unknown reached the app");
    }

    #[tokio::test]
    async fn a_phone_runs_a_command_in_an_awake_chat_and_answers_and_stops_only_its_own() {
        let r = rig();
        r.hub.opened("a", "/p");
        r.hub.asleep("zzz", "/p", None, None);
        let (_, mut p) = paired(&r).await;
        let run = |slot: &str, id: &str, command: &str| Request::Shell { slot: slot.into(), id: id.into(), command: command.into() };
        assert!(p.ask(run("a", "ph-abcd1234", "git status")).await.1.is_none());
        assert_eq!(*r.host.switched.lock().unwrap(), vec!["a:shell:ph-abcd1234:git status".to_string()]);
        // What never reaches the app: an asleep or unknown chat, nothing to run, too much, and an id that isn't a phone's (the
        // window's own are "sh…" and "run-…").
        let long = "x".repeat(protocol::SHELL_COMMAND_MAX + 1);
        for (request, why) in [
            (run("zzz", "ph-abcd1234", "ls"), "asleep"),
            (run("nope", "ph-abcd1234", "ls"), "isn't open"),
            (run("a", "ph-abcd1234", "   "), "Type a command"),
            (run("a", "ph-abcd1234", &long), "too long"),
            // What can't be seen, or draws backwards, so a command reads one way where it is approved and runs another.
            (run("a", "ph-abcd1234", "ls\0"), "can't be seen"),
            (run("a", "ph-abcd1234", "ls\r# hidden"), "can't be seen"),
            (run("a", "ph-abcd1234", "ls\n rm -rf ."), "can't be seen"),
            (run("a", "ph-abcd1234", "echo \u{202e}txt.sh"), "can't be seen"),
            (run("a", "ph-abcd1234", "echo \u{2066}x"), "can't be seen"),
            (run("a", "ph-abcd1234", "ec\u{200b}ho x"), "can't be seen"),
            (run("a", "ph-abcd1234", "\u{feff}ls"), "can't be seen"),
            (run("a", "sh1", "ls"), "isn't a command id"),
            (run("a", "run-1", "ls"), "isn't a command id"),
            (run("a", "ph-ab", "ls"), "isn't a command id"),
            (run("a", "ph-ab_cd1234", "ls"), "isn't a command id"),
        ] {
            let (ok, err, _) = p.ask(request).await;
            assert!(ok.is_none() && err.as_deref().is_some_and(|e| e.contains(why)), "{why}: {err:?}");
        }
        assert_eq!(r.host.switched.lock().unwrap().len(), 1, "only the first reached the app");

        // A reply is a line, and a command's reply or stop is only for a phone's own command.
        let reply = |id: &str, text: &str| Request::ShellInput { slot: "a".into(), id: id.into(), text: text.into() };
        assert!(p.ask(reply("ph-abcd1234", "hunter2")).await.1.is_none());
        assert!(p.ask(Request::ShellStop { slot: "a".into(), id: "ph-abcd1234".into() }).await.1.is_none());
        assert_eq!(r.host.switched.lock().unwrap()[1..], ["a:shell-input:ph-abcd1234:hunter2".to_string(), "a:shell-stop:ph-abcd1234".to_string()]);
        for bad in ["a\nb", "a\u{4}", "a\u{1b}[A", &"x".repeat(protocol::SHELL_INPUT_MAX + 1)] {
            let (_, err, _) = p.ask(reply("ph-abcd1234", bad)).await;
            assert!(err.is_some(), "{bad:?}");
        }
        for id in ["sh1", "run-1"] {
            assert!(p.ask(reply(id, "x")).await.1.is_some_and(|e| e.contains("isn't a command id")), "{id}");
            assert!(p.ask(Request::ShellStop { slot: "a".into(), id: id.into() }).await.1.is_some_and(|e| e.contains("isn't a command id")), "{id}");
        }
        assert_eq!(r.host.switched.lock().unwrap().len(), 3, "nothing else reached the app");
    }

    #[tokio::test]
    async fn a_tab_in_a_command_is_fine_and_so_are_accents_and_other_scripts() {
        let r = rig();
        r.hub.opened("a", "/p");
        let (_, mut p) = paired(&r).await;
        let run = |command: &str| Request::Shell { slot: "a".into(), id: "ph-abcd1234".into(), command: command.into() };
        for command in ["printf 'a\tb'", "echo café", "echo 日本語 😀"] {
            assert!(p.ask(run(command)).await.1.is_none(), "{command:?}");
        }
    }

    #[tokio::test]
    async fn only_the_phone_that_started_a_command_answers_or_stops_it() {
        let r = rig();
        r.hub.opened("a", "/p");
        let (_, mut first) = paired(&r).await;
        let (_, mut second) = paired(&r).await;
        let id = "ph-abcd1234";
        assert!(first.ask(Request::Shell { slot: "a".into(), id: id.into(), command: "sudo true".into() }).await.1.is_none());
        // The other phone may not type into it (it may be reading a password) or stop it.
        let (ok, err, _) = second.ask(Request::ShellInput { slot: "a".into(), id: id.into(), text: "hunter2".into() }).await;
        assert!(ok.is_none() && err.is_some_and(|e| e.contains("isn't a command this phone started")));
        let (ok, err, _) = second.ask(Request::ShellStop { slot: "a".into(), id: id.into() }).await;
        assert!(ok.is_none() && err.is_some_and(|e| e.contains("isn't a command this phone started")));
        // Nor one it never heard of, or one in another chat.
        r.hub.opened("b", "/p");
        for (slot, id) in [("a", "ph-neverrun1"), ("b", id)] {
            assert!(first.ask(Request::ShellStop { slot: slot.into(), id: id.into() }).await.1.is_some(), "{slot} {id}");
        }
        assert_eq!(r.host.switched.lock().unwrap().len(), 1, "only the start reached the app");
        // Its own phone does.
        assert!(first.ask(Request::ShellInput { slot: "a".into(), id: id.into(), text: "ok".into() }).await.1.is_none());
        assert!(first.ask(Request::ShellStop { slot: "a".into(), id: id.into() }).await.1.is_none());
        assert_eq!(r.host.switched.lock().unwrap().len(), 3);
    }

    #[test]
    fn the_owners_of_commands_are_remembered_up_to_a_limit_and_the_oldest_goes_first() {
        let mut owners = ShellOwners::default();
        owners.claim("a", "ph-0", "d1");
        assert!(owners.owns("a", "ph-0", "d1") && !owners.owns("a", "ph-0", "d2") && !owners.owns("b", "ph-0", "d1"));
        for i in 1..=SHELL_OWNERS_MAX {
            owners.claim("a", &format!("ph-{i}"), "d1");
        }
        assert!(!owners.owns("a", "ph-0", "d1"), "the oldest was forgotten");
        assert!(owners.owns("a", &format!("ph-{SHELL_OWNERS_MAX}"), "d1"));
        assert_eq!(owners.by.len(), SHELL_OWNERS_MAX);
    }

    #[tokio::test]
    async fn a_chat_is_put_on_step_by_step_or_back_only_while_idle_and_never_onto_or_off_a_team() {
        use protocol::RemoteWorkflow::{Chat, Steps, Team};
        let r = rig();
        r.hub.opened("a", "/p");
        r.hub.flow("a", "chat");
        r.hub.opened("lead", "/p");
        r.hub.flow("lead", "team");
        r.hub.opened("busy", "/p");
        r.hub.record(&BusEvent { slot: "busy".into(), seq: 1, event: user("go") });
        let (_, mut p) = paired(&r).await;
        let set = |slot: &str, workflow| Request::SetWorkflow { slot: slot.into(), workflow };
        assert!(p.ask(set("a", Steps)).await.1.is_none());
        assert_eq!(*r.host.switched.lock().unwrap(), vec!["a:workflow:steps".to_string()]);
        // What it already is isn't asked again (the hub still says Chat: the window hasn't said otherwise).
        assert!(p.ask(set("a", Chat)).await.1.is_none());
        assert_eq!(r.host.switched.lock().unwrap().len(), 1, "already Chat: the app was not asked");
        // Never a team, either way, and never while busy.
        let (_, err, _) = p.ask(set("a", Team)).await;
        assert!(err.is_some_and(|e| e.contains("started on your Mac")));
        let (_, err, _) = p.ask(set("lead", Steps)).await;
        assert!(err.is_some_and(|e| e.contains("leads a team")));
        let (_, err, _) = p.ask(set("busy", Steps)).await;
        assert!(err.is_some_and(|e| e.contains("busy")));
        assert_eq!(r.host.switched.lock().unwrap().len(), 1, "none of those reached the app");
    }

    #[tokio::test]
    async fn a_chat_starts_as_step_by_step_when_asked_and_never_as_a_team() {
        use protocol::RemoteWorkflow::{Chat, Steps, Team};
        let r = rig();
        *r.host.projects.lock().unwrap() = vec![("/Users/me/app".into(), "app".into())];
        let (_, mut p) = paired(&r).await;
        let ask = |workflow| Request::NewChat { project: "/Users/me/app".into(), text: "hi".into(), permissions: None, preset: None, workflow, provider: None };
        assert!(p.ask(ask(None)).await.1.is_none());
        assert!(p.ask(ask(Some(Steps))).await.1.is_none());
        let (ok, err, _) = p.ask(ask(Some(Team))).await;
        assert!(ok.is_none() && err.is_some_and(|e| e.contains("started on your Mac")));
        assert_eq!(*r.host.started_flow.lock().unwrap(), vec![Chat, Steps]);
    }

    #[test]
    fn this_mac_says_it_can_close_chats_so_a_phone_may_ask_it_to() {
        assert!(["close", "controls", "workflow"].iter().all(|f| protocol::FEATURES.contains(f)));
    }

    /// The secret in a pairing link (its `s`).
    fn secret_in(link: &str) -> [u8; 32] {
        use base64::Engine as _;
        let s = link.split(&['?', '&'][..]).find_map(|part| part.strip_prefix("s=")).expect("a secret in the link");
        base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).unwrap().try_into().unwrap()
    }

    #[test]
    fn this_mac_says_it_can_make_a_pairing_code_for_a_phone_to_show() {
        assert!(protocol::FEATURES.contains(&"pair"));
    }

    #[tokio::test]
    async fn a_paired_phone_can_get_a_pairing_code_that_pairs_a_second_device_once() {
        let r = rig();
        let (_, mut first) = paired(&r).await;
        let (ok, err, _) = first.ask(Request::PairOffer).await;
        assert!(err.is_none(), "{err:?}");
        let offer: protocol::PairOffer = serde_json::from_value(ok.unwrap()).unwrap();
        assert!(offer.link.starts_with("lantern://pair?v=1&k="));
        assert!(offer.expires_at > crate::remote::now_ms(), "it is good for a while");
        // The second device pairs with it, as its own device.
        let second = phone(&r.gw, &generate_keypair().unwrap(), Some(secret_in(&offer.link)), PROTOCOL_VERSION).await;
        assert!(second.is_ok(), "{:?}", second.err());
        assert_eq!(r.store.saved().devices.len(), 2);
        // A code is used once.
        assert!(phone(&r.gw, &generate_keypair().unwrap(), Some(secret_in(&offer.link)), PROTOCOL_VERSION).await.is_err());
        assert_eq!(r.store.saved().devices.len(), 2);
    }

    #[tokio::test]
    async fn a_phone_sees_the_macs_disk_and_clears_only_with_well_formed_ids() {
        let r = rig();
        *r.host.storage_on.lock().unwrap() = true;
        let (_, mut p) = paired(&r).await;
        let (ok, err, _) = p.ask(Request::Storage).await;
        assert!(err.is_none(), "{err:?}");
        let view: protocol::RemoteStorage = serde_json::from_value(ok.unwrap()).unwrap();
        assert_eq!((view.free_bytes, view.total_bytes, view.items.len()), (Some(40), Some(100), 1));
        // The scan and a clear reach the Mac, and a clear says how many and how much it started.
        let (ok, _, _) = p.ask(Request::StorageScan).await;
        assert_eq!(ok.unwrap(), serde_json::json!(true));
        let (ok, err, _) = p.ask(Request::StorageClear { ids: vec!["ab12".into(), "cd34".into()] }).await;
        assert!(err.is_none(), "{err:?}");
        assert_eq!(ok.unwrap(), serde_json::json!({"started": 2, "bytes": 9}));
        assert_eq!(*r.host.storage_asked.lock().unwrap(), ["scan", "clear:ab12,cd34"]);
        // Nothing but ids the Mac made reaches it: no paths, no empty list, no long list, no odd characters.
        for ids in [vec![], vec!["/Users/me/Documents".to_string()], vec!["../x".into()], vec!["".into()], vec!["ab12".repeat(5)], (0..81).map(|n| format!("{n:08x}")).collect()] {
            let (_, err, _) = p.ask(Request::StorageClear { ids }).await;
            assert!(err.is_some());
        }
        assert_eq!(r.host.storage_asked.lock().unwrap().len(), 2, "none of those got through");
    }

    #[tokio::test]
    async fn a_mac_with_no_storage_says_so_and_lists_the_feature_only_when_it_has_it() {
        let r = rig();
        let (_, mut p) = paired(&r).await;
        let (_, err, _) = p.ask(Request::Storage).await;
        assert!(err.unwrap().contains("can't show its storage"));
        assert!(protocol::FEATURES.contains(&"storage"));
    }

    #[tokio::test]
    async fn a_code_for_a_phone_to_show_puts_an_earlier_one_out_of_use_and_carries_the_macs_addresses() {
        let r = rig();
        let (_, mut p) = paired(&r).await;
        let windows = offer_secret(&r.store);
        let (ok, _, _) = p.ask(Request::PairOffer).await;
        let offer: protocol::PairOffer = serde_json::from_value(ok.unwrap()).unwrap();
        // The code the Mac's window was showing no longer works, since only one is open at a time.
        assert!(phone(&r.gw, &generate_keypair().unwrap(), Some(windows), PROTOCOL_VERSION).await.is_err());
        for host in r.host.hosts() {
            assert!(offer.link.contains(&host), "{host} is in {}", offer.link);
        }
    }

    #[tokio::test]
    async fn a_pairing_code_comes_with_its_squares_for_the_phone_to_draw() {
        let r = rig();
        let (_, mut p) = paired(&r).await;
        let (ok, _, _) = p.ask(Request::PairOffer).await;
        let offer: protocol::PairOffer = serde_json::from_value(ok.unwrap()).unwrap();
        let size = offer.modules.len();
        assert!(size >= 21, "a QR code is at least 21 squares across");
        assert!(offer.modules.iter().all(|row| row.len() == size && row.chars().all(|c| c == '0' || c == '1')), "square, and only dark or light");
        // The pattern in the corner every QR code has: a row of seven dark squares.
        assert!(offer.modules[0].starts_with("1111111"));
    }

    #[tokio::test]
    async fn a_phone_is_told_whether_auto_is_allowed_and_which_presets_there_are() {
        let r = rig();
        r.hub.set_presets(vec![preset("balanced"), preset("max")]);
        let (_, mut p) = paired(&r).await;
        let (ok, _, _) = p.ask(Request::Controls).await;
        // No providers when the Mac has only Claude Code to offer (an older phone reads this as it always did).
        assert_eq!(ok, Some(json!({"allow_auto": false, "presets": [{"id": "balanced", "name": "BALANCED", "summary": "balanced does it"}, {"id": "max", "name": "MAX", "summary": "max does it"}], "providers": []})));
        r.store.set_allow_phone_auto(true).unwrap();
        assert_eq!(p.ask(Request::Controls).await.0.unwrap()["allow_auto"], json!(true), "the setting is read each time, not remembered");
    }

    fn provider(id: &str, name: &str, auto: bool, presets: bool) -> protocol::RemoteProvider {
        protocol::RemoteProvider { id: id.into(), name: name.into(), auto, presets }
    }

    /// A phone that still offers Auto in a chat's settings (one built before providers were told apart) can't put a chat on another
    /// provider than Claude's on it, nor on one of Claude's presets: it is told why and nothing is restarted.
    #[tokio::test]
    async fn a_chat_on_another_provider_is_not_put_on_auto_or_a_claude_preset_from_a_phone() {
        let r = rig();
        r.store.set_allow_phone_auto(true).unwrap();
        r.hub.set_presets(vec![preset("balanced")]);
        r.hub.set_providers(vec![provider("claude", "Claude", true, true), provider("gateway:ollama", "Ollama", false, false)]);
        r.hub.opened("local", "/p");
        r.hub.set_provider("local", Some("Ollama"));
        r.hub.opened("codex", "/p");
        r.hub.set_provider("codex", Some("Codex")); // (a provider the window never listed for phones)
        r.hub.opened("claude", "/p");
        let (_, mut p) = paired(&r).await;
        use protocol::RemotePermissions::{Ask, Auto};
        for (slot, name) in [("local", "Ollama"), ("codex", "Codex")] {
            let (ok, err, _) = p.ask(Request::SetPermissions { slot: slot.into(), permissions: Auto }).await;
            assert!(ok.is_none() && err.is_some_and(|e| e == format!("{name} has no Auto mode: it asks before it acts.")), "{slot}");
            let (ok, err, _) = p.ask(Request::SetPreset { slot: slot.into(), preset: "balanced".into() }).await;
            assert!(ok.is_none() && err.is_some_and(|e| e == format!("{name} runs on its own model: the presets don't apply to it.")), "{slot}");
        }
        assert!(r.host.switched.lock().unwrap().is_empty(), "nothing reached the app");
        // Ask is always fine, and a Claude chat is as it was.
        assert!(p.ask(Request::SetPermissions { slot: "local".into(), permissions: Ask }).await.1.is_none());
        assert!(p.ask(Request::SetPermissions { slot: "claude".into(), permissions: Auto }).await.1.is_none());
        assert!(p.ask(Request::SetPreset { slot: "claude".into(), preset: "balanced".into() }).await.1.is_none());
        assert_eq!(*r.host.switched.lock().unwrap(), vec!["local:ask".to_string(), "claude:auto".to_string(), "claude:preset:balanced".to_string()]);
    }

    #[tokio::test]
    async fn a_phone_is_told_where_a_chat_may_run_when_there_is_more_than_claude() {
        let r = rig();
        r.hub.set_providers(vec![provider("claude", "Claude", true, true), provider("gateway:ollama", "Ollama", false, false)]);
        let (_, mut p) = paired(&r).await;
        let (ok, _, _) = p.ask(Request::Controls).await;
        assert_eq!(ok.unwrap()["providers"], json!([{"id": "claude", "name": "Claude", "auto": true, "presets": true}, {"id": "gateway:ollama", "name": "Ollama", "auto": false, "presets": false}]));
    }

    #[tokio::test]
    async fn a_chat_starts_where_the_phone_asks_only_if_the_window_listed_it_and_it_can_do_what_was_asked() {
        let r = rig();
        *r.host.projects.lock().unwrap() = vec![("/Users/me/app".into(), "app".into())];
        r.hub.set_presets(vec![preset("balanced")]);
        r.hub.set_providers(vec![provider("claude", "Claude", true, true), provider("gateway:ollama", "Ollama", false, false)]);
        r.store.set_allow_phone_auto(true).unwrap();
        let (_, mut p) = paired(&r).await;
        use protocol::RemotePermissions::{Ask, Auto};
        let ask = |provider: Option<&str>, permissions, preset: Option<&str>| Request::NewChat { project: "/Users/me/app".into(), text: "hi".into(), permissions, preset: preset.map(String::from), workflow: None, provider: provider.map(String::from) };
        // A name the phone made up, or one the window didn't list: refused, and nothing reaches the app.
        for made_up in ["codex", "gateway:other", "", "claude "] {
            let (ok, err, _) = p.ask(ask(Some(made_up), None, None)).await;
            assert!(ok.is_none() && err.is_some_and(|e| e.contains("isn't one of your providers")), "{made_up:?}");
        }
        // Auto, or one of Claude's presets, on a provider that has neither: refused in words, not quietly run as something else.
        let (_, err, _) = p.ask(ask(Some("gateway:ollama"), Some(Auto), None)).await;
        assert!(err.is_some_and(|e| e.contains("Ollama has no Auto mode")));
        let (_, err, _) = p.ask(ask(Some("gateway:ollama"), None, Some("balanced"))).await;
        assert!(err.is_some_and(|e| e.contains("Ollama runs on its own model")));
        assert!(r.host.started_provider.lock().unwrap().is_empty());
        // The ones it can do start there; Claude's own and the project's own are fine too.
        assert!(p.ask(ask(Some("gateway:ollama"), Some(Ask), None)).await.1.is_none());
        assert!(p.ask(ask(Some("claude"), Some(Auto), Some("balanced"))).await.1.is_none());
        assert!(p.ask(ask(None, None, None)).await.1.is_none());
        assert_eq!(*r.host.started_provider.lock().unwrap(), vec![Some("gateway:ollama".to_string()), Some("claude".to_string()), None]);
    }

    #[test]
    fn the_providers_a_phone_may_pick_are_kept_short_unique_and_only_when_there_is_a_choice() {
        let hub = SessionHub::default();
        hub.set_providers(vec![provider("claude", "Claude", true, true)]);
        assert!(hub.providers().is_empty(), "one is no choice");
        let many: Vec<_> = (0..60).map(|i| provider(&format!("p{}", i % 50), &"n".repeat(200), true, true)).collect();
        hub.set_providers(many);
        let kept = hub.providers();
        assert!(kept.len() <= 40 && kept.iter().all(|p| p.name.chars().count() <= 60));
        assert_eq!(kept.iter().map(|p| p.id.clone()).collect::<std::collections::BTreeSet<_>>().len(), kept.len(), "an id once");
        hub.set_providers(vec![provider("", "No id", true, true), provider("x", "X", true, true)]);
        assert!(hub.providers().is_empty(), "an empty id is dropped, leaving one");
    }

    #[tokio::test]
    async fn a_chat_starts_on_ask_unless_the_phone_asks_for_auto_and_the_mac_lets_phones_have_it() {
        let r = rig();
        *r.host.projects.lock().unwrap() = vec![("/Users/me/app".into(), "app".into())];
        r.hub.set_presets(vec![preset("balanced")]);
        let (_, mut p) = paired(&r).await;
        let ask = |permissions: Option<protocol::RemotePermissions>, preset: Option<&str>| Request::NewChat { project: "/Users/me/app".into(), text: "hi".into(), permissions, preset: preset.map(String::from), workflow: None, provider: None };
        use protocol::RemotePermissions::{Ask, Auto};
        // Nothing said: Ask. Auto while the setting is off: refused, and nothing reaches the app.
        assert!(p.ask(ask(None, None)).await.1.is_none());
        let (ok, err, _) = p.ask(ask(Some(Auto), None)).await;
        assert!(ok.is_none() && err.is_some_and(|e| e.contains("Auto from a phone is off")));
        assert_eq!(*r.host.started_with.lock().unwrap(), vec![(Ask, None)]);
        // On: Auto goes through, with its preset.
        r.store.set_allow_phone_auto(true).unwrap();
        assert!(p.ask(ask(Some(Auto), Some("balanced"))).await.1.is_none());
        assert_eq!(r.host.started_with.lock().unwrap().last(), Some(&(Auto, Some("balanced".to_string()))));
        // A preset that isn't one the window listed is refused, whatever else is allowed.
        let (ok, err, _) = p.ask(ask(Some(Ask), Some("../../etc"))).await;
        assert!(ok.is_none() && err.is_some_and(|e| e.contains("isn't one of your presets")));
        assert_eq!(r.host.started_with.lock().unwrap().len(), 2);
        // Off again: Auto is refused again.
        r.store.set_allow_phone_auto(false).unwrap();
        assert!(p.ask(ask(Some(Auto), None)).await.1.is_some());
    }

    #[tokio::test]
    async fn a_chat_is_put_on_auto_only_when_the_mac_lets_phones_and_on_ask_always() {
        use protocol::RemotePermissions::{Ask, Auto};
        let r = rig();
        r.hub.opened("a", "/p");
        r.hub.controls("a", "ask", Some("balanced"));
        let (_, mut p) = paired(&r).await;
        let set = |permissions| Request::SetPermissions { slot: "a".into(), permissions };
        let (ok, err, _) = p.ask(set(Auto)).await;
        assert!(ok.is_none() && err.is_some_and(|e| e.contains("Auto from a phone is off")));
        assert!(r.host.switched.lock().unwrap().is_empty(), "nothing reached the app");
        r.store.set_allow_phone_auto(true).unwrap();
        assert!(p.ask(set(Auto)).await.1.is_none());
        assert_eq!(*r.host.switched.lock().unwrap(), vec!["a:auto".to_string()]);
        // Back to Ask, even with the setting off: lowering is always allowed.
        r.hub.controls("a", "auto", Some("balanced"));
        r.store.set_allow_phone_auto(false).unwrap();
        assert!(p.ask(set(Ask)).await.1.is_none());
        assert_eq!(r.host.switched.lock().unwrap().last().map(String::as_str), Some("a:ask"));
        // A chat that isn't open is refused.
        let (_, err, _) = p.ask(Request::SetPermissions { slot: "nope".into(), permissions: Ask }).await;
        assert!(err.is_some_and(|e| e.contains("isn't open")));
    }

    #[tokio::test]
    async fn a_switch_to_what_a_chat_already_is_does_nothing_so_a_phone_cant_restart_claude_over_and_over() {
        use protocol::RemotePermissions::Ask;
        let r = rig();
        r.hub.opened("a", "/p");
        r.hub.controls("a", "ask", Some("balanced"));
        r.hub.set_presets(vec![preset("balanced"), preset("max")]);
        let (_, mut p) = paired(&r).await;
        for _ in 0..3 {
            assert!(p.ask(Request::SetPermissions { slot: "a".into(), permissions: Ask }).await.1.is_none());
            assert!(p.ask(Request::SetPreset { slot: "a".into(), preset: "balanced".into() }).await.1.is_none());
        }
        assert!(r.host.switched.lock().unwrap().is_empty(), "the app was never asked");
        assert!(p.ask(Request::SetPreset { slot: "a".into(), preset: "max".into() }).await.1.is_none());
        assert_eq!(*r.host.switched.lock().unwrap(), vec!["a:preset:max".to_string()]);
    }

    #[tokio::test]
    async fn a_chat_is_switched_only_while_it_is_doing_nothing() {
        use protocol::RemotePermissions::Ask;
        let r = rig();
        r.hub.set_presets(vec![preset("balanced"), preset("max")]);
        let (_, mut p) = paired(&r).await;
        // Working (Claude was just sent something), asleep, and one that asked a question: each refused, with why.
        r.hub.opened("busy", "/p");
        r.hub.record(&BusEvent { slot: "busy".into(), seq: 1, event: user("go") });
        r.hub.asleep("asleep", "/p", None, None);
        r.hub.opened("asks", "/p");
        r.hub.record(&BusEvent { slot: "asks".into(), seq: 1, event: UiEvent::PermissionRequested { request_id: "q".into(), tool_name: "Bash".into(), input: json!({}) } });
        for (slot, why) in [("busy", "busy"), ("asleep", "Wake it first"), ("asks", "busy")] {
            let (_, err, _) = p.ask(Request::SetPermissions { slot: slot.into(), permissions: Ask }).await;
            assert!(err.as_deref().is_some_and(|e| e.contains(why)), "{slot}: {err:?}");
            let (_, err, _) = p.ask(Request::SetPreset { slot: slot.into(), preset: "max".into() }).await;
            assert!(err.as_deref().is_some_and(|e| e.contains(why)), "{slot}: {err:?}");
        }
        assert!(r.host.switched.lock().unwrap().is_empty(), "nothing reached the app");
    }

    #[tokio::test]
    async fn a_preset_is_taken_only_if_the_window_listed_it() {
        let r = rig();
        r.hub.opened("a", "/p");
        r.hub.set_presets(vec![preset("balanced")]);
        let (_, mut p) = paired(&r).await;
        let (_, err, _) = p.ask(Request::SetPreset { slot: "a".into(), preset: "made-up".into() }).await;
        assert!(err.is_some_and(|e| e.contains("isn't one of your presets")));
        assert!(r.host.switched.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_phone_may_only_start_so_many_chats_in_a_while() {
        let r = rig();
        *r.host.projects.lock().unwrap() = vec![("/Users/me/app".into(), "app".into())];
        let (_, mut p) = paired(&r).await;
        for i in 0..NEW_CHATS_PER_WINDOW {
            assert!(p.ask(Request::NewChat { project: "/Users/me/app".into(), text: format!("chat {i}"), permissions: None, preset: None, workflow: None, provider: None }).await.1.is_none());
        }
        let (ok, err, _) = p.ask(Request::NewChat { project: "/Users/me/app".into(), text: "one more".into(), permissions: None, preset: None, workflow: None, provider: None }).await;
        assert!(ok.is_none() && err.is_some_and(|e| e.contains("a lot of chats")));
        assert_eq!(r.host.started.lock().unwrap().len(), NEW_CHATS_PER_WINDOW);
    }

    #[tokio::test]
    async fn the_limit_on_new_chats_is_per_phone_and_lifts_with_time() {
        let r = rig();
        let at = |t: u64| NEW_CHAT_WINDOW_MS * 10 + t;
        for i in 0..NEW_CHATS_PER_WINDOW as u64 {
            assert!(r.gw.allow_new_chat_at("phone-a", at(i)).is_ok());
        }
        assert!(r.gw.allow_new_chat_at("phone-a", at(10)).is_err());
        assert!(r.gw.allow_new_chat_at("phone-b", at(10)).is_ok(), "another phone has its own count");
        assert!(r.gw.allow_new_chat_at("phone-a", at(NEW_CHAT_WINDOW_MS + 5)).is_ok(), "the earliest ones have aged out");
    }

    /// A chat "a" with something said in it, for the suggestions to go on.
    fn talked(r: &Rig) {
        r.hub.opened("a", "/Users/me/app");
        r.hub.titled("a", "Release 0.1.53");
        r.bus.publish("a", UiEvent::UserText { text: "Cut the release".into(), at: Some(1), sent_by: None, images: 0 });
        r.bus.publish("a", UiEvent::AssistantText { parent: None, block_id: "b".into(), text: "Done: tests pass.".into() });
    }

    const REPLY: &str = r#"[{"kind":"continue","slot":"a","title":"Write the notes","why":"The release is cut.","message":"Write the release notes."},{"kind":"new","project":"site","title":"Fix the footer","why":"It says 2025.","message":"Update the year."}]"#;

    #[tokio::test]
    async fn a_phone_is_given_drafts_made_from_the_chats_for_chats_and_projects_that_exist() {
        let r = rig();
        talked(&r);
        *r.host.projects.lock().unwrap() = vec![("/Users/me/app".into(), "app".into()), ("/Users/me/site".into(), "site".into())];
        *r.host.replies.lock().unwrap() = vec![Ok(REPLY.into())];
        let (_, mut p) = paired(&r).await;
        let (ok, err, _) = p.ask(Request::Suggest { refresh: false }).await;
        assert!(err.is_none(), "{err:?}");
        let ok = ok.unwrap();
        assert_eq!(ok["items"][0], json!({"id": "s1", "title": "Write the notes", "why": "The release is cut.", "message": "Write the release notes.", "target": {"kind": "continue", "slot": "a"}}));
        assert_eq!(ok["items"][1]["target"], json!({"kind": "new_chat", "project": "/Users/me/site", "project_name": "site"}));
        assert!(ok["generated_at"].as_u64().unwrap() > 0);
        // The model was told about the chat, what was said in it, and the projects by name: and nothing like a path.
        let prompts = r.host.prompts.lock().unwrap();
        assert_eq!(prompts.len(), 1);
        for must in ["id=a", "project=app", "Release 0.1.53", "Cut the release", "Done: tests pass.", "app, site"] {
            assert!(prompts[0].contains(must), "{must}: {}", prompts[0]);
        }
        assert!(!prompts[0].contains("/Users/me"), "no folder paths go to the model");
    }

    /// What a phone hears, in order, until it has had the answers to all of `ids` (events and chat lists in between are noted).
    async fn heard_until(p: &mut Phone, ids: &[u64]) -> Vec<String> {
        let mut seen = Vec::new();
        let mut left: Vec<u64> = ids.to_vec();
        while !left.is_empty() {
            match p.next().await.expect("something") {
                ServerMessage::Response { id, .. } => {
                    seen.push(format!("answer {id}"));
                    left.retain(|i| *i != id);
                }
                ServerMessage::Event { .. } => seen.push("event".into()),
                _ => {}
            }
        }
        seen
    }

    #[tokio::test]
    async fn a_slow_suggestion_doesnt_stop_that_phone_getting_answers_or_events_meanwhile() {
        let r = rig();
        talked(&r);
        *r.host.suggest_delay.lock().unwrap() = Duration::from_millis(600);
        let (_, mut p) = paired(&r).await;
        assert!(p.ask(Request::Subscribe { slot: "a".into(), after: 0, epoch: EPOCH }).await.1.is_none());
        p.send(&ClientMessage::Request { id: 100, request: Request::Suggest { refresh: false } });
        p.send(&ClientMessage::Request { id: 101, request: Request::ListChats });
        tokio::time::sleep(Duration::from_millis(100)).await;
        r.bus.publish("a", user("typed on the Mac while Claude thinks"));
        let order = heard_until(&mut p, &[100, 101]).await;
        let at = |what: &str| order.iter().position(|x| x == what).unwrap_or_else(|| panic!("{what} in {order:?}"));
        assert!(at("answer 101") < at("answer 100"), "a quick request is answered while the slow one waits: {order:?}");
        assert!(at("event") < at("answer 100"), "and the chat's events keep coming: {order:?}");
    }

    #[tokio::test]
    async fn a_chat_that_is_slow_to_open_doesnt_stop_that_phone_either() {
        let r = rig();
        *r.host.projects.lock().unwrap() = vec![("/Users/me/app".into(), "app".into())];
        *r.host.new_chat_delay.lock().unwrap() = Duration::from_millis(600);
        let (_, mut p) = paired(&r).await;
        p.send(&ClientMessage::Request { id: 100, request: Request::NewChat { project: "/Users/me/app".into(), text: "Fix it".into(), permissions: None, preset: None, workflow: None, provider: None } });
        p.send(&ClientMessage::Request { id: 101, request: Request::ListChats });
        let order = heard_until(&mut p, &[100, 101]).await;
        assert_eq!(order, vec!["answer 101".to_string(), "answer 100".to_string()]);
    }

    #[tokio::test]
    async fn one_phone_cant_have_more_than_a_few_slow_requests_going_at_once() {
        let r = rig();
        *r.host.projects.lock().unwrap() = vec![("/Users/me/app".into(), "app".into())];
        *r.host.new_chat_delay.lock().unwrap() = Duration::from_millis(400);
        let (_, mut p) = paired(&r).await;
        for id in 100..110 {
            p.send(&ClientMessage::Request { id, request: Request::NewChat { project: "/Users/me/app".into(), text: format!("chat {id}"), permissions: None, preset: None, workflow: None, provider: None } });
        }
        // All ten arrive before the first of the slow ones finishes: three run, and the rest are refused at once.
        let (mut ran, mut refused) = (0, Vec::new());
        while ran + refused.len() < 10 {
            if let Some(ServerMessage::Response { ok, error, .. }) = p.next().await {
                match (ok, error) {
                    (Some(_), _) => ran += 1,
                    (_, Some(why)) => refused.push(why),
                    _ => {}
                }
            }
        }
        assert_eq!(ran, SLOW_AT_ONCE);
        assert_eq!(refused.len(), 10 - SLOW_AT_ONCE);
        assert!(refused.iter().all(|e| e.contains("one thing at a time")), "{refused:?}");
        assert_eq!(r.host.started.lock().unwrap().len(), SLOW_AT_ONCE, "only the ones that ran reached the app");
    }

    #[tokio::test]
    async fn suggestions_are_kept_and_shared_so_phones_asking_again_cost_nothing() {
        let r = rig();
        talked(&r);
        *r.host.replies.lock().unwrap() = vec![Ok(REPLY.into())];
        let (_, mut one) = paired(&r).await;
        let first = one.ask(Request::Suggest { refresh: false }).await.0;
        let (_, mut two) = paired(&r).await;
        let second = two.ask(Request::Suggest { refresh: false }).await.0;
        assert_eq!(first, second);
        // A refresh straight after is not a new call either.
        assert_eq!(one.ask(Request::Suggest { refresh: true }).await.0, first);
        assert_eq!(r.host.prompts.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_model_that_fails_is_said_to_the_phone_in_its_words_and_garbage_gives_no_drafts() {
        let r = rig();
        talked(&r);
        *r.host.replies.lock().unwrap() = vec![Err("Claude didn't answer in time.".into())];
        let (_, mut p) = paired(&r).await;
        let (ok, err, _) = p.ask(Request::Suggest { refresh: false }).await;
        assert!(ok.is_none() && err.as_deref() == Some("Claude didn't answer in time."));
        let r2 = rig();
        talked(&r2);
        *r2.host.replies.lock().unwrap() = vec![Ok("I think you should rm -rf everything".into())];
        let (_, mut q) = paired(&r2).await;
        assert_eq!(q.ask(Request::Suggest { refresh: false }).await.0.unwrap()["items"], json!([]));
    }

    #[tokio::test]
    async fn the_chat_list_is_sent_again_when_it_changes() {
        let r = rig();
        let (_, mut p) = paired(&r).await;
        let Some(ServerMessage::Chats { chats }) = p.next().await else { panic!() };
        assert!(chats.is_empty());
        r.hub.opened("a", "/p/lantern");
        let chats = loop {
            if let Some(ServerMessage::Chats { chats }) = p.next().await {
                break chats;
            }
        };
        assert_eq!((chats.len(), chats[0].project.as_deref()), (1, Some("lantern")));
    }

    /// The next chat list the phone is sent.
    async fn next_chats(p: &mut Phone) -> Vec<RemoteChat> {
        loop {
            if let Some(ServerMessage::Chats { chats }) = p.next().await {
                return chats;
            }
        }
    }

    #[tokio::test]
    async fn the_chat_list_is_sent_again_when_a_chats_mode_or_preset_changes() {
        let r = rig();
        r.hub.opened("a", "/p/lantern");
        r.hub.controls("a", "ask", Some("balanced"));
        let (_, mut p) = paired(&r).await;
        let first = next_chats(&mut p).await;
        assert_eq!((first[0].permissions, first[0].preset.as_deref()), (Some(protocol::RemotePermissions::Ask), Some("balanced")));
        r.hub.controls("a", "auto", Some("balanced"));
        let again = next_chats(&mut p).await;
        assert_eq!(again[0].permissions, Some(protocol::RemotePermissions::Auto));
        r.hub.controls("a", "auto", Some("max"));
        let again = next_chats(&mut p).await;
        assert_eq!(again[0].preset.as_deref(), Some("max"));
        r.hub.colored("a", Some("#0f8a7e"));
        let again = next_chats(&mut p).await;
        assert_eq!(again[0].project_color.as_deref(), Some("#0f8a7e"), "a project's colour changing is shown too");
        // What the chat is doing is the row's preview line, and a change in it is sent too.
        r.bus.publish("a", UiEvent::ToolStarted { parent: None, tool_use_id: "t1".into(), name: "Bash".into(), summary: "npm test".into() });
        let again = next_chats(&mut p).await;
        assert_eq!(again[0].preview.as_deref(), Some("Bash npm test"));
    }

    /// A phone's side over a real transport link (the Wi-Fi one), as `phone` does over memory.
    async fn phone_over(mut mine: Link, key: &Keypair, secret: [u8; 32]) -> Result<Phone, String> {
        mine.to_peer.send(vec![secure::PAIR]).await.map_err(|e| e.to_string())?;
        let mut hs = Handshake::pair_initiator(key, &secret)?;
        mine.to_peer.send(hs.write()?).await.map_err(|e| e.to_string())?;
        hs.read(&mine.from_peer.recv().await.ok_or("closed")?)?;
        mine.to_peer.send(hs.write()?).await.map_err(|e| e.to_string())?;
        let (_, channel) = hs.finish()?;
        let mut p = Phone { link: mine, channel, next: 0, hosts: Vec::new() };
        p.send(&ClientMessage::Hello { protocol: PROTOCOL_VERSION, app_version: "1.0".into(), device_name: "Wi-Fi phone".into(), features: vec![] });
        matches!(p.next().await, Some(ServerMessage::Welcome { .. })).then_some(p).ok_or("no welcome".into())
    }

    #[tokio::test]
    async fn end_to_end_over_the_wifi_transport_a_phone_pairs_follows_a_chat_and_answers_a_prompt() {
        let r = rig();
        r.hub.opened("a", "/p");
        let door = r.gw.clone();
        let (listener, port) = crate::remote::transport::serve_lan(0, move |link| door.accept(link)).await.unwrap();
        let link = crate::remote::transport::connect_lan(&format!("127.0.0.1:{port}")).await.unwrap();
        let mut p = phone_over(link, &generate_keypair().unwrap(), offer_secret(&r.store)).await.unwrap();
        p.ask(Request::Subscribe { slot: "a".into(), after: 0, epoch: EPOCH }).await;
        *r.host.pending.lock().unwrap() = vec![Pending { request_id: "p1".into(), tool_name: "Bash".into(), input: json!({"command": "npm test"}), at: 1 }];
        r.bus.publish("a", UiEvent::PermissionRequested { request_id: "p1".into(), tool_name: "Bash".into(), input: json!({"command": "npm test"}) });
        loop {
            if let Some(ServerMessage::Event { event: RemoteEvent::PermissionRequested { request_id, .. }, .. }) = p.next().await {
                assert_eq!(request_id, "p1");
                break;
            }
        }
        let (_, err, _) = p.ask(Request::Answer { slot: "a".into(), request_id: "p1".into(), allow: true, message: None, answers: None }).await;
        assert!(err.is_none());
        assert_eq!(r.host.answered.lock().unwrap()[0].0, "p1");
        listener.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_phone_too_slow_to_read_is_dropped_and_catches_up_when_it_comes_back() {
        let r = rig();
        r.hub.opened("a", "/p");
        let (key, mut p) = paired(&r).await;
        p.ask(Request::Subscribe { slot: "a".into(), after: 0, epoch: EPOCH }).await;
        // It stops reading while far more than its outbox holds goes out, and the gateway gets to all of it.
        for i in 0..crate::remote::transport::OUTBOX * 2 {
            r.bus.publish("a", UiEvent::AssistantText { parent: None, block_id: format!("b{i}"), text: "x".into() });
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        let mut seen = 0u64;
        while let Some(m) = p.next().await {
            if let ServerMessage::Event { seq, .. } = m {
                seen = seq;
            }
        }
        assert!(seen < (crate::remote::transport::OUTBOX * 2) as u64, "it was dropped before it had everything");
        let mut p = phone(&r.gw, &key, None, PROTOCOL_VERSION).await.unwrap();
        let (_, _, before) = p.ask(Request::Subscribe { slot: "a".into(), after: seen, epoch: EPOCH }).await;
        let last = before.iter().filter_map(|m| if let ServerMessage::Event { seq, .. } = m { Some(*seq) } else { None }).max();
        assert_eq!(last, Some((crate::remote::transport::OUTBOX * 2) as u64), "and has everything after coming back");
    }

    #[tokio::test]
    async fn once_remote_control_is_off_nothing_listens_and_every_phone_is_gone() {
        let r = rig();
        let remote = crate::remote::Remote::default();
        let door = r.gw.clone();
        let (listener, port) = crate::remote::transport::serve_lan(0, move |link| door.accept(link)).await.unwrap();
        remote.set_running(crate::remote::Running { gateway: r.gw.clone(), listener, bonjour: None, notifier: None });
        let (_, mut p) = paired(&r).await;
        assert!(remote.is_running());
        remote.stop();
        while p.next().await.is_some() {}
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_err(), "the port is closed");
        assert!(!remote.is_running());
    }

    #[tokio::test]
    async fn turning_remote_control_off_mid_handshake_keeps_that_phone_out() {
        let r = rig();
        let key = generate_keypair().unwrap();
        let secret = offer_secret(&r.store);
        let (mut mine, theirs) = link_pair();
        r.gw.accept(theirs);
        mine.to_peer.send(vec![secure::PAIR]).await.unwrap();
        let mut hs = Handshake::pair_initiator(&key, &secret).unwrap();
        mine.to_peer.send(hs.write().unwrap()).await.unwrap();
        hs.read(&mine.from_peer.recv().await.unwrap()).unwrap();
        // Turned off now, with the phone halfway in.
        r.gw.disconnect_all();
        mine.to_peer.send(hs.write().unwrap()).await.unwrap();
        let (_, channel) = hs.finish().unwrap();
        let mut p = Phone { link: mine, channel, next: 0, hosts: Vec::new() };
        p.send(&ClientMessage::Hello { protocol: PROTOCOL_VERSION, app_version: "1".into(), device_name: "Late".into(), features: vec![] });
        assert!(matches!(p.next().await, Some(ServerMessage::Welcome { .. })));
        assert!(p.next().await.is_none(), "closed instead of let in");
        assert!(r.gw.connected().is_empty());
        let (mut another, theirs) = link_pair();
        r.gw.accept(theirs);
        assert!(another.from_peer.recv().await.is_none(), "and nothing new is taken");
    }

    #[tokio::test]
    async fn numbers_from_before_lantern_restarted_start_the_chat_over_and_live_events_still_come() {
        let r = rig();
        r.hub.opened("a", "/p");
        r.bus.publish("a", user("hi"));
        let (_, mut p) = paired(&r).await;
        for (after, epoch, why) in [(500, EPOCH, "a number Lantern hasn't reached"), (1, EPOCH + 1, "another run's number")] {
            let (_, _, before) = p.ask(Request::Subscribe { slot: "a".into(), after, epoch }).await;
            assert!(before.iter().any(|m| matches!(m, ServerMessage::Reset { .. })), "{why}: a reset");
        }
        r.bus.publish("a", UiEvent::Thinking { parent: None });
        loop {
            if let Some(ServerMessage::Event { seq, event: RemoteEvent::Thinking, .. }) = p.next().await {
                assert_eq!(seq, 2);
                break;
            }
        }
    }

    #[tokio::test]
    async fn a_reset_says_how_many_earlier_turns_it_left_out_and_they_come_when_asked() {
        let r = rig();
        r.hub.opened("a", "/p");
        *r.host.history.lock().unwrap() = vec![user("last turn")];
        let (_, mut p) = paired(&r).await;
        let (_, _, before) = p.ask(Request::Subscribe { slot: "a".into(), after: 0, epoch: EPOCH }).await;
        assert!(before.iter().any(|m| matches!(m, ServerMessage::Reset { hidden: 0, .. })));
        let (ok, err, _) = p.ask(Request::Earlier { slot: "a".into(), hidden: 3 }).await;
        assert!(err.is_none());
        let page: protocol::EarlierPage = serde_json::from_value(ok.unwrap()).unwrap();
        assert_eq!(page.events.len(), 1);
    }

    #[tokio::test]
    async fn a_chat_opened_before_its_session_is_known_gets_its_history_once_it_is() {
        let r = rig();
        r.hub.opened("a", "/p");
        let (_, mut p) = paired(&r).await;
        // The phone opens a chat restored from History before the window has said which session it is: nothing to show yet.
        let (_, _, before) = p.ask(Request::Subscribe { slot: "a".into(), after: 0, epoch: EPOCH }).await;
        assert!(before.iter().any(|m| matches!(m, ServerMessage::Reset { events, .. } if events.is_empty())));
        *r.host.history.lock().unwrap() = vec![user("last turn")];
        r.hub.session("a", "abc-123");
        let heard = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let ServerMessage::Reset { events, .. } = p.next().await.expect("something") {
                    break events;
                }
            }
        })
        .await
        .expect("a reset with the history in it");
        assert_eq!(heard.len(), 1);
    }

    #[tokio::test]
    async fn a_chat_a_phone_follows_is_watched_until_it_unfollows_or_goes_and_opening_it_is_told() {
        let r = rig();
        r.hub.opened("a", "/p");
        let opened: Arc<Mutex<Vec<String>>> = Arc::default();
        let o = opened.clone();
        r.gw.on_open(Arc::new(move |slot| o.lock().unwrap().push(slot.to_string())));
        let (_, mut p) = paired(&r).await;
        assert!(!r.gw.watched("a"));
        p.ask(Request::Subscribe { slot: "a".into(), after: 0, epoch: EPOCH }).await;
        assert!(r.gw.watched("a"));
        assert_eq!(*opened.lock().unwrap(), vec!["a".to_string()]);
        // A second phone following it too: it is watched until both let go.
        let (_, mut q) = paired(&r).await;
        q.ask(Request::Subscribe { slot: "a".into(), after: 0, epoch: EPOCH }).await;
        p.ask(Request::Unsubscribe { slot: "a".into() }).await;
        assert!(r.gw.watched("a"), "the other phone still follows it");
        drop(q);
        let started = std::time::Instant::now();
        while r.gw.watched("a") && started.elapsed() < Duration::from_secs(2) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(!r.gw.watched("a"), "a phone that goes follows nothing");
        p.ask(Request::Subscribe { slot: "a".into(), after: 0, epoch: EPOCH }).await;
        assert_eq!(opened.lock().unwrap().len(), 3, "opening again is told again");
    }

    fn said(text: &str, at: Option<u64>) -> RemoteEvent {
        RemoteEvent::UserText { text: text.into(), at, sent_by: None, images: None }
    }

    #[test]
    fn a_catch_up_in_the_middle_of_a_turn_shows_its_message_once() {
        let reply = |t: &str| RemoteEvent::AssistantText { block_id: t.into(), text: t.into() };
        // The transcript already has the turn's message (a moment after the hub's copy) and part of its reply.
        let history = vec![said("earlier", Some(100)), reply("old"), said("go", Some(2_001)), reply("partial")];
        let live = vec![said("go", Some(2_000)), RemoteEvent::Thinking, reply("so far")];
        let merged = merge_current_turn(history, live.clone());
        assert_eq!(merged.iter().filter(|e| matches!(e, RemoteEvent::UserText { text, .. } if text == "go")).count(), 1);
        assert_eq!(merged, vec![said("earlier", Some(100)), reply("old"), said("go", Some(2_000)), RemoteEvent::Thinking, reply("so far")]);
        // The transcript doesn't have the message yet: nothing is cut.
        let behind = merge_current_turn(vec![said("earlier", Some(100)), reply("old")], live.clone());
        assert_eq!(behind.len(), 5);
    }

    #[test]
    fn an_earlier_turn_with_the_same_words_is_not_taken_for_the_current_one() {
        // "Next" answered the last page a minute ago and answers this one now.
        let history = vec![said("Next", Some(1_000)), RemoteEvent::Thinking];
        let live = vec![said("Next", Some(61_000)), RemoteEvent::Thinking];
        let merged = merge_current_turn(history, live);
        assert_eq!(merged.iter().filter(|e| matches!(e, RemoteEvent::UserText { .. })).count(), 2);
    }

    #[test]
    fn a_live_turn_that_lost_its_start_is_added_as_it_is() {
        let merged = merge_current_turn(vec![said("x", Some(1))], vec![RemoteEvent::Thinking]);
        assert_eq!(merged, vec![said("x", Some(1)), RemoteEvent::Thinking]);
    }

    #[test]
    fn a_long_chat_goes_in_pages_and_an_empty_one_in_one() {
        let big = |i: u32| RemoteEvent::AssistantText { block_id: format!("b{i}"), text: "x".repeat(200_000) };
        let p = pages((0..5).map(big).collect());
        assert!(p.len() >= 2);
        assert!(p.iter().take(p.len() - 1).all(|(_, done)| !done) && p.last().unwrap().1);
        assert_eq!(p.iter().map(|(e, _)| e.len()).sum::<usize>(), 5);
        assert_eq!(pages(vec![]), vec![(vec![], true)]);
    }
}
