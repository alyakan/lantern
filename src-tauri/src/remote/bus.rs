//! The one place every chat's events leave from. Each event gets the next sequence number of its chat, then goes to the
//! taps (the window, the session hub) in that order, then to whoever subscribed (a paired phone's connection). A tap runs
//! while the chat's numbering is held, so every tap sees a chat's events in the order of their numbers.

use crate::ui_event::UiEvent;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

/// An event of chat `slot`, numbered from 1 within its chat.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BusEvent {
    pub slot: String,
    pub seq: u64,
    pub event: UiEvent,
}

/// Something that sees every event as it is numbered (the window, the session hub).
pub type Tap = Arc<dyn Fn(&BusEvent) + Send + Sync>;

/// How many events a subscriber may fall behind before it is told it lagged (and catches up from the hub instead).
const BACKLOG: usize = 4096;

pub struct EventBus {
    /// Each chat's last number. Held while the taps run and the event is sent, so numbers and order agree.
    seqs: Mutex<HashMap<String, u64>>,
    taps: Mutex<Vec<Tap>>,
    tx: broadcast::Sender<Arc<BusEvent>>,
}

impl Default for EventBus {
    fn default() -> Self {
        Self { seqs: Mutex::default(), taps: Mutex::default(), tx: broadcast::channel(BACKLOG).0 }
    }
}

impl EventBus {
    /// Adds a tap: it sees every event published from now on.
    pub fn tap(&self, tap: Tap) {
        self.taps.lock().unwrap().push(tap);
    }

    /// Every event published from now on. A receiver that falls more than BACKLOG behind gets `Lagged` and should start
    /// again from the hub.
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<BusEvent>> {
        self.tx.subscribe()
    }

    /// Numbers the event within its chat and passes it on; returns its number.
    pub fn publish(&self, slot: &str, event: UiEvent) -> u64 {
        let mut seqs = self.seqs.lock().unwrap();
        let seq = seqs.entry(slot.to_string()).or_insert(0);
        *seq += 1;
        let ev = Arc::new(BusEvent { slot: slot.to_string(), seq: *seq, event });
        let taps = self.taps.lock().unwrap().clone();
        for tap in &taps {
            tap(&ev);
        }
        // Nobody subscribed is no error: the taps have it.
        let _ = self.tx.send(ev.clone());
        ev.seq
    }

    /// The chat's last number (0: none yet).
    pub fn last_seq(&self, slot: &str) -> u64 {
        self.seqs.lock().unwrap().get(slot).copied().unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(t: &str) -> UiEvent {
        UiEvent::AssistantText { parent: None, block_id: "b".into(), text: t.into() }
    }

    #[test]
    fn each_chat_is_numbered_from_one_on_its_own() {
        let bus = EventBus::default();
        assert_eq!(bus.publish("a", text("1")), 1);
        assert_eq!(bus.publish("a", text("2")), 2);
        assert_eq!(bus.publish("b", text("1")), 1);
        assert_eq!((bus.last_seq("a"), bus.last_seq("b"), bus.last_seq("c")), (2, 1, 0));
    }

    #[test]
    fn taps_see_every_event_in_order_and_subscribers_get_them_too() {
        let bus = EventBus::default();
        let seen: Arc<Mutex<Vec<(String, u64)>>> = Arc::default();
        let s = seen.clone();
        bus.tap(Arc::new(move |e: &BusEvent| s.lock().unwrap().push((e.slot.clone(), e.seq))));
        let mut rx = bus.subscribe();
        bus.publish("a", text("x"));
        bus.publish("b", text("y"));
        bus.publish("a", text("z"));
        assert_eq!(*seen.lock().unwrap(), vec![("a".into(), 1), ("b".into(), 1), ("a".into(), 2)]);
        let got: Vec<u64> = (0..3).map(|_| rx.try_recv().unwrap().seq).collect();
        assert_eq!(got, vec![1, 1, 2]);
    }

    #[test]
    fn numbers_stay_in_order_per_chat_when_many_threads_publish_at_once() {
        let bus = Arc::new(EventBus::default());
        let seen: Arc<Mutex<Vec<u64>>> = Arc::default();
        let s = seen.clone();
        bus.tap(Arc::new(move |e: &BusEvent| s.lock().unwrap().push(e.seq)));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let bus = bus.clone();
                std::thread::spawn(move || {
                    for _ in 0..250 {
                        bus.publish("a", text("x"));
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2000);
        assert!(seen.windows(2).all(|w| w[1] == w[0] + 1), "the taps saw the numbers out of order");
    }

    #[test]
    fn a_subscriber_that_falls_too_far_behind_is_told_it_lagged() {
        let bus = EventBus::default();
        let mut rx = bus.subscribe();
        for _ in 0..BACKLOG + 10 {
            bus.publish("a", text("x"));
        }
        assert!(matches!(rx.try_recv(), Err(broadcast::error::TryRecvError::Lagged(_))));
    }
}
