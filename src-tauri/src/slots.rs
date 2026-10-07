//! Several conversations at once. Each slot is one chat in the UI: its own claude process, change tracker and
//! permission bridge, so a chat can keep working in the background while another one is open.

use crate::changes::ChangeTracker;
use crate::permission::bridge::PermissionBridge;
use crate::session::{Session, SessionConfig};
use crate::ui_event::{Sink, UiEvent};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// An event from one slot, as the UI receives it.
#[derive(Debug, Clone, Serialize)]
pub struct SlotEvent {
    pub slot: String,
    pub event: UiEvent,
}

/// A folder, when its files were listed, and the list (paths from the folder).
pub type FileIndex = (std::path::PathBuf, std::time::Instant, Arc<Vec<String>>);

pub struct Slot {
    /// Its own lock, so starting or stopping one chat never waits on another.
    pub session: tokio::sync::Mutex<Option<Session>>,
    pub config: Mutex<Option<SessionConfig>>,
    pub changes: Arc<Mutex<ChangeTracker>>,
    pub bridge: Arc<PermissionBridge>,
    /// The folder's file list for search, and when it was made: kept briefly so typing doesn't re-walk the folder.
    pub file_index: Mutex<Option<FileIndex>>,
    /// Bumped by every text search, so an older one still running stops.
    pub text_search: std::sync::atomic::AtomicU64,
    /// Commands the user runs from the chat box.
    pub shells: Arc<crate::shell::Shells>,
}

/// Slot ids come from the UI and end up in a socket path (macOS allows ~104 bytes), so they're short and plain.
pub fn valid_slot(id: &str) -> bool {
    (1..=16).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

#[derive(Default)]
pub struct Slots {
    slots: Mutex<HashMap<String, Arc<Slot>>>,
}

impl Slots {
    /// The slot with this id, created (with its permission bridge) the first time it's asked for.
    /// `emit` sends a slot-tagged event to the UI.
    pub fn get_or_create(&self, id: &str, socket_dir: &std::path::Path, emit: impl Fn(SlotEvent) + Send + Sync + 'static) -> Result<Arc<Slot>, String> {
        if !valid_slot(id) {
            return Err(format!("{id:?} is not a slot id."));
        }
        let mut slots = self.slots.lock().unwrap();
        if let Some(s) = slots.get(id) {
            return Ok(s.clone());
        }
        let socket = socket_dir.join(format!("lantern-{}-{id}.sock", std::process::id()));
        let bridge = PermissionBridge::start(socket, tagged(id, emit)).map_err(|e| e.to_string())?;
        let slot = Arc::new(Slot { session: tokio::sync::Mutex::new(None), config: Mutex::new(None), changes: Arc::default(), bridge, file_index: Mutex::new(None), text_search: Default::default(), shells: Arc::default() });
        slots.insert(id.to_string(), slot.clone());
        Ok(slot)
    }

    pub fn get(&self, id: &str) -> Result<Arc<Slot>, String> {
        self.slots.lock().unwrap().get(id).cloned().ok_or_else(|| "That chat is no longer open.".into())
    }

    /// Takes the slot out; the caller stops its session.
    pub fn remove(&self, id: &str) -> Option<Arc<Slot>> {
        self.slots.lock().unwrap().remove(id)
    }

    pub fn drain(&self) -> Vec<Arc<Slot>> {
        self.slots.lock().unwrap().drain().map(|(_, s)| s).collect()
    }
}

/// A sink for one slot's events.
pub fn tagged(id: &str, emit: impl Fn(SlotEvent) + Send + Sync + 'static) -> Sink {
    let id = id.to_string();
    Arc::new(move |event| emit(SlotEvent { slot: id.clone(), event }))
}

impl Slot {
    /// Stops the session (denying pending prompts) and removes the bridge's socket.
    pub async fn shut_down(&self) {
        self.bridge.cancel_all();
        self.shells.stop_all();
        if let Some(s) = self.session.lock().await.take() {
            s.stop().await;
        }
        let _ = std::fs::remove_file(&self.bridge.socket_path);
    }

    pub fn folder(&self) -> Result<PathBuf, String> {
        self.config.lock().unwrap().as_ref().map(|c| c.folder.clone()).ok_or_else(|| "No folder is open".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    #[test]
    fn slot_ids_are_short_and_plain() {
        assert!(valid_slot("s1"));
        assert!(valid_slot("s-12"));
        assert!(!valid_slot(""));
        assert!(!valid_slot("../x"));
        assert!(!valid_slot("a b"));
        assert!(!valid_slot(&"s".repeat(17)));
    }

    #[tokio::test]
    async fn slots_are_created_once_tag_their_events_and_can_be_removed() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let slots = Slots::default();
        let emit = move |e: SlotEvent| {
            let _ = tx.send(e);
        };
        let a = slots.get_or_create("s1", dir.path(), emit.clone()).unwrap();
        let again = slots.get_or_create("s1", dir.path(), emit.clone()).unwrap();
        assert!(Arc::ptr_eq(&a, &again));
        let b = slots.get_or_create("s2", dir.path(), emit).unwrap();
        assert_ne!(a.bridge.socket_path, b.bridge.socket_path, "each chat has its own permission socket");
        assert!(slots.get_or_create("../bad", dir.path(), |_| {}).is_err());

        // A permission request on s1's socket reaches the UI tagged with s1.
        let socket = a.bridge.socket_path.display().to_string();
        let req = crate::permission::protocol::BridgeRequest { tool_name: "Bash".into(), input: serde_json::json!({}), tool_use_id: None };
        let helper = tokio::task::spawn_blocking(move || crate::permission::helper::ask_bridge(Some(&socket), &req));
        let ev = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await.unwrap().unwrap();
        assert_eq!(ev.slot, "s1");
        a.shut_down().await;
        assert!(!helper.await.unwrap().allow, "closing a chat denies its pending prompts");
        assert!(!a.bridge.socket_path.exists());

        assert!(slots.remove("s1").is_some());
        assert!(slots.get("s1").is_err());
        assert_eq!(slots.drain().len(), 1);
    }
}
