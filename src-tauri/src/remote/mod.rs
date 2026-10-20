//! Lantern's remote side: the event bus every chat's events leave from, the session hub that keeps what a client
//! joining late needs, and what lets a paired phone in: pairing, the secure channel and the protocol (see
//! docs/MOBILE.md).

pub mod bus;
pub mod hub;
pub mod keys;
pub mod pairing;
pub mod protocol;
pub mod secure;

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

/// The bus and the hub, joined (everything published is kept by the hub before any subscriber sees it), with Remote
/// control's settings, paired devices and the Mac's key.
pub struct Remote {
    pub bus: Arc<EventBus>,
    pub hub: Arc<SessionHub>,
    pub store: RemoteStore,
    keys: Box<dyn KeyStore>,
}

impl Default for Remote {
    fn default() -> Self {
        Self::new(RemoteStore::load(None), Box::new(keys::Memory::default()))
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
    pub devices: Vec<DeviceView>,
}

/// The QR code a phone pairs with, and when it stops working.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PairView {
    pub svg: String,
    pub expires_at: u64,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// The Mac's addresses on its local networks (IPv4, not loopback): where a phone dials when Bonjour finds nothing.
pub fn local_addresses() -> Vec<String> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback())
        .filter_map(|i| match i.ip() {
            std::net::IpAddr::V4(v4) if v4.is_private() => Some(v4.to_string()),
            _ => None,
        })
        .collect()
}

impl Remote {
    pub fn new(store: RemoteStore, keys: Box<dyn KeyStore>) -> Self {
        let (bus, hub) = (Arc::new(EventBus::default()), Arc::new(SessionHub::default()));
        let keeper = hub.clone();
        bus.tap(Arc::new(move |ev: &BusEvent| keeper.record(ev)));
        Self { bus, hub, store, keys }
    }

    pub fn view(&self) -> RemoteView {
        let saved = self.store.saved();
        let devices = saved.devices.into_iter().map(|d| DeviceView { id: d.id, name: d.name, paired_at: d.paired_at, last_seen: d.last_seen }).collect();
        RemoteView { enabled: saved.enabled, show_titles: saved.show_titles, devices }
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
        let link = pairing::pairing_link(&key.public, &offer, hosts, PORT, mac_name);
        Ok(PairView { svg: pairing::qr_svg(&link)?, expires_at: offer.expires_at })
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
}

impl Remote {
    /// Takes in what the window knows of its open chats: the titles it shows, and which are asleep.
    pub fn window_chats(&self, chats: &[WindowChat]) {
        for c in chats {
            if c.asleep {
                self.hub.asleep(&c.slot, &c.folder, Some(c.title.clone()), c.session_id.clone());
            } else {
                self.hub.titled(&c.slot, &c.title);
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
    !matches!(event, UiEvent::UserText { sent_by: Some(by), .. } if by == SENT_BY_DESKTOP)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn user(by: Option<&str>) -> UiEvent {
        UiEvent::UserText { text: "hi".into(), at: None, sent_by: by.map(str::to_string) }
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
        let chat = |slot: &str, asleep| WindowChat { slot: slot.into(), folder: "/p".into(), title: format!("Chat {slot}"), asleep, session_id: Some(format!("s-{slot}")) };
        remote.window_chats(&[chat("a", false), chat("b", true)]);
        assert_eq!(remote.hub.chat("a").unwrap().title.as_deref(), Some("Chat a"));
        let b = remote.hub.chat("b").unwrap();
        assert_eq!((b.status, b.session_id.as_deref()), (hub::ChatStatus::Asleep, Some("s-b")));
        assert!(remote.wakeable("b"));
        assert!(!remote.wakeable("a"), "an awake chat isn't woken");
        assert!(!remote.wakeable("nope"), "nor one that isn't listed");
        // A title for a chat the hub doesn't list doesn't list it.
        remote.window_chats(&[chat("c", false)]);
        assert!(remote.hub.chat("c").is_none());
    }

    #[test]
    fn a_qr_code_is_offered_only_while_remote_control_is_on_and_the_macs_key_stays_the_same() {
        let remote = Remote::default();
        assert!(remote.pair(&[], "Mac", 0).is_err());
        remote.store.set_enabled(true);
        let first = remote.pair(&["192.168.1.2".into()], "Mac", 1000).unwrap();
        assert!(first.svg.contains("<svg"));
        assert_eq!(first.expires_at, 1000 + pairing::OFFER_TTL_MS);
        assert_eq!(remote.mac_key().unwrap(), remote.mac_key().unwrap());
        assert!(remote.store.offer_open(1001));
    }

    #[test]
    fn settings_list_devices_without_their_keys_or_push_tokens() {
        let remote = Remote::default();
        let d = remote.store.add_device(&[5u8; 32], "Pixel", 3);
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
