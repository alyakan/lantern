//! Lantern's own capture of a phone's HTTP(S) traffic (it was the Network Monitor app): an HTTP proxy for the phone's
//! Wi-Fi settings, and a WireGuard endpoint for apps that ignore the proxy. Both end TLS with certificates minted from
//! Lantern's root (ca.rs), send each request on and record it (intercept.rs, recorder.rs). The recorder is what the
//! Network tab and Claude's network_* tools read (network.rs).
//!
//! It's off until the user starts it in the Network tab: it listens on the Mac's local network.

pub mod ca;
pub mod intercept;
pub mod proxy;
pub mod recorder;
pub mod wireguard;

use recorder::Recorder;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tokio::task::JoinHandle;

/// The proxy's port (Network Monitor's), and the WireGuard endpoint's (WireGuard's usual one).
pub const PROXY_PORT: u16 = 8888;
pub const WIREGUARD_PORT: u16 = 51820;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    /// Where the phone's Wi-Fi proxy points: this Mac's address and the proxy's port.
    pub proxy: Option<String>,
    /// The page that hands out Lantern's root.
    pub setup_url: Option<String>,
    /// The phone's WireGuard config, and it as a QR code (SVG) for the WireGuard app to scan.
    pub wireguard_config: Option<String>,
    pub wireguard_qr: Option<String>,
    /// Why it couldn't start.
    pub error: Option<String>,
    /// How many requests it has now.
    pub captured: usize,
}

struct Running {
    tasks: Vec<JoinHandle<()>>,
    host: Option<String>,
    keys: wireguard::Keys,
}

impl Drop for Running {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

pub struct Capture {
    /// Lantern's capture folder: its root certificate and the WireGuard keys.
    dir: Option<PathBuf>,
    /// Network Monitor's folder, whose root is taken over when Lantern has none.
    legacy: Option<PathBuf>,
    pub recorder: Arc<Recorder>,
    running: Mutex<Option<Running>>,
    error: Mutex<Option<String>>,
}

impl Capture {
    pub fn new(dir: Option<PathBuf>) -> Self {
        let legacy = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support/NetworkMonitor"));
        Self { dir, legacy, recorder: Arc::new(Recorder::new()), running: Mutex::new(None), error: Mutex::new(None) }
    }

    /// Starts the proxy and the WireGuard endpoint (on the runtime this is called on).
    pub async fn start(&self) -> Status {
        if self.running.lock().unwrap().is_none() {
            match self.launch().await {
                Ok(running) => {
                    *self.running.lock().unwrap() = Some(running);
                    *self.error.lock().unwrap() = None;
                    self.recorder.active.store(true, Ordering::Relaxed);
                }
                Err(e) => *self.error.lock().unwrap() = Some(e),
            }
        }
        self.status()
    }

    async fn launch(&self) -> Result<Running, String> {
        let dir = self.dir.clone().ok_or("Lantern has no app data folder to keep its certificate in.")?;
        let ca = ca::Authority::load(&dir, self.legacy.as_deref())?;
        let keys = load_keys(&dir)?;
        let engine = Arc::new(intercept::Engine::new(ca, self.recorder.clone())?);
        let proxy = tokio::net::TcpListener::bind(("0.0.0.0", PROXY_PORT)).await.map_err(|e| format!("Couldn't listen on port {PROXY_PORT} ({e}). If Network Monitor is open, quit it: Lantern captures in its place now."))?;
        let udp = tokio::net::UdpSocket::bind(("0.0.0.0", WIREGUARD_PORT)).await.map_err(|e| format!("Couldn't listen for WireGuard on port {WIREGUARD_PORT} ({e})."))?;
        let addresses = crate::remote::local_addresses();
        let me = Arc::new(proxy::Me { port: PROXY_PORT, addresses: addresses.clone() });
        let tasks = vec![tokio::spawn(proxy::run(engine.clone(), proxy, me)), tokio::spawn(wireguard::run(engine, udp, keys.clone(), wireguard::Ports::default()))];
        Ok(Running { tasks, host: addresses.into_iter().next(), keys })
    }

    pub fn stop(&self) -> Status {
        self.running.lock().unwrap().take();
        self.recorder.active.store(false, Ordering::Relaxed);
        self.status()
    }

    pub fn status(&self) -> Status {
        let running = self.running.lock().unwrap();
        let captured = self.recorder.count();
        let error = self.error.lock().unwrap().clone();
        let Some(r) = running.as_ref() else {
            return Status { running: false, proxy: None, setup_url: None, wireguard_config: None, wireguard_qr: None, error, captured };
        };
        let host = r.host.clone();
        let config = host.as_ref().map(|h| wireguard::phone_config(&r.keys, &format!("{h}:{WIREGUARD_PORT}")));
        Status {
            running: true,
            proxy: host.as_ref().map(|h| format!("{h}:{PROXY_PORT}")),
            setup_url: host.as_ref().map(|h| format!("http://{h}:{PROXY_PORT}/")),
            wireguard_qr: config.as_deref().and_then(|c| crate::remote::pairing::qr_svg(c).ok()),
            wireguard_config: config,
            error: error.or_else(|| host.is_none().then(|| "This Mac isn't on a local network, so the phone can't reach it.".to_string())),
            captured,
        }
    }
}

#[derive(Serialize, Deserialize)]
struct StoredKeys {
    server: String,
    phone: String,
}

/// The WireGuard keys in `dir` (wireguard.json, readable only by the user), made the first time: kept, so the phone's
/// tunnel is set up once.
fn load_keys(dir: &Path) -> Result<wireguard::Keys, String> {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD;
    let path = dir.join("wireguard.json");
    let read = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<StoredKeys>(&b).ok()).and_then(|k| {
        let server: [u8; 32] = b64.decode(k.server).ok()?.try_into().ok()?;
        let phone: [u8; 32] = b64.decode(k.phone).ok()?.try_into().ok()?;
        Some(wireguard::Keys { server, phone })
    });
    if let Some(keys) = read {
        return Ok(keys);
    }
    let keys = wireguard::Keys::generate();
    let json = serde_json::to_vec_pretty(&StoredKeys { server: b64.encode(keys.server), phone: b64.encode(keys.phone) }).map_err(|e| e.to_string())?;
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&path).map_err(|e| format!("couldn't write {}: {e}", path.display()))?;
    file.write_all(&json).map_err(|e| e.to_string())?;
    Ok(keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wireguard_keys_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let a = load_keys(dir.path()).unwrap();
        let b = load_keys(dir.path()).unwrap();
        assert_eq!((a.server, a.phone), (b.server, b.phone));
        assert_ne!(a.server, a.phone);
    }

    #[test]
    fn stopped_it_says_so() {
        let capture = Capture::new(None);
        let status = capture.status();
        assert!(!status.running);
        assert!(status.proxy.is_none());
    }
}
