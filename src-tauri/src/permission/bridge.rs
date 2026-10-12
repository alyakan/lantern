use super::protocol::{BridgeRequest, BridgeResponse};
use crate::ui_event::{Sink, UiEvent};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::OwnedReadHalf;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::oneshot;

/// The longest request line taken: a Write's whole content goes through it.
const MAX_REQUEST: u64 = 32 << 20;
/// How long a connection may take to send its request before it's dropped.
const REQUEST_WAIT: Duration = Duration::from_secs(10);

/// Unix-socket server that turns helper requests into UI permission cards.
pub struct PermissionBridge {
    pub socket_path: PathBuf,
    pending: Mutex<HashMap<String, oneshot::Sender<BridgeResponse>>>,
    counter: AtomicU64,
    /// The accept loop, stopped by `close`.
    accept: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl PermissionBridge {
    pub fn start(socket_path: PathBuf, sink: Sink) -> std::io::Result<Arc<Self>> {
        let _ = std::fs::remove_file(&socket_path);
        let std_listener = std::os::unix::net::UnixListener::bind(&socket_path)?;
        std_listener.set_nonblocking(true)?;
        let bridge = Arc::new(Self { socket_path, pending: Mutex::new(HashMap::new()), counter: AtomicU64::new(0), accept: Mutex::new(None) });
        let b = bridge.clone();
        let accept = tauri::async_runtime::spawn(async move {
            let Ok(listener) = UnixListener::from_std(std_listener) else { return };
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        let (b, sink) = (b.clone(), sink.clone());
                        tokio::spawn(async move { b.handle(stream, sink).await });
                    }
                    // Usually out of file descriptors: back off and keep serving, or every later prompt is denied.
                    Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
                }
            }
        });
        *bridge.accept.lock().unwrap() = Some(accept);
        Ok(bridge)
    }

    async fn handle(&self, stream: UnixStream, sink: Sink) {
        let (read, mut write) = stream.into_split();
        let mut reader = BufReader::new(read.take(MAX_REQUEST));
        let mut line = String::new();
        match tokio::time::timeout(REQUEST_WAIT, reader.read_line(&mut line)).await {
            Ok(Ok(n)) if n > 0 => {}
            _ => return,
        }
        let Ok(req) = serde_json::from_str::<BridgeRequest>(&line) else { return };
        // The helper sends nothing after its request, so its read half only tells us when it has gone.
        let mut read = reader.into_inner().into_inner();
        let id = format!("perm-{}", self.counter.fetch_add(1, Ordering::SeqCst) + 1);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        sink(UiEvent::PermissionRequested { request_id: id.clone(), tool_name: req.tool_name, input: req.input });
        tokio::select! {
            // A dropped sender (cancel_all) closes the connection; the helper then denies.
            resp = rx => {
                if let Ok(resp) = resp {
                    if let Ok(json) = serde_json::to_string(&resp) {
                        let _ = write.write_all(format!("{json}\n").as_bytes()).await;
                    }
                }
            }
            // The helper is gone (its claude dropped the call), so nobody can take the answer: the card goes.
            _ = closed(&mut read) => {
                self.pending.lock().unwrap().remove(&id);
                sink(UiEvent::PermissionWithdrawn { request_id: id });
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

    /// Stops accepting helpers and removes the socket (the chat is closing). The caller denies pending requests first.
    pub async fn close(&self) {
        let accept = self.accept.lock().unwrap().take();
        if let Some(accept) = accept {
            accept.abort();
            let _ = accept.await;
        }
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

/// Resolves when the helper closes its end of the connection.
async fn closed(read: &mut OwnedReadHalf) {
    let mut buf = [0u8; 64];
    loop {
        match read.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
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

    #[tokio::test]
    async fn a_helper_that_goes_away_withdraws_its_prompt() {
        let (bridge, mut rx, _dir) = setup();
        let mut helper = UnixStream::connect(&bridge.socket_path).await.unwrap();
        helper.write_all(format!("{}\n", serde_json::to_string(&request()).unwrap()).as_bytes()).await.unwrap();
        let id = next_request_id(&mut rx).await;
        drop(helper);
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap().unwrap() {
            UiEvent::PermissionWithdrawn { request_id } => assert_eq!(request_id, id),
            other => panic!("unexpected {other:?}"),
        }
        assert!(!bridge.respond(&id, true, None, None), "a withdrawn prompt can't be answered");
    }

    #[tokio::test]
    async fn an_oversized_request_shows_no_prompt() {
        let (bridge, mut rx, _dir) = setup();
        let mut helper = UnixStream::connect(&bridge.socket_path).await.unwrap();
        // Past the cap, with no line end: the bridge stops reading and hangs up, so the write fails.
        let _ = helper.write_all(&vec![b'x'; MAX_REQUEST as usize + 1]).await;
        assert!(tokio::time::timeout(Duration::from_millis(500), rx.recv()).await.is_err());
    }

    #[tokio::test]
    async fn closing_stops_the_accept_loop_and_removes_the_socket() {
        let (bridge, _rx, _dir) = setup();
        let path = bridge.socket_path.clone();
        bridge.close().await;
        assert!(!path.exists());
        // The accept loop held a clone of the bridge; once it's stopped only ours is left.
        assert_eq!(Arc::strong_count(&bridge), 1);
    }
}
