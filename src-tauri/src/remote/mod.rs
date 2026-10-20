//! Lantern's remote side: the event bus every chat's events leave from, the session hub that keeps what a client
//! joining late needs, and (later) what lets a paired phone in (see docs/MOBILE.md).

pub mod bus;
pub mod hub;

use crate::slots::SlotEvent;
use crate::ui_event::UiEvent;
use bus::{BusEvent, EventBus};
use hub::SessionHub;
use std::sync::Arc;

/// Who sent a message typed in Lantern's own window (UserText's `sent_by`).
pub const SENT_BY_DESKTOP: &str = "desktop";

/// The bus and the hub, joined: everything published is kept by the hub before any subscriber sees it.
pub struct Remote {
    pub bus: Arc<EventBus>,
    pub hub: Arc<SessionHub>,
}

impl Default for Remote {
    fn default() -> Self {
        let (bus, hub) = (Arc::new(EventBus::default()), Arc::new(SessionHub::default()));
        let keeper = hub.clone();
        bus.tap(Arc::new(move |ev: &BusEvent| keeper.record(ev)));
        Self { bus, hub }
    }
}

impl Remote {
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
    fn the_hub_has_an_event_before_a_subscriber_hears_of_it() {
        let remote = Remote::default();
        let mut rx = remote.bus.subscribe();
        remote.publish("a", user(None));
        let ev = rx.try_recv().unwrap();
        assert_eq!(remote.hub.chat("a").unwrap().last_seq, ev.seq);
    }
}
