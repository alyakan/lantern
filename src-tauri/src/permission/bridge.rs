use super::protocol::{BridgeRequest, BridgeResponse};
use crate::ui_event::{Sink, UiEvent};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::oneshot;

/// Unix-socket server that turns helper requests into UI permission cards.
pub struct PermissionBridge {
    pub socket_path: PathBuf,
    pending: Mutex<HashMap<String, oneshot::Sender<BridgeResponse>>>,
    counter: AtomicU64,
}

impl PermissionBridge {
    pub fn start(socket_path: PathBuf, sink: Sink) -> std::io::Result<Arc<Self>> {
        let _ = std::fs::remove_file(&socket_path);
        let std_listener = std::os::unix::net::UnixListener::bind(&socket_path)?;
        std_listener.set_nonblocking(true)?;
        let bridge = Arc::new(Self { socket_path, pending: Mutex::new(HashMap::new()), counter: AtomicU64::new(0) });
        let b = bridge.clone();
        tauri::async_runtime::spawn(async move {
            let Ok(listener) = UnixListener::from_std(std_listener) else { return };
            while let Ok((stream, _)) = listener.accept().await {
                let (b, sink) = (b.clone(), sink.clone());
                tokio::spawn(async move { b.handle(stream, sink).await });
            }
        });
        Ok(bridge)
    }

    async fn handle(&self, stream: UnixStream, sink: Sink) {
        let (read, mut write) = stream.into_split();
        let mut line = String::new();
        if BufReader::new(read).read_line(&mut line).await.unwrap_or(0) == 0 {
            return;
        }
        let Ok(req) = serde_json::from_str::<BridgeRequest>(&line) else { return };
        let id = format!("perm-{}", self.counter.fetch_add(1, Ordering::SeqCst) + 1);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        sink(UiEvent::PermissionRequested { request_id: id, tool_name: req.tool_name, input: req.input });
        // A dropped sender (cancel_all) closes the connection; the helper then denies.
        if let Ok(resp) = rx.await {
            if let Ok(json) = serde_json::to_string(&resp) {
                let _ = write.write_all(format!("{json}\n").as_bytes()).await;
            }
        }
    }

    /// Returns false if the request is unknown or already answered. `message` goes back to Claude (a deny reason,
    /// or the user's note on a reproduce request).
    /// `updated_input`: on allow, the tool's input as it should run (AskUserQuestion's, with the user's answers).
    pub fn respond(&self, request_id: &str, allow: bool, message: Option<String>, updated_input: Option<serde_json::Value>) -> bool {
        match self.pending.lock().unwrap().remove(request_id) {
            Some(tx) => tx.send(BridgeResponse { allow, message, updated_input }).is_ok(),
            None => false,
        }
    }

    /// Denies every pending request (used when the session restarts or stops).
    pub fn cancel_all(&self) {
        self.pending.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permission::helper::ask_bridge;
    use serde_json::json;
    use std::time::Duration;
    use tokio::sync::mpsc;

    fn setup() -> (Arc<PermissionBridge>, mpsc::UnboundedReceiver<UiEvent>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        let bridge = PermissionBridge::start(dir.path().join("b.sock"), Arc::new(move |ev| { let _ = tx.send(ev); })).unwrap();
        (bridge, rx, dir)
    }

    fn request() -> BridgeRequest {
        BridgeRequest { tool_name: "Bash".into(), input: json!({"command": "npm test"}), tool_use_id: Some("toolu_1".into()) }
    }

    fn ask_in_background(bridge: &PermissionBridge) -> tokio::task::JoinHandle<BridgeResponse> {
        let socket = bridge.socket_path.display().to_string();
        tokio::task::spawn_blocking(move || ask_bridge(Some(&socket), &request()))
    }

    async fn next_request_id(rx: &mut mpsc::UnboundedReceiver<UiEvent>) -> String {
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap().unwrap() {
            UiEvent::PermissionRequested { request_id, tool_name, input } => {
                assert_eq!(tool_name, "Bash");
                assert_eq!(input["command"], "npm test");
                request_id
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn allow_round_trip() {
        let (bridge, mut rx, _dir) = setup();
        let helper = ask_in_background(&bridge);
        let id = next_request_id(&mut rx).await;
        assert!(bridge.respond(&id, true, None, None));
        assert_eq!(helper.await.unwrap(), BridgeResponse { allow: true, message: None, updated_input: None });
    }

    #[tokio::test]
    async fn deny_round_trip() {
        let (bridge, mut rx, _dir) = setup();
        let helper = ask_in_background(&bridge);
        let id = next_request_id(&mut rx).await;
        assert!(bridge.respond(&id, false, None, None));
        assert!(!helper.await.unwrap().allow);
    }

    #[tokio::test]
    async fn cancel_all_denies_pending() {
        let (bridge, mut rx, _dir) = setup();
        let helper = ask_in_background(&bridge);
        let id = next_request_id(&mut rx).await;
        bridge.cancel_all();
        let r = helper.await.unwrap();
        assert!(!r.allow);
        assert!(r.message.unwrap().contains("denied"));
        assert!(!bridge.respond(&id, true, None, None), "a cancelled request can't be answered");
    }
}
