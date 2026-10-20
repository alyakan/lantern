//! The real gateway and Wi-Fi transport behind three scripted chats (remote::fixture), for trying the phone app and for
//! its integration tests, without a Mac's own chats:
//!
//!   cargo run --example fixture_gateway -- [--port N] [--bonjour] [--pace-ms N]
//!
//! It prints one JSON line when it is ready (the port, a pairing link and its parts) and another for each `pair` line it
//! is sent on standard input (a new code); it stops when standard input closes or it is sent `quit`. Nothing it keeps
//! outlasts it: its paired phones and Mac key are in memory.

use base64::Engine;
use lantern_lib::remote::fixture::FixtureHost;
use lantern_lib::remote::gateway::Gateway;
use lantern_lib::remote::keys::Memory;
use lantern_lib::remote::pairing::{pairing_link, RemoteStore};
use lantern_lib::remote::transport::{serve_lan, Bonjour};
use lantern_lib::remote::{local_addresses, now_ms, Remote};
use std::io::BufRead;
use std::time::Duration;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

#[tokio::main]
async fn main() {
    let remote = Remote::new(RemoteStore::load(None), Box::new(Memory::default()));
    remote.store.set_enabled(true).unwrap();
    let pace = Duration::from_millis(arg("--pace-ms").and_then(|v| v.parse().ok()).unwrap_or(40));
    let host = FixtureHost::new(&remote, pace);
    let mac = remote.mac_key().unwrap();
    let gateway = Gateway::new(remote.bus.clone(), remote.hub.clone(), remote.store.clone(), host, mac.clone(), remote.epoch);
    let door = gateway.clone();
    let (_listener, port) = serve_lan(arg("--port").and_then(|v| v.parse().ok()).unwrap_or(0), move |link| door.accept(link)).await.unwrap();
    let _bonjour = std::env::args().any(|a| a == "--bonjour").then(|| Bonjour::advertise(port, "Fixture Mac", &B64.encode(&mac.public).chars().take(10).collect::<String>()).expect("Bonjour"));

    let offer = |event: &str| {
        let offer = remote.store.start_offer(now_ms()).unwrap();
        let hosts = local_addresses();
        println!(
            "{}",
            serde_json::json!({
                "event": event,
                "port": port,
                "link": pairing_link(&mac.public, &offer, &hosts, port, "Fixture Mac"),
                "macKey": B64.encode(&mac.public),
                "secret": B64.encode(offer.secret),
                "hosts": hosts,
            })
        );
    };
    offer("ready");
    for line in std::io::stdin().lock().lines() {
        match line.unwrap_or_default().trim() {
            "pair" => offer("offer"),
            "quit" => break,
            _ => {}
        }
    }
}
