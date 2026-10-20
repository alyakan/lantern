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

/// How many connections may be in their WebSocket upgrade at once, and for how long each.
pub const UPGRADES: usize = 16;
pub const UPGRADE_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

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
    let on_link = std::sync::Arc::new(on_link);
    // Each connection's WebSocket upgrade runs on its own, at most UPGRADES at once: one that never finishes can't hold
    // up the next phone.
    let upgrades = std::sync::Arc::new(tokio::sync::Semaphore::new(UPGRADES));
    let task = tokio::spawn(async move {
        loop {
            let Ok((tcp, addr)) = listener.accept().await else {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            };
            let Ok(permit) = upgrades.clone().try_acquire_owned() else { continue };
            let on_link = on_link.clone();
            tokio::spawn(async move {
                let _ = tcp.set_nodelay(true);
                if let Ok(Ok(ws)) = tokio::time::timeout(UPGRADE_WAIT, tokio_tungstenite::accept_async_with_config(tcp, Some(ws_config()))).await {
                    on_link(pump(ws, addr.to_string()));
                }
                drop(permit);
            });
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

/// Says on the Wi-Fi that Lantern takes phones at `port`: Bonjour's `_lantern._tcp`, registered with macOS's own
/// mDNSResponder (a second responder of our own next to it isn't heard by the system's browsing). `id`: a short, stable
/// name for this Mac (from its key), which the phone matches against the one it paired with. Dropping it unregisters.
pub struct Bonjour {
    sd_ref: dns_sd::DNSServiceRef,
}

// The registration is only ever handed to DNSServiceRefDeallocate, once, from Drop.
unsafe impl Send for Bonjour {}

pub const SERVICE_TYPE: &str = "_lantern._tcp";

mod dns_sd {
    use std::ffi::{c_char, c_void};

    pub type DNSServiceRef = *mut c_void;

    // In libSystem (dns_sd.h), which every macOS program links.
    extern "C" {
        #[allow(clippy::too_many_arguments)]
        pub fn DNSServiceRegister(
            sd_ref: *mut DNSServiceRef,
            flags: u32,
            interface_index: u32,
            name: *const c_char,
            regtype: *const c_char,
            domain: *const c_char,
            host: *const c_char,
            port: u16,
            txt_len: u16,
            txt_record: *const c_void,
            callback: *const c_void,
            context: *mut c_void,
        ) -> i32;
        pub fn DNSServiceRefDeallocate(sd_ref: DNSServiceRef);
    }
}

/// A TXT record: each `key=value` with its length before it.
fn txt_record(pairs: &[(&str, &str)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (k, v) in pairs {
        let entry = format!("{k}={v}");
        let bytes = &entry.as_bytes()[..entry.len().min(255)];
        out.push(bytes.len() as u8);
        out.extend_from_slice(bytes);
    }
    out
}

impl Bonjour {
    pub fn advertise(port: u16, mac_name: &str, id: &str) -> Result<Self, String> {
        let instance: String = mac_name.chars().filter(|c| !c.is_control() && *c != '.').take(60).collect();
        let name = std::ffi::CString::new(instance).map_err(|e| e.to_string())?;
        let regtype = std::ffi::CString::new(SERVICE_TYPE).map_err(|e| e.to_string())?;
        let txt = txt_record(&[("v", "1"), ("id", id)]);
        let mut sd_ref: dns_sd::DNSServiceRef = std::ptr::null_mut();
        // SAFETY: every pointer is valid for the call; no callback is given, so nothing is called back later; the
        // registration lives until Drop deallocates it.
        let err = unsafe { dns_sd::DNSServiceRegister(&mut sd_ref, 0, 0, name.as_ptr(), regtype.as_ptr(), std::ptr::null(), std::ptr::null(), port.to_be(), txt.len() as u16, txt.as_ptr().cast(), std::ptr::null(), std::ptr::null_mut()) };
        if err != 0 || sd_ref.is_null() {
            return Err(format!("Bonjour wouldn't take Lantern's record (error {err})."));
        }
        Ok(Self { sd_ref })
    }
}

impl Drop for Bonjour {
    fn drop(&mut self) {
        // SAFETY: sd_ref came from a successful DNSServiceRegister and is deallocated only here.
        unsafe { dns_sd::DNSServiceRefDeallocate(self.sd_ref) };
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
    async fn a_connection_that_never_upgrades_doesnt_hold_up_the_next_phone() {
        let (got_tx, mut got_rx) = mpsc::unbounded_channel();
        let (task, port) = serve_lan(0, move |link| {
            let _ = got_tx.send(link);
        })
        .await
        .unwrap();
        // Opens a connection and says nothing.
        let _idle = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let started = std::time::Instant::now();
        let _phone = connect_lan(&format!("127.0.0.1:{port}")).await.unwrap();
        let link = tokio::time::timeout(std::time::Duration::from_secs(1), got_rx.recv()).await.expect("let in within a second");
        assert!(link.is_some() && started.elapsed() < std::time::Duration::from_secs(1));
        task.abort();
    }

    #[test]
    fn a_txt_record_is_length_prefixed_pairs() {
        assert_eq!(txt_record(&[("v", "1"), ("id", "ab")]), b"\x03v=1\x05id=ab".to_vec());
    }

    #[test]
    fn bonjour_takes_lanterns_record_and_lets_it_go() {
        let b = Bonjour::advertise(47999, "Lantern test", "test-id").expect("mDNSResponder registers it");
        drop(b);
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
