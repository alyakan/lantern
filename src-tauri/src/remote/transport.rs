//! What carries a paired phone's frames: the Wi-Fi now (a WebSocket, found by Bonjour), a relay or a tailnet later.
//! A transport only moves frames, each one already sealed by the secure channel (see secure.rs): it can't read them,
//! and the gateway doesn't care which transport a phone came in on. Each connection is a `Link`: frames in and out.

use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

/// The biggest frame a transport takes: one Noise message (see secure.rs). Anything bigger ends the connection before
/// it is held in memory.
pub const MAX_FRAME: usize = 65535;
/// How many frames may wait to go out to a phone before it counts as too slow (the gateway then drops it, and the phone
/// catches up when it connects again).
pub const OUTBOX: usize = 256;

/// One connection: frames from the phone, and where frames for it go. Dropping `to_peer` closes it.
pub struct Link {
    pub to_peer: mpsc::Sender<Vec<u8>>,
    pub from_peer: mpsc::Receiver<Vec<u8>>,
    /// Who is on the other end, for logs (an address).
    pub peer: String,
}

/// Two ends of a connection in memory: what the gateway's tests use as a phone.
pub fn link_pair() -> (Link, Link) {
    let (a_tx, a_rx) = mpsc::channel(OUTBOX);
    let (b_tx, b_rx) = mpsc::channel(OUTBOX);
    (Link { to_peer: a_tx, from_peer: b_rx, peer: "memory:a".into() }, Link { to_peer: b_tx, from_peer: a_rx, peer: "memory:b".into() })
}

fn ws_config() -> WebSocketConfig {
    let mut c = WebSocketConfig::default();
    c.max_message_size = Some(MAX_FRAME);
    c.max_frame_size = Some(MAX_FRAME);
    c
}

/// Moves frames between a WebSocket and a Link until either side closes. Only binary messages are frames; text, and
/// anything bigger than MAX_FRAME, ends the connection.
fn pump<S>(ws: tokio_tungstenite::WebSocketStream<S>, peer: String) -> Link
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut sink, mut stream) = ws.split();
    let (to_peer, mut outbox) = mpsc::channel::<Vec<u8>>(OUTBOX);
    let (inbox, from_peer) = mpsc::channel::<Vec<u8>>(OUTBOX);
    tokio::spawn(async move {
        while let Some(frame) = outbox.recv().await {
            if sink.send(Message::Binary(frame.into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            match msg {
                Message::Binary(b) if b.len() <= MAX_FRAME => {
                    if inbox.send(b.to_vec()).await.is_err() {
                        break;
                    }
                }
                Message::Ping(_) | Message::Pong(_) => {}
                _ => break,
            }
        }
    });
    Link { to_peer, from_peer, peer }
}

/// Listens for phones on the Wi-Fi at `port`, handing each connection to `on_link`. Ends when the returned handle is
/// aborted (the gateway stops it when Remote control is turned off).
pub async fn serve_lan(port: u16, on_link: impl Fn(Link) + Send + Sync + 'static) -> Result<(tokio::task::JoinHandle<()>, u16), String> {
    let listener = TcpListener::bind(("0.0.0.0", port)).await.map_err(|e| format!("Couldn't listen for phones on port {port}: {e}"))?;
    let bound = listener.local_addr().map_err(|e| e.to_string())?.port();
    let task = tokio::spawn(async move {
        loop {
            let Ok((tcp, addr)) = listener.accept().await else {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            };
            let _ = tcp.set_nodelay(true);
            match tokio::time::timeout(std::time::Duration::from_secs(10), tokio_tungstenite::accept_async_with_config(tcp, Some(ws_config()))).await {
                Ok(Ok(ws)) => on_link(pump(ws, addr.to_string())),
                _ => continue,
            }
        }
    });
    Ok((task, bound))
}

/// Connects to Lantern at `addr` as a phone would (the gateway's integration tests).
pub async fn connect_lan(addr: &str) -> Result<Link, String> {
    let tcp = TcpStream::connect(addr).await.map_err(|e| e.to_string())?;
    let (ws, _) = tokio_tungstenite::client_async_with_config(format!("ws://{addr}/"), tcp, Some(ws_config())).await.map_err(|e| e.to_string())?;
    Ok(pump(ws, addr.to_string()))
}

/// Says on the Wi-Fi that Lantern takes phones at `port`: Bonjour's `_lantern._tcp`. `id`: a short, stable name for this
/// Mac (from its key), which the phone matches against the one it paired with.
pub struct Bonjour {
    daemon: mdns_sd::ServiceDaemon,
    fullname: String,
}

pub const SERVICE_TYPE: &str = "_lantern._tcp.local.";

impl Bonjour {
    pub fn advertise(port: u16, mac_name: &str, id: &str) -> Result<Self, String> {
        let daemon = mdns_sd::ServiceDaemon::new().map_err(|e| e.to_string())?;
        let host = format!("lantern-{id}.local.");
        let instance: String = mac_name.chars().filter(|c| !c.is_control() && *c != '.').take(60).collect();
        let props = [("v", "1"), ("id", id)];
        let info = mdns_sd::ServiceInfo::new(SERVICE_TYPE, &instance, &host, "", port, &props[..]).map_err(|e| e.to_string())?.enable_addr_auto();
        let fullname = info.get_fullname().to_string();
        daemon.register(info).map_err(|e| e.to_string())?;
        Ok(Self { daemon, fullname })
    }
}

impl Drop for Bonjour {
    fn drop(&mut self) {
        let _ = self.daemon.unregister(&self.fullname);
        let _ = self.daemon.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frames_cross_the_wifi_transport_both_ways() {
        let (got_tx, mut got_rx) = mpsc::unbounded_channel();
        let (task, port) = serve_lan(0, move |link| {
            let _ = got_tx.send(link);
        })
        .await
        .unwrap();
        let mut phone = connect_lan(&format!("127.0.0.1:{port}")).await.unwrap();
        let mut mac = got_rx.recv().await.unwrap();
        phone.to_peer.send(b"hello".to_vec()).await.unwrap();
        assert_eq!(mac.from_peer.recv().await.unwrap(), b"hello");
        mac.to_peer.send(b"back".to_vec()).await.unwrap();
        assert_eq!(phone.from_peer.recv().await.unwrap(), b"back");
        task.abort();
    }

    #[tokio::test]
    async fn a_frame_bigger_than_a_noise_message_ends_the_connection() {
        let (got_tx, mut got_rx) = mpsc::unbounded_channel();
        let (task, port) = serve_lan(0, move |link| {
            let _ = got_tx.send(link);
        })
        .await
        .unwrap();
        let phone = connect_lan(&format!("127.0.0.1:{port}")).await.unwrap();
        let mut mac = got_rx.recv().await.unwrap();
        // The phone's own end won't send more than MAX_FRAME, so this goes around it, as a hostile client would.
        let tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let mut big = WebSocketConfig::default();
        big.max_message_size = None;
        big.max_frame_size = None;
        let (mut raw, _) = tokio_tungstenite::client_async_with_config(format!("ws://127.0.0.1:{port}/"), tcp, Some(big)).await.unwrap();
        let mut hostile = got_rx.recv().await.unwrap();
        let _ = raw.send(Message::Binary(vec![0u8; MAX_FRAME + 1].into())).await;
        assert!(tokio::time::timeout(std::time::Duration::from_secs(5), hostile.from_peer.recv()).await.unwrap().is_none(), "closed without a frame");
        drop(phone);
        assert!(mac.from_peer.recv().await.is_none());
        task.abort();
    }

    #[tokio::test]
    async fn memory_links_carry_frames_like_the_real_one() {
        let (mut a, mut b) = link_pair();
        a.to_peer.send(vec![1]).await.unwrap();
        assert_eq!(b.from_peer.recv().await, Some(vec![1]));
        b.to_peer.send(vec![2]).await.unwrap();
        assert_eq!(a.from_peer.recv().await, Some(vec![2]));
        drop(a);
        assert!(b.from_peer.recv().await.is_none());
    }
}
