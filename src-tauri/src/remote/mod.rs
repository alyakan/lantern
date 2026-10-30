//! Lantern's remote side: the event bus every chat's events leave from, the session hub that keeps what a client
//! joining late needs, and what lets a paired phone in: pairing, the secure channel and the protocol (see
//! docs/MOBILE.md).

pub mod answers;
pub mod bus;
pub mod fixture;
pub mod hub;
pub mod keys;
pub mod live_activity;
pub mod notifier;
pub mod pairing;
pub mod rich;
pub mod push_log;
pub mod protocol;
pub mod secure;
pub mod suggest;
pub mod transport;
pub mod gateway;

use crate::slots::SlotEvent;
use crate::ui_event::UiEvent;
use bus::{BusEvent, EventBus};
use hub::SessionHub;
use keys::KeyStore;
use pairing::RemoteStore;
use serde::Serialize;
use std::sync::Arc;

/// Who sent a message typed in Lantern's own window (UserText's `sent_by`).
pub const SENT_BY_DESKTOP: &str = "desktop";

/// The port Lantern listens on for phones while Remote control is on (Bonjour says it too).
pub const PORT: u16 = 47123;

/// The port to listen on: `PORT`, or LANTERN_REMOTE_PORT when it names a free-range one (above 1023), so a dev run can be
/// listening beside the real app (which holds `PORT`) instead of failing to, and a phone then talking to the wrong one.
pub fn port() -> u16 {
    port_from(std::env::var("LANTERN_REMOTE_PORT").ok().as_deref())
}

fn port_from(var: Option<&str>) -> u16 {
    var.and_then(|v| v.trim().parse::<u16>().ok()).filter(|p| *p > 1023).unwrap_or(PORT)
}

/// The bus and the hub, joined (everything published is kept by the hub before any subscriber sees it), with Remote
/// control's settings, paired devices and the Mac's key.
pub struct Remote {
    pub bus: Arc<EventBus>,
    pub hub: Arc<SessionHub>,
    pub store: Arc<RemoteStore>,
    keys: Box<dyn KeyStore>,
    /// This run of Lantern's, random: event numbers start again each launch, so a phone tells them apart by it.
    pub epoch: u64,
    /// Held while Remote control starts or stops, so two can't race (a double click, the start at launch).
    pub lifecycle: tokio::sync::Mutex<()>,
    /// The gateway, listener and Bonjour while Remote control is on.
    running: std::sync::Mutex<Option<Running>>,
    /// Where the window found `claude` (it tells the backend), for the calls the backend makes itself (suggestions).
    claude: std::sync::Mutex<Option<String>>,
    /// Chats a phone asked the window to start, waiting for the window to say which slot it made (see `expect_new_chat`).
    new_chats: std::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<Result<String, String>>>>,
    /// Keeps the Mac from sleeping from idling while Remote control is on and the user asked for that. Its own hold,
    /// apart from the one that lasts while Claude works (awake.rs), so neither lets go of the other's.
    pub awake: crate::awake::Awake,
    /// The push key for the lock-screen cards, imported in Settings (see live_activity.rs).
    pub live: Arc<live_activity::LiveKey>,
}

/// What the window is asked when a phone starts a chat. The gateway has checked the folder, the text, and Auto against the
/// setting; the window checks them again, and starts the chat on `permissions` ("ask", or "auto" when the Mac lets phones
/// use it) and the `preset`, without switching what it shows.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NewChatRequest {
    /// Single-use: the window answers with it (`Remote::new_chat_done`).
    pub id: String,
    pub folder: String,
    pub text: String,
    pub permissions: &'static str,
    /// The id of one of the presets the window listed, or None for the project's own.
    pub preset: Option<String>,
    /// "chat" or "steps" (a team is started on the Mac).
    pub workflow: &'static str,
    /// The id of one of the providers the window listed, or None for the project's own.
    pub provider: Option<String>,
}

/// What the window is asked when a phone puts a chat on Chat or Step by step. The gateway has checked the chat; the window checks again.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SetWorkflowRequest {
    pub slot: String,
    pub workflow: &'static str,
}

/// What the window is asked when a phone puts a chat on Ask or Auto. The gateway has checked the chat and Auto against the
/// setting; the window checks again (any window can emit what it listens to).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SetPermissionsRequest {
    pub slot: String,
    pub permissions: &'static str,
}

/// What the window is asked when a phone closes a chat. The gateway has checked it is listed and not busy; the window checks again.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CloseRequest {
    pub slot: String,
}

/// What the window is asked when a phone names a chat. The gateway has checked the chat has a conversation and the name is one;
/// the window checks again.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RenameRequest {
    pub slot: String,
    pub title: String,
}

/// What the window is asked when a phone puts a chat on one of the presets.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SetPresetRequest {
    pub slot: String,
    pub preset: String,
}

/// The projects a phone may start a chat in, as (folder, name): the folders the user has used Claude in lately and those
/// with a chat open now, each once, the most recent first, at most `LIMIT`.
pub fn known_projects(recent: &[String], open: &[String]) -> Vec<(String, String)> {
    const LIMIT: usize = 12;
    let mut seen: Vec<&String> = Vec::new();
    for f in recent.iter().chain(open) {
        if f.starts_with('/') && !f.contains('\0') && !seen.contains(&f) {
            seen.push(f);
        }
    }
    let chosen: Vec<&String> = seen.into_iter().take(LIMIT).collect();
    let name = |f: &str, parents: usize| {
        let parts: Vec<String> = std::path::Path::new(f).components().filter_map(|c| match c {
            std::path::Component::Normal(n) => Some(n.to_string_lossy().into_owned()),
            _ => None,
        }).collect();
        if parts.is_empty() { f.to_string() } else { parts[parts.len().saturating_sub(1 + parents)..].join("/") }
    };
    // Two folders with the same name ("app" in two places) are told apart by their parent: "work/app" and "play/app".
    chosen
        .iter()
        .map(|f| {
            let clash = chosen.iter().filter(|o| name(o, 0) == name(f, 0)).count() > 1;
            (f.to_string(), name(f, usize::from(clash)))
        })
        .collect()
}

impl Default for Remote {
    fn default() -> Self {
        Self::new(RemoteStore::load(None), Box::new(keys::Memory::default()))
    }
}

/// Remote control while it is on: the gateway, the listener feeding it, and the Bonjour record (None when Bonjour
/// couldn't start: a phone then dials the address from its QR code).
pub struct Running {
    pub gateway: Arc<gateway::Gateway>,
    pub listener: tokio::task::JoinHandle<()>,
    pub bonjour: Option<transport::Bonjour>,
    /// The task that pushes to phones that aren't looking (see notifier.rs).
    pub notifier: Option<tokio::task::JoinHandle<()>>,
    /// The notifier itself, for what isn't a chat's event: a to-do's reminder.
    pub pusher: Option<Arc<notifier::Notifier>>,
}

impl Remote {
    pub fn is_running(&self) -> bool {
        self.running.lock().unwrap().is_some()
    }

    pub fn set_running(&self, running: Running) {
        if let Some(old) = self.running.lock().unwrap().replace(running) {
            old.gateway.disconnect_all();
            old.listener.abort();
            old.notifier.iter().for_each(|n| n.abort());
        }
        self.sync_awake();
    }

    /// Stops listening and closes every phone's connection.
    pub fn stop(&self) {
        if let Some(r) = self.running.lock().unwrap().take() {
            r.gateway.disconnect_all();
            r.listener.abort();
            r.notifier.iter().for_each(|n| n.abort());
        }
        self.sync_awake();
    }

    /// Holds the Mac awake exactly while something is listening for phones and the setting is on. Called after anything
    /// that changes either; a hold that died on its own is started again.
    pub fn sync_awake(&self) {
        self.awake.update(self.is_running(), self.store.saved().keep_awake);
    }

    /// Closes a device's connections (it was removed).
    pub fn disconnect(&self, device: &str) {
        if let Some(r) = self.running.lock().unwrap().as_ref() {
            r.gateway.disconnect_device(device);
        }
    }

    /// What pushes to phones, while Remote control is on.
    pub fn notifier(&self) -> Option<Arc<notifier::Notifier>> {
        self.running.lock().unwrap().as_ref().and_then(|r| r.pusher.clone())
    }

    pub fn connected(&self) -> Vec<String> {
        self.running.lock().unwrap().as_ref().map(|r| r.gateway.connected()).unwrap_or_default()
    }
}

/// A paired device as Settings lists it (its key and push token stay in the backend).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DeviceView {
    pub id: String,
    pub name: String,
    pub paired_at: u64,
    pub last_seen: Option<u64>,
}

/// Settings › Remote control.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RemoteView {
    pub enabled: bool,
    pub show_titles: bool,
    /// Notifications say what Claude asks, sealed for the phone's extension (see rich.rs).
    pub rich_notifications: bool,
    pub keep_awake: bool,
    /// The Mac's Tailscale addresses (none when Tailscale isn't on): what lets a phone reach it away from home.
    pub tailnet: Vec<String>,
    pub allow_phone_auto: bool,
    pub devices: Vec<DeviceView>,
    /// The ids of the devices connected now.
    pub connected: Vec<String>,
    /// Something is listening for phones (Remote control can be on in the settings and still not be: the port was taken).
    pub listening: bool,
    /// A pairing code is on offer and unused.
    pub pairing: bool,
    /// The id of the push key imported for the lock-screen cards (None: none yet, so no card is kept up to date).
    pub live_key: Option<String>,
    /// What Apple last answered about a card, in words (no token, payload or key).
    pub live_last: Option<String>,
    /// The last change holds, but couldn't be saved: why (it won't last past a restart).
    pub warning: Option<String>,
}

/// The QR code a phone pairs with, and when it stops working.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PairView {
    pub svg: String,
    /// The same code as text, to copy for a phone whose camera can't read the screen (it works once, like the QR code).
    pub link: String,
    pub expires_at: u64,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Whether an interface is one a phone on the same Wi-Fi or cable can reach: Ethernet and Wi-Fi (`en0`, `eth0`, `wlan0`),
/// not the bridges, tunnels and virtual switches that VMs, containers and VPNs add (`bridge100`, `utun3`, `vmnet8`).
fn is_lan_interface(name: &str) -> bool {
    ["en", "eth", "wlan", "wlp", "wlo", "enp", "eno"].iter().any(|p| name.strip_prefix(p).is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit())))
}

/// Whether an interface is Tailscale's (`utun4` on a Mac, `tailscale0` on Linux).
fn is_tailnet_interface(name: &str) -> bool {
    name.starts_with("utun") || name.starts_with("tailscale")
}

/// Tailscale gives every device an address in 100.64.0.0/10 (the range carriers' shared addresses use too, so the interface
/// is checked as well: a Wi-Fi hotspot's shared address isn't one the phone could reach from outside).
pub fn is_tailnet_address(ip: std::net::Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    a == 100 && (64..128).contains(&b)
}

/// The Mac's Tailscale addresses, from (interface, address) pairs.
fn tailnet_hosts(ifaces: &[(String, std::net::Ipv4Addr)]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (_, ip) in ifaces.iter().filter(|(name, ip)| is_tailnet_interface(name) && is_tailnet_address(*ip)) {
        let ip = ip.to_string();
        if !out.contains(&ip) {
            out.push(ip);
        }
    }
    out
}

/// The addresses to offer, from (interface, address) pairs: private IPv4 on LAN interfaces, the first interface (`en0`, the
/// Wi-Fi) first, then the Mac's Tailscale addresses, which reach it from anywhere.
fn offered_hosts(ifaces: &[(String, std::net::Ipv4Addr)]) -> Vec<String> {
    let mut lan: Vec<&(String, std::net::Ipv4Addr)> = ifaces.iter().filter(|(name, ip)| is_lan_interface(name) && ip.is_private()).collect();
    lan.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out: Vec<String> = Vec::new();
    for ip in lan.into_iter().map(|(_, ip)| ip.to_string()).chain(tailnet_hosts(ifaces)) {
        if !out.contains(&ip) {
            out.push(ip);
        }
    }
    out
}

/// The Mac's IPv4 addresses that aren't loopback, with their interface.
fn interface_addresses() -> Vec<(String, std::net::Ipv4Addr)> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback())
        .filter_map(|i| match i.ip() {
            std::net::IpAddr::V4(v4) => Some((i.name, v4)),
            _ => None,
        })
        .collect()
}

/// The Mac's addresses a phone may dial: those on its local networks (where a phone dials when Bonjour finds nothing),
/// then its Tailscale ones (from anywhere).
pub fn local_addresses() -> Vec<String> {
    offered_hosts(&interface_addresses())
}

/// The Mac's Tailscale addresses: empty when Tailscale isn't on.
pub fn tailnet_addresses() -> Vec<String> {
    tailnet_hosts(&interface_addresses())
}

impl Remote {
    pub fn new(store: RemoteStore, keys: Box<dyn KeyStore>) -> Self {
        let (bus, hub) = (Arc::new(EventBus::default()), Arc::new(SessionHub::default()));
        let keeper = hub.clone();
        bus.tap(Arc::new(move |ev: &BusEvent| keeper.record(ev)));
        let mut e = [0u8; 8];
        let _ = getrandom::fill(&mut e);
        Self { bus, hub, store: Arc::new(store), keys, running: std::sync::Mutex::new(None), epoch: u64::from_le_bytes(e) & ((1 << 53) - 1), lifecycle: tokio::sync::Mutex::new(()), claude: Default::default(), new_chats: Default::default(), awake: Default::default(), live: Default::default() }
    }

    /// The setting for holding the Mac awake, applied now.
    pub fn set_keep_awake(&self, on: bool) -> Result<(), String> {
        let saved = self.store.set_keep_awake(on);
        self.sync_awake();
        saved
    }

    pub fn view(&self) -> RemoteView {
        let saved = self.store.saved();
        let devices = saved.devices.into_iter().map(|d| DeviceView { id: d.id, name: d.name, paired_at: d.paired_at, last_seen: d.last_seen }).collect();
        RemoteView { enabled: saved.enabled, show_titles: saved.show_titles, rich_notifications: saved.rich_notifications, keep_awake: saved.keep_awake, allow_phone_auto: saved.allow_phone_auto, tailnet: tailnet_addresses(), devices, warning: None, connected: self.connected(), listening: self.is_running(), pairing: self.store.offer_open(now_ms()), live_key: self.live.key_id(), live_last: self.store.live.last.lock().unwrap().clone() }
    }

    /// The view after a change, with why it couldn't be saved when it couldn't.
    pub fn view_after<T>(&self, changed: Result<T, String>) -> RemoteView {
        RemoteView { warning: changed.err(), ..self.view() }
    }

    /// The Mac's Noise key (made and kept the first time it is needed).
    pub fn mac_key(&self) -> Result<secure::Keypair, String> {
        keys::mac_key(self.keys.as_ref())
    }

    /// A new QR code for pairing a phone (any earlier one stops working). Only while Remote control is on.
    pub fn pair(&self, hosts: &[String], mac_name: &str, now: u64) -> Result<PairView, String> {
        if !self.store.saved().enabled {
            return Err("Turn on Remote control first.".into());
        }
        let key = self.mac_key()?;
        let offer = self.store.start_offer(now)?;
        let link = pairing::pairing_link(&key.public, &offer, hosts, port(), mac_name);
        Ok(PairView { svg: pairing::qr_svg(&link)?, link, expires_at: offer.expires_at })
    }

    /// Adds the window: it is sent every event as `ui-event` (see `for_window`).
    pub fn tap_window(&self, emit: impl Fn(SlotEvent) + Send + Sync + 'static) {
        self.bus.tap(Arc::new(move |ev: &BusEvent| {
            if for_window(&ev.event) {
                emit(SlotEvent { slot: ev.slot.clone(), event: ev.event.clone() });
            }
        }));
    }

    pub fn publish(&self, slot: &str, event: UiEvent) -> u64 {
        self.bus.publish(slot, event)
    }
}

/// What the window tells the hub about one of its open chats (see src/lib/remoteChats.ts).
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct WindowChat {
    pub slot: String,
    pub folder: String,
    pub title: String,
    pub asleep: bool,
    pub session_id: Option<String>,
    /// "ask" or "auto" (a window that doesn't say leaves what the hub has).
    #[serde(default)]
    pub permissions: Option<String>,
    /// The id of the preset the chat runs on.
    #[serde(default)]
    pub preset: Option<String>,
    /// The colour of the chat's project in the window's sidebar, "#rrggbb".
    #[serde(default)]
    pub color: Option<String>,
    /// "chat", "steps" or "team".
    #[serde(default)]
    pub workflow: Option<String>,
    /// What the chat runs (or ran, if it is asleep and restored) on, when that isn't Claude Code: a name to show ("Codex", an endpoint's).
    /// A phone is shown it, and what is said in the chat, and its title, are never put to Claude for a phone's suggestions. Said by the
    /// window, which knows it for a chat not started yet; None for a chat on Claude.
    #[serde(default)]
    pub provider: Option<String>,
}

impl Remote {
    /// The window says where it found `claude`. Only an absolute path is taken.
    pub fn set_claude(&self, path: &str) -> bool {
        let ok = path.starts_with('/') && !path.contains('\0') && path.len() <= 4096;
        if ok {
            *self.claude.lock().unwrap() = Some(path.to_string());
        }
        ok
    }

    pub fn claude_path(&self) -> Option<String> {
        self.claude.lock().unwrap().clone()
    }

    /// A phone is starting a chat: an id for the window to answer with, and what that answer will be. Used once.
    pub fn expect_new_chat(&self) -> (String, tokio::sync::oneshot::Receiver<Result<String, String>>) {
        let mut raw = [0u8; 12];
        let _ = getrandom::fill(&mut raw);
        let id: String = raw.iter().map(|b| format!("{b:02x}")).collect();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.new_chats.lock().unwrap().insert(id.clone(), tx);
        (id, rx)
    }

    /// The window's answer to a started chat: the slot it made, or why not. False for an id nobody waits for (unknown,
    /// already answered, or given up on), which does nothing.
    pub fn new_chat_done(&self, id: &str, result: Result<String, String>) -> bool {
        self.new_chats.lock().unwrap().remove(id).is_some_and(|tx| tx.send(result).is_ok())
    }

    /// Stops waiting for the window's answer (it took too long).
    pub fn forget_new_chat(&self, id: &str) {
        self.new_chats.lock().unwrap().remove(id);
    }

    /// Takes in what the window knows of its open chats: the titles it shows, and which are asleep.
    pub fn window_chats(&self, chats: &[WindowChat]) {
        for c in chats {
            if let Some(p) = c.permissions.as_deref() {
                self.hub.controls(&c.slot, p, c.preset.as_deref());
            }
            self.hub.colored(&c.slot, c.color.as_deref());
            if let Some(w) = c.workflow.as_deref() {
                self.hub.flow(&c.slot, w);
            }
            if c.asleep {
                self.hub.asleep(&c.slot, &c.folder, Some(c.title.clone()), c.session_id.clone());
            } else {
                self.hub.titled(&c.slot, &c.title);
                // The window woke it (or it never slept): the hub hears no start from claude until its first message.
                self.hub.awake(&c.slot);
                // An awake chat the window resumed from History: claude names its session only with its first message, so
                // without this the chat's transcript can't be found for a phone until then.
                if let Some(id) = c.session_id.as_deref().filter(|id| crate::history::valid_id(id)) {
                    self.hub.session(&c.slot, id);
                }
            }
            // After it is listed (a chat restored and not opened yet has had no start to say what it runs on, and is listed just
            // above): the name a phone shows, and that nothing said in it goes to Claude. A chat on Claude clears the name; the
            // "not for Claude" mark is set here only, and cleared when a chat starts (see `launch`).
            self.hub.set_provider(&c.slot, c.provider.as_deref());
            if c.provider.is_some() {
                self.hub.set_off_claude(&c.slot, true);
            }
        }
    }

    /// Whether chat `slot` can be woken for a client: it is listed, and asleep.
    pub fn wakeable(&self, slot: &str) -> bool {
        self.hub.chat(slot).is_some_and(|c| c.status == hub::ChatStatus::Asleep)
    }
}

/// Whether the window is sent an event: all but the messages it sent itself, which it already shows.
pub fn for_window(event: &UiEvent) -> bool {
    match event {
        UiEvent::UserText { sent_by: Some(by), .. } => by != SENT_BY_DESKTOP,
        // The plan card is the phone's: the window has no use for it.
        UiEvent::Todos { .. } => false,
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A `Running` whose tasks never end by themselves, with a way to ask whether each has been stopped.
    fn running(remote: &Remote) -> (Running, tokio::task::AbortHandle, tokio::task::AbortHandle) {
        let host = fixture::FixtureHost::new(remote, std::time::Duration::ZERO);
        let gateway = gateway::Gateway::new(remote.bus.clone(), remote.hub.clone(), remote.store.clone(), host, secure::generate_keypair().unwrap(), remote.epoch);
        let listener = tokio::spawn(std::future::pending::<()>());
        let notifier = tokio::spawn(std::future::pending::<()>());
        let (l, n) = (listener.abort_handle(), notifier.abort_handle());
        (Running { gateway, listener, bonjour: None, notifier: Some(notifier), pusher: None }, l, n)
    }

    async fn stopped(h: &tokio::task::AbortHandle) -> bool {
        for _ in 0..50 {
            if h.is_finished() {
                return true;
            }
            tokio::task::yield_now().await;
        }
        false
    }

    #[tokio::test]
    async fn turning_remote_control_off_stops_the_notifier_with_the_listener() {
        let remote = Remote::default();
        let (run, listener, notifier) = running(&remote);
        remote.set_running(run);
        assert!(remote.is_running());
        remote.stop();
        assert!(!remote.is_running());
        assert!(stopped(&listener).await, "the listener keeps running");
        assert!(stopped(&notifier).await, "pushes would go on after Remote control was turned off");
    }

    #[tokio::test]
    async fn starting_again_replaces_the_notifier_instead_of_adding_a_second_that_would_push_twice() {
        let remote = Remote::default();
        let (first, first_listener, first_notifier) = running(&remote);
        remote.set_running(first);
        let (second, second_listener, second_notifier) = running(&remote);
        remote.set_running(second);
        assert!(stopped(&first_listener).await && stopped(&first_notifier).await, "the old run's tasks are still going");
        assert!(!second_listener.is_finished() && !second_notifier.is_finished(), "the new run's tasks were stopped");
        remote.stop();
        assert!(stopped(&second_notifier).await);
    }

    #[test]
    fn the_backend_takes_the_path_to_claude_only_when_it_is_a_plain_absolute_one() {
        let remote = Remote::default();
        assert_eq!(remote.claude_path(), None);
        for bad in ["claude", "./claude", "", "/usr/local/bin/cl\0aude", &format!("/{}", "x".repeat(5000))] {
            assert!(!remote.set_claude(bad), "{bad:?}");
        }
        assert_eq!(remote.claude_path(), None);
        assert!(remote.set_claude("/Users/me/.local/bin/claude"));
        assert_eq!(remote.claude_path().as_deref(), Some("/Users/me/.local/bin/claude"));
        assert!(!remote.set_claude("relative/claude"));
        assert_eq!(remote.claude_path().as_deref(), Some("/Users/me/.local/bin/claude"), "a bad one changes nothing");
    }

    #[test]
    fn the_projects_to_start_a_chat_in_are_the_recent_ones_and_those_open_each_once_and_named_by_folder() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let out = known_projects(&s(&["/Users/me/app", "/Users/me/site"]), &s(&["/Users/me/site", "/Users/me/lib", "relative/dir", "/bad\0dir"]));
        assert_eq!(out, vec![("/Users/me/app".to_string(), "app".to_string()), ("/Users/me/site".into(), "site".into()), ("/Users/me/lib".into(), "lib".into())]);
        let many: Vec<String> = (0..30).map(|i| format!("/p/{i}")).collect();
        assert_eq!(known_projects(&many, &[]).len(), 12);
        assert!(known_projects(&[], &[]).is_empty());
    }

    #[test]
    fn two_projects_with_the_same_folder_name_are_told_apart_by_their_parent() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let out = known_projects(&s(&["/Users/me/work/app", "/Users/me/play/app", "/Users/me/site"]), &[]);
        let names: Vec<&str> = out.iter().map(|(_, n)| n.as_str()).collect();
        assert_eq!(names, vec!["work/app", "play/app", "site"]);
        let mut all = names.clone();
        all.sort();
        all.dedup();
        assert_eq!(all.len(), 3, "every name is its own");
        // A name that isn't clashing stays plain, and the root alone keeps its path.
        assert_eq!(known_projects(&s(&["/"]), &[])[0].1, "/");
    }

    #[tokio::test]
    async fn the_windows_answer_to_a_started_chat_reaches_the_one_waiting_once() {
        let remote = Remote::default();
        let (id, rx) = remote.expect_new_chat();
        assert_eq!(id.len(), 24);
        assert!(remote.new_chat_done(&id, Ok("s7".into())));
        assert_eq!(rx.await.unwrap(), Ok("s7".to_string()));
        assert!(!remote.new_chat_done(&id, Ok("s8".into())), "an id is used once");
        assert!(!remote.new_chat_done("nobody", Ok("s9".into())), "an id nobody waits for does nothing");
        let (a, _) = remote.expect_new_chat();
        let (b, _) = remote.expect_new_chat();
        assert_ne!(a, b);
    }

    #[tokio::test]
    async fn an_answer_that_comes_after_giving_up_does_nothing() {
        let remote = Remote::default();
        let (id, rx) = remote.expect_new_chat();
        remote.forget_new_chat(&id);
        assert!(!remote.new_chat_done(&id, Ok("s7".into())));
        assert!(rx.await.is_err(), "the waiter hears nothing");
    }

    fn nic(name: &str, ip: &str) -> (String, std::net::Ipv4Addr) {
        (name.to_string(), ip.parse().unwrap())
    }

    #[test]
    fn a_phone_is_offered_the_wifi_and_cable_addresses_not_the_bridges_and_tunnels() {
        let offered = offered_hosts(&[nic("bridge100", "192.168.139.3"), nic("en0", "192.168.68.107"), nic("utun3", "10.8.0.2"), nic("vmnet8", "172.16.5.1"), nic("en5", "10.0.0.9"), nic("docker0", "172.17.0.1"), nic("awdl0", "169.254.1.1")]);
        assert_eq!(offered, vec!["192.168.68.107", "10.0.0.9"]);
    }

    #[test]
    fn linux_names_count_and_public_or_repeated_addresses_do_not() {
        let offered = offered_hosts(&[nic("wlp3s0", "192.168.1.5"), nic("eth0", "192.168.1.5"), nic("enp2s0", "8.8.8.8")]);
        assert_eq!(offered, vec!["192.168.1.5"]);
        assert!(offered_hosts(&[nic("lo", "127.0.0.1"), nic("endpoint", "192.168.1.9")]).is_empty());
    }

    #[test]
    fn the_tailscale_address_is_offered_after_the_local_ones_so_a_phone_away_from_home_can_dial_it() {
        let offered = offered_hosts(&[nic("utun4", "100.101.102.103"), nic("en0", "192.168.68.107"), nic("utun3", "10.8.0.2")]);
        assert_eq!(offered, vec!["192.168.68.107", "100.101.102.103"], "local first, the other VPN's address left out");
        assert_eq!(tailnet_hosts(&[nic("utun4", "100.101.102.103"), nic("tailscale0", "100.64.0.9")]), vec!["100.101.102.103", "100.64.0.9"]);
        assert_eq!(offered_hosts(&[nic("utun4", "100.101.102.103"), nic("utun5", "100.101.102.103")]), vec!["100.101.102.103"], "once");
    }

    #[test]
    fn only_tailscales_range_on_a_tunnel_counts_not_a_hotspots_shared_address_or_a_public_one() {
        assert!(is_tailnet_address("100.64.0.1".parse().unwrap()) && is_tailnet_address("100.127.255.254".parse().unwrap()));
        assert!(!is_tailnet_address("100.63.255.255".parse().unwrap()) && !is_tailnet_address("100.128.0.1".parse().unwrap()) && !is_tailnet_address("10.0.0.1".parse().unwrap()));
        // A carrier's shared address on the Wi-Fi isn't the tailnet's, even in the same range.
        assert!(tailnet_hosts(&[nic("en0", "100.72.1.1")]).is_empty());
        assert!(tailnet_hosts(&[nic("utun2", "10.8.0.2"), nic("utun3", "8.8.8.8")]).is_empty());
    }

    /// A `Remote` whose keep-awake hold is a fake that counts how often one was started, not a `caffeinate`.
    fn remote_with_fake_hold() -> (Remote, Arc<std::sync::atomic::AtomicUsize>) {
        use crate::awake::{Awake, Hold};
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct Fake;
        impl Hold for Fake {
            fn alive(&mut self) -> bool {
                true
            }
        }
        let started = Arc::new(AtomicUsize::new(0));
        let counted = started.clone();
        let awake = Awake::new(Box::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            Some(Box::new(Fake) as Box<dyn Hold>)
        }));
        (Remote { awake, ..Remote::default() }, started)
    }

    #[tokio::test]
    async fn keeping_the_mac_awake_holds_exactly_while_remote_control_is_on_and_the_setting_is() {
        use std::sync::atomic::Ordering;
        let (remote, started) = remote_with_fake_hold();
        remote.set_keep_awake(true).unwrap();
        assert!(!remote.awake.holding(), "nothing is listening yet, so there's nothing to stay awake for");
        assert_eq!(started.load(Ordering::SeqCst), 0);
        let (run, ..) = running(&remote);
        remote.set_running(run);
        assert!(remote.awake.holding(), "listening for phones with the setting on");
        remote.set_keep_awake(false).unwrap();
        assert!(!remote.awake.holding(), "the setting turned off lets the Mac sleep");
        remote.set_keep_awake(true).unwrap();
        assert!(remote.awake.holding());
        remote.stop();
        assert!(!remote.awake.holding(), "Remote control turned off lets the Mac sleep");
        assert_eq!(started.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn without_the_setting_listening_for_phones_doesnt_hold_the_mac_awake() {
        let (remote, started) = remote_with_fake_hold();
        let (run, ..) = running(&remote);
        remote.set_running(run);
        assert!(!remote.awake.holding(), "the Mac sleeps on its usual schedule unless asked to stay awake");
        assert_eq!(started.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    fn user(by: Option<&str>) -> UiEvent {
        UiEvent::UserText { text: "hi".into(), at: None, sent_by: by.map(str::to_string), images: 0 }
    }

    #[test]
    fn the_window_gets_every_event_but_its_own_messages_and_the_hub_keeps_them_all() {
        let remote = Remote::default();
        let window: Arc<Mutex<Vec<UiEvent>>> = Arc::default();
        let w = window.clone();
        remote.tap_window(move |ev| w.lock().unwrap().push(ev.event));
        remote.publish("a", user(Some(SENT_BY_DESKTOP)));
        remote.publish("a", user(Some("phone-1")));
        remote.publish("a", user(None));
        assert_eq!(*window.lock().unwrap(), vec![user(Some("phone-1")), user(None)]);
        let Some(hub::Since::Events(kept)) = remote.hub.since("a", 0) else { panic!() };
        assert_eq!(kept.len(), 3);
    }

    #[test]
    fn the_window_titles_its_chats_and_lists_the_asleep_ones_which_can_then_be_woken() {
        let remote = Remote::default();
        remote.hub.opened("a", "/p");
        let chat = |slot: &str, asleep| WindowChat { slot: slot.into(), folder: "/p".into(), title: format!("Chat {slot}"), asleep, session_id: Some(format!("s-{slot}")), permissions: None, preset: None, color: None, workflow: None, provider: None };
        remote.window_chats(&[chat("a", false), chat("b", true)]);
        assert_eq!(remote.hub.chat("a").unwrap().title.as_deref(), Some("Chat a"));
        let b = remote.hub.chat("b").unwrap();
        assert_eq!((b.status, b.session_id.as_deref()), (hub::ChatStatus::Asleep, Some("s-b")));
        assert!(remote.wakeable("b"));
        assert!(!remote.wakeable("a"), "an awake chat isn't woken");
        // The window wakes b (its claude starts again, with no word from claude until it has a message): b is awake here too.
        remote.window_chats(&[chat("a", false), chat("b", false)]);
        assert_eq!(remote.hub.chat("b").unwrap().status, hub::ChatStatus::Idle);
        assert!(!remote.wakeable("b"), "a chat that was woken isn't woken again");
        // And it can go to sleep again.
        remote.window_chats(&[chat("a", false), chat("b", true)]);
        assert!(remote.wakeable("b"));
        assert!(!remote.wakeable("nope"), "nor one that isn't listed");
        // A title for a chat the hub doesn't list doesn't list it.
        remote.window_chats(&[chat("c", false)]);
        assert!(remote.hub.chat("c").is_none());
    }

    #[test]
    fn a_dev_run_may_listen_on_a_port_of_its_own_and_anything_else_is_the_usual_one() {
        assert_eq!(port_from(None), PORT);
        assert_eq!(port_from(Some("47124")), 47124);
        assert_eq!(port_from(Some(" 50000 ")), 50000);
        for bad in ["", "abc", "80", "0", "1023", "70000", "-1"] {
            assert_eq!(port_from(Some(bad)), PORT, "{bad:?}");
        }
    }

    #[test]
    fn the_window_says_which_workflow_each_chat_is_on() {
        let remote = Remote::default();
        remote.hub.opened("a", "/p");
        let chat = |workflow: Option<&str>| WindowChat { slot: "a".into(), folder: "/p".into(), title: "T".into(), asleep: false, session_id: None, permissions: None, preset: None, color: None, workflow: workflow.map(String::from), provider: None };
        remote.window_chats(&[chat(Some("steps"))]);
        assert_eq!(remote.hub.chat("a").unwrap().workflow.as_deref(), Some("steps"));
        remote.window_chats(&[chat(None)]);
        assert_eq!(remote.hub.chat("a").unwrap().workflow.as_deref(), Some("steps"), "a window that doesn't say leaves it");
    }

    #[test]
    fn the_window_says_the_colour_of_each_chats_project() {
        let remote = Remote::default();
        remote.hub.opened("a", "/p");
        remote.hub.asleep("b", "/p", None, None);
        let chat = |slot: &str, asleep: bool, color: Option<&str>| WindowChat { slot: slot.into(), folder: "/p".into(), title: "T".into(), asleep, session_id: None, permissions: None, preset: None, color: color.map(String::from), workflow: None, provider: None };
        remote.window_chats(&[chat("a", false, Some("#c2255c")), chat("b", true, Some("#0f8a7e"))]);
        assert_eq!(remote.hub.chat("a").unwrap().color.as_deref(), Some("#c2255c"));
        assert_eq!(remote.hub.chat("b").unwrap().color.as_deref(), Some("#0f8a7e"), "an asleep chat's too");
    }

    #[test]
    fn the_window_says_which_mode_and_preset_each_chat_runs_on() {
        let remote = Remote::default();
        remote.hub.opened("a", "/p");
        remote.hub.opened("b", "/p");
        let chat = |slot: &str, permissions: Option<&str>, preset: Option<&str>| WindowChat { slot: slot.into(), folder: "/p".into(), title: "T".into(), asleep: false, session_id: None, permissions: permissions.map(String::from), preset: preset.map(String::from), color: None, workflow: None, provider: None };
        remote.window_chats(&[chat("a", Some("auto"), Some("max")), chat("b", None, None)]);
        let (a, b) = (remote.hub.chat("a").unwrap(), remote.hub.chat("b").unwrap());
        assert_eq!((a.permissions.as_deref(), a.preset.as_deref()), (Some("auto"), Some("max")));
        assert_eq!((b.permissions, b.preset), (None, None), "a window that doesn't say leaves it unsaid");
    }

    #[test]
    fn an_awake_chat_resumed_from_history_gets_its_session_from_the_window_so_its_transcript_can_be_found() {
        let remote = Remote::default();
        // The chat is listed (its claude starts) but hasn't said anything: claude names its session only with its first message.
        remote.hub.opened("a", "/p");
        assert_eq!(remote.hub.chat("a").unwrap().session_id, None);
        let chat = |id: Option<&str>| WindowChat { slot: "a".into(), folder: "/p".into(), title: "Old chat".into(), asleep: false, session_id: id.map(String::from), permissions: None, preset: None, color: None, workflow: None, provider: None };
        remote.window_chats(&[chat(Some("0a1b2c3d-1111-2222-3333-444455556666"))]);
        let a = remote.hub.chat("a").unwrap();
        assert_eq!((a.status, a.session_id.as_deref()), (hub::ChatStatus::Idle, Some("0a1b2c3d-1111-2222-3333-444455556666")), "it is still awake, and now has its session");
        // The window not knowing (a new chat) takes nothing away.
        remote.window_chats(&[chat(None)]);
        assert_eq!(remote.hub.chat("a").unwrap().session_id.as_deref(), Some("0a1b2c3d-1111-2222-3333-444455556666"));
    }

    #[test]
    fn the_window_only_fills_a_gap_in_the_session_and_never_with_a_name_that_is_not_one() {
        let remote = Remote::default();
        remote.hub.opened("a", "/p");
        let chat = |id: &str| WindowChat { slot: "a".into(), folder: "/p".into(), title: "T".into(), asleep: false, session_id: Some(id.into()), permissions: None, preset: None, color: None, workflow: None, provider: None };
        // Not a session id (a path, or something with slashes in it): ignored.
        remote.window_chats(&[chat("../../etc/passwd")]);
        assert_eq!(remote.hub.chat("a").unwrap().session_id, None);
        // Claude's own word stands once it has come.
        let started = crate::ui_event::UiEvent::SessionStarted { session_id: "aaaa-1111".into(), model: String::new(), cwd: "/p".into(), permission_mode: String::new(), claude_version: String::new() };
        remote.hub.record(&bus::BusEvent { slot: "a".into(), seq: 1, event: started });
        remote.window_chats(&[chat("bbbb-2222")]);
        assert_eq!(remote.hub.chat("a").unwrap().session_id.as_deref(), Some("aaaa-1111"));
    }

    #[test]
    fn a_qr_code_is_offered_only_while_remote_control_is_on_and_the_macs_key_stays_the_same() {
        let remote = Remote::default();
        assert!(remote.pair(&[], "Mac", 0).is_err());
        remote.store.set_enabled(true).unwrap();
        let first = remote.pair(&["192.168.1.2".into()], "Mac", 1000).unwrap();
        assert!(first.svg.contains("<svg"));
        assert!(first.link.starts_with("lantern://pair?v=1&k=") && first.link.contains("&h=192.168.1.2&"));
        assert_eq!(first.expires_at, 1000 + pairing::OFFER_TTL_MS);
        assert_eq!(remote.mac_key().unwrap(), remote.mac_key().unwrap());
        assert!(remote.store.offer_open(1001));
    }

    #[test]
    fn settings_list_devices_without_their_keys_or_push_tokens() {
        let remote = Remote::default();
        let d = remote.store.add_device(&[5u8; 32], "Pixel", 3).unwrap();
        remote.store.set_push_token(&d.id, "ExponentPushToken[x]").unwrap();
        let shown = serde_json::to_string(&remote.view()).unwrap();
        assert!(shown.contains("Pixel") && !shown.contains(&d.key) && !shown.contains("ExponentPushToken"));
    }

    #[test]
    fn the_hub_has_an_event_before_a_subscriber_hears_of_it() {
        let remote = Remote::default();
        let mut rx = remote.bus.subscribe();
        remote.publish("a", user(None));
        let ev = rx.try_recv().unwrap();
        assert_eq!(remote.hub.chat("a").unwrap().last_seq, ev.seq);
    }
}
