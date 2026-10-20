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
use std::collections::HashMap;
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

/// What the gateway asks of the app. `by` is who asked: the phone's device id (with its message id for a send).
pub trait Host: Send + Sync + 'static {
    fn send(&self, slot: String, text: String, by: String) -> BoxFut<Result<(), String>>;
    fn interrupt(&self, slot: String) -> BoxFut<Result<(), String>>;
    fn pending(&self, slot: &str) -> Vec<Pending>;
    fn answer(&self, slot: &str, request_id: &str, allow: bool, message: Option<String>, updated_input: Option<serde_json::Value>, by: &str) -> Result<(), String>;
    fn wake(&self, slot: &str) -> Result<(), String>;
    /// A file the chat changed, as a unified diff from the chat's start; any other file is refused.
    fn diff(&self, slot: String, path: String) -> BoxFut<Result<String, String>>;
    /// The chat's events from its transcript (what a phone catching up from the start is shown).
    fn history(&self, slot: String) -> BoxFut<Result<Vec<UiEvent>, String>>;
    fn mac_name(&self) -> String;
    fn app_version(&self) -> String;
}

struct Conn {
    device: String,
    kill: watch::Sender<bool>,
}

/// Called whenever a phone connects or goes (the window shows who is connected).
pub type OnChange = Arc<dyn Fn() + Send + Sync>;

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
    pub fn new(bus: Arc<EventBus>, hub: Arc<SessionHub>, store: Arc<RemoteStore>, host: Arc<dyn Host>, mac: Keypair) -> Arc<Self> {
        Arc::new(Self { bus, hub, store, host, mac, conns: Mutex::default(), handshakes: Arc::new(Semaphore::new(HANDSHAKES_AT_ONCE)), next: AtomicU64::new(1), now: super::now_ms, on_change: Mutex::new(None) })
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

    /// Closes every connection (Remote control was turned off).
    pub fn disconnect_all(&self) {
        for c in self.conns.lock().unwrap().values() {
            let _ = c.kill.send(true);
        }
    }

    async fn serve(self: Arc<Self>, mut link: Link) -> Result<(), Refused> {
        let permit = self.handshakes.clone().try_acquire_owned().map_err(|_| Refused::Busy)?;
        let (device, mut channel) = tokio::time::timeout(HANDSHAKE_WAIT, self.come_in(&mut link)).await.map_err(|_| Refused::TooSlow)??;
        drop(permit);
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (kill, mut killed) = watch::channel(false);
        self.conns.lock().unwrap().insert(id, Conn { device: device.clone(), kill });
        // Removed in the meantime (between its key being checked and now): it doesn't stay.
        if self.store.saved().devices.iter().all(|d| d.id != device) {
            self.conns.lock().unwrap().remove(&id);
            return Err(Refused::NotPaired);
        }
        self.store.seen(&device, (self.now)());
        self.changed();
        let mut session = Session { gw: &self, device: device.clone(), subscribed: HashMap::new(), last_chats: Vec::new() };
        let _ = session.run(&mut link, &mut channel, &mut killed).await;
        self.conns.lock().unwrap().remove(&id);
        self.store.seen(&device, (self.now)());
        self.changed();
        Ok(())
    }

    /// The handshake, then the phone's hello: who it is, once it has proved it.
    async fn come_in(&self, link: &mut Link) -> Result<(String, Channel), Refused> {
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
            let secret = self.store.take_offer((self.now)()).ok_or(Refused::NoCode)?;
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
        let ClientMessage::Hello { protocol: theirs, device_name, .. } = hello else { return Err(Refused::Protocol("no hello".into())) };
        let welcome = ServerMessage::Welcome { protocol: PROTOCOL_VERSION, app_version: self.host.app_version(), mac_name: self.host.mac_name() };
        send_message(link, &mut channel, &welcome).map_err(Refused::Protocol)?;
        // Told which version this Mac speaks, so the phone can say what to update; it isn't paired or let in.
        if theirs != PROTOCOL_VERSION {
            return Err(Refused::Protocol(format!("protocol {theirs}")));
        }
        let device = match known {
            Some(d) if !pairing => d,
            _ => self.store.add_device(&key, &device_name, (self.now)()).map_err(Refused::Protocol)?,
        };
        Ok((device.id, channel))
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

/// One phone's connection, once it is in.
struct Session<'a> {
    gw: &'a Gateway,
    device: String,
    /// The chats it subscribed to, with the number of the last event it was sent of each.
    subscribed: HashMap<String, u64>,
    last_chats: Vec<RemoteChat>,
}

impl Session<'_> {
    async fn run(&mut self, link: &mut Link, channel: &mut Channel, killed: &mut watch::Receiver<bool>) -> Result<(), String> {
        let mut events = self.gw.bus.subscribe();
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        self.send_chats(link, channel, true)?;
        loop {
            tokio::select! {
                _ = killed.changed() => return Ok(()),
                frame = link.from_peer.recv() => {
                    let Some(frame) = frame else { return Ok(()) };
                    let Some(plain) = channel.open(&frame)? else { continue };
                    let msg: ClientMessage = serde_json::from_slice(&plain).map_err(|e| e.to_string())?;
                    let ClientMessage::Request { id, request } = msg else { continue };
                    let answer = self.handle(link, channel, request).await;
                    let (ok, error) = match answer {
                        Ok(v) => (Some(v), None),
                        Err(e) => (None, Some(e)),
                    };
                    send_message(link, channel, &ServerMessage::Response { id, ok, error })?;
                }
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
                _ = tick.tick() => self.send_chats(link, channel, false)?,
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
        match protocol::to_remote(&ev.event) {
            Some(event) => send_message(link, channel, &ServerMessage::Event { slot: ev.slot.clone(), seq: ev.seq, event }),
            None => Ok(()),
        }
    }

    fn send_chats(&mut self, link: &Link, channel: &mut Channel, always: bool) -> Result<(), String> {
        let chats: Vec<RemoteChat> = self.gw.hub.chats().into_iter().map(RemoteChat::from).collect();
        // Only what a list shows counts as a change, not every new event's number.
        let shown = |c: &[RemoteChat]| c.iter().map(|c| (c.slot.clone(), c.title.clone(), c.status)).collect::<Vec<_>>();
        if always || shown(&chats) != shown(&self.last_chats) {
            send_message(link, channel, &ServerMessage::Chats { chats: chats.clone() })?;
        }
        self.last_chats = chats;
        Ok(())
    }

    /// The chat from its start, in pages: the transcript, then the current turn as far as the hub has it.
    async fn reset(&mut self, link: &Link, channel: &mut Channel, slot: &str) -> Result<(), String> {
        let seq = self.gw.bus.last_seq(slot);
        let mut events: Vec<RemoteEvent> = self.gw.host.history(slot.to_string()).await.unwrap_or_default().iter().filter_map(protocol::to_remote).collect();
        // A turn still going isn't all in the transcript yet: what the hub has of it since its message comes after.
        if self.gw.hub.chat(slot).is_some_and(|c| c.status == super::hub::ChatStatus::Working) {
            if let Some(Since::Events(kept) | Since::TooOld { kept }) = self.gw.hub.since(slot, 0) {
                let start = kept.iter().rposition(|e| matches!(e.event, UiEvent::UserText { .. })).unwrap_or(0);
                events.extend(kept[start..].iter().filter(|e| e.seq <= seq).filter_map(|e| protocol::to_remote(&e.event)));
            }
        }
        for (page, (events, done)) in pages(events).into_iter().enumerate() {
            send_message(link, channel, &ServerMessage::Reset { slot: slot.to_string(), seq, page: page as u32, done, events })?;
        }
        self.subscribed.insert(slot.to_string(), seq);
        Ok(())
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
            Request::Subscribe { slot, after } => {
                self.chat_known(&slot)?;
                match self.gw.hub.since(&slot, after) {
                    Some(Since::Events(events)) if after > 0 => {
                        let last = events.last().map_or(after, |e| e.seq);
                        for e in &events {
                            if let Some(event) = protocol::to_remote(&e.event) {
                                send_message(link, channel, &ServerMessage::Event { slot: slot.clone(), seq: e.seq, event })?;
                            }
                        }
                        self.subscribed.insert(slot, last);
                    }
                    _ => self.reset(link, channel, &slot).await?,
                }
                Ok(serde_json::Value::Null)
            }
            Request::Unsubscribe { slot } => {
                self.subscribed.remove(&slot);
                Ok(serde_json::Value::Null)
            }
            Request::Send { slot, text, client_id } => {
                self.chat_known(&slot)?;
                if text.trim().is_empty() || text.len() > TEXT_MAX {
                    return Err("That message is empty, or too long.".into());
                }
                if client_id.is_empty() || client_id.len() > 64 || !client_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                    return Err("That message has no proper id.".into());
                }
                host.send(slot, text, format!("{}:{client_id}", self.device)).await.map(|()| serde_json::Value::Null)
            }
            Request::Interrupt { slot } => {
                self.chat_known(&slot)?;
                host.interrupt(slot).await.map(|()| serde_json::Value::Null)
            }
            Request::Answer { slot, request_id, allow, message, updated_input } => {
                self.chat_known(&slot)?;
                let asked = host.pending(&slot).into_iter().find(|p| p.request_id == request_id).ok_or("That was answered already, or Claude stopped asking.")?;
                // On deny there is nothing to run, so nothing it carries matters.
                let updated = if allow { answers::checked(&asked.tool_name, &asked.input, updated_input)? } else { None };
                let message = message.map(|m| m.chars().take(10_000).collect());
                host.answer(&slot, &request_id, allow, message, updated, &self.device).map(|()| serde_json::Value::Null)
            }
            Request::Wake { slot } => {
                self.chat_known(&slot)?;
                host.wake(&slot).map(|()| serde_json::Value::Null)
            }
            Request::Diff { slot, path } => {
                self.chat_known(&slot)?;
                host.diff(slot, path).await.map(serde_json::Value::String)
            }
            Request::PushToken { token } => self.gw.store.set_push_token(&self.device, &token).map(|()| serde_json::Value::Null),
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
        pub woken: Mutex<Vec<String>>,
        pub history: Mutex<Vec<UiEvent>>,
    }

    impl Host for FakeHost {
        fn send(&self, slot: String, text: String, by: String) -> BoxFut<Result<(), String>> {
            self.sent.lock().unwrap().push((slot, text, by));
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
        fn diff(&self, _: String, path: String) -> BoxFut<Result<String, String>> {
            Box::pin(async move { if path == "/p/a.rs" { Ok("--- a\n+++ b\n".into()) } else { Err("not changed".into()) } })
        }
        fn history(&self, _: String) -> BoxFut<Result<Vec<UiEvent>, String>> {
            let h = self.history.lock().unwrap().clone();
            Box::pin(async move { Ok(h) })
        }
        fn mac_name(&self) -> String {
            "Test Mac".into()
        }
        fn app_version(&self) -> String {
            "0.0.0".into()
        }
    }

    pub struct Rig {
        pub gw: Arc<Gateway>,
        pub bus: Arc<EventBus>,
        pub hub: Arc<SessionHub>,
        pub store: Arc<RemoteStore>,
        pub host: Arc<FakeHost>,
    }

    pub fn rig() -> Rig {
        let remote = crate::remote::Remote::default();
        let (bus, hub, store) = (remote.bus.clone(), remote.hub.clone(), remote.store.clone());
        store.set_enabled(true).unwrap();
        let host = Arc::new(FakeHost::default());
        let mac = generate_keypair().unwrap();
        let gw = Gateway::new(bus.clone(), hub.clone(), store.clone(), host.clone(), mac);
        Rig { gw, bus, hub, store, host }
    }

    /// A phone: its link, its channel once in, and its own request numbers.
    pub struct Phone {
        pub link: Link,
        pub channel: Channel,
        next: u64,
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
        let mut p = Phone { link: mine, channel, next: 0 };
        p.send(&ClientMessage::Hello { protocol, app_version: "1.0".into(), device_name: "Test phone".into() });
        match p.next().await {
            Some(ServerMessage::Welcome { .. }) => Ok(p),
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
        UiEvent::UserText { text: t.into(), at: None, sent_by: None }
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
        let (ok, err, before) = p.ask(Request::Subscribe { slot: "a".into(), after: 0 }).await;
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
        let (_, _, before) = p.ask(Request::Subscribe { slot: "a".into(), after: 1 }).await;
        let caught: Vec<u64> = before.iter().filter_map(|m| if let ServerMessage::Event { seq, .. } = m { Some(*seq) } else { None }).collect();
        assert_eq!(caught, vec![2], "only what it missed, and only what a phone is sent");
    }

    #[tokio::test]
    async fn only_what_the_protocol_lists_can_be_asked_and_only_of_open_chats() {
        let r = rig();
        r.hub.opened("a", "/p");
        let (_, mut p) = paired(&r).await;
        let (_, err, _) = p.ask(Request::Send { slot: "nope".into(), text: "hi".into(), client_id: "c1".into() }).await;
        assert!(err.unwrap().contains("isn't open"));
        let (_, err, _) = p.ask(Request::Send { slot: "a".into(), text: "  ".into(), client_id: "c1".into() }).await;
        assert!(err.is_some());
        let (_, err, _) = p.ask(Request::Send { slot: "a".into(), text: "hi".into(), client_id: "../x".into() }).await;
        assert!(err.is_some());
        let (_, err, _) = p.ask(Request::Send { slot: "a".into(), text: "ship it".into(), client_id: "m-1".into() }).await;
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
    async fn an_answer_counts_once_and_cant_change_what_runs() {
        let r = rig();
        r.hub.opened("a", "/p");
        *r.host.pending.lock().unwrap() = vec![
            Pending { request_id: "p1".into(), tool_name: "Bash".into(), input: json!({"command": "npm test"}), at: 1 },
            Pending { request_id: "q1".into(), tool_name: answers::QUESTION_TOOL.into(), input: json!({"questions": [{"question": "Which?"}]}), at: 2 },
        ];
        let (_, mut p) = paired(&r).await;
        let (_, err, _) = p.ask(Request::Answer { slot: "a".into(), request_id: "p1".into(), allow: true, message: None, updated_input: Some(json!({"command": "rm -rf ~"})) }).await;
        assert!(err.unwrap().contains("only fill in"), "a phone can't swap the command it approves");
        assert!(r.host.answered.lock().unwrap().is_empty());
        let (_, err, _) = p.ask(Request::Answer { slot: "a".into(), request_id: "p1".into(), allow: true, message: None, updated_input: None }).await;
        assert!(err.is_none());
        let (_, err, _) = p.ask(Request::Answer { slot: "a".into(), request_id: "p1".into(), allow: false, message: None, updated_input: None }).await;
        assert!(err.unwrap().contains("answered already"));
        let answers = json!({"questions": [{"question": "Which?"}], "answers": {"Which?": "Dark"}});
        let (_, err, _) = p.ask(Request::Answer { slot: "a".into(), request_id: "q1".into(), allow: true, message: None, updated_input: Some(answers.clone()) }).await;
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

    /// A phone's side over a real transport link (the Wi-Fi one), as `phone` does over memory.
    async fn phone_over(mut mine: Link, key: &Keypair, secret: [u8; 32]) -> Result<Phone, String> {
        mine.to_peer.send(vec![secure::PAIR]).await.map_err(|e| e.to_string())?;
        let mut hs = Handshake::pair_initiator(key, &secret)?;
        mine.to_peer.send(hs.write()?).await.map_err(|e| e.to_string())?;
        hs.read(&mine.from_peer.recv().await.ok_or("closed")?)?;
        mine.to_peer.send(hs.write()?).await.map_err(|e| e.to_string())?;
        let (_, channel) = hs.finish()?;
        let mut p = Phone { link: mine, channel, next: 0 };
        p.send(&ClientMessage::Hello { protocol: PROTOCOL_VERSION, app_version: "1.0".into(), device_name: "Wi-Fi phone".into() });
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
        p.ask(Request::Subscribe { slot: "a".into(), after: 0 }).await;
        *r.host.pending.lock().unwrap() = vec![Pending { request_id: "p1".into(), tool_name: "Bash".into(), input: json!({"command": "npm test"}), at: 1 }];
        r.bus.publish("a", UiEvent::PermissionRequested { request_id: "p1".into(), tool_name: "Bash".into(), input: json!({"command": "npm test"}) });
        loop {
            if let Some(ServerMessage::Event { event: RemoteEvent::PermissionRequested { request_id, .. }, .. }) = p.next().await {
                assert_eq!(request_id, "p1");
                break;
            }
        }
        let (_, err, _) = p.ask(Request::Answer { slot: "a".into(), request_id: "p1".into(), allow: true, message: None, updated_input: None }).await;
        assert!(err.is_none());
        assert_eq!(r.host.answered.lock().unwrap()[0].0, "p1");
        listener.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_phone_too_slow_to_read_is_dropped_and_catches_up_when_it_comes_back() {
        let r = rig();
        r.hub.opened("a", "/p");
        let (key, mut p) = paired(&r).await;
        p.ask(Request::Subscribe { slot: "a".into(), after: 0 }).await;
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
        let (_, _, before) = p.ask(Request::Subscribe { slot: "a".into(), after: seen }).await;
        let last = before.iter().filter_map(|m| if let ServerMessage::Event { seq, .. } = m { Some(*seq) } else { None }).max();
        assert_eq!(last, Some((crate::remote::transport::OUTBOX * 2) as u64), "and has everything after coming back");
    }

    #[tokio::test]
    async fn once_remote_control_is_off_nothing_listens_and_every_phone_is_gone() {
        let r = rig();
        let remote = crate::remote::Remote::default();
        let door = r.gw.clone();
        let (listener, port) = crate::remote::transport::serve_lan(0, move |link| door.accept(link)).await.unwrap();
        remote.set_running(crate::remote::Running { gateway: r.gw.clone(), listener, bonjour: None });
        let (_, mut p) = paired(&r).await;
        assert!(remote.is_running());
        remote.stop();
        while p.next().await.is_some() {}
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_err(), "the port is closed");
        assert!(!remote.is_running());
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
