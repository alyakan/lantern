//! A stand-in phone for trying Remote control against a running Lantern (a dev build), by hand:
//!
//!   cargo run --example remote_probe -- seed <remote.json>   pairs this probe by writing it into the file (Lantern not running)
//!   cargo run --example remote_probe -- connect [host:port]  connects as that phone, lists chats and what waits, follows one
//!
//! Its key is kept in /tmp/lantern-probe.key. Seeding turns Remote control on in that file; Lantern must be closed while
//! it is written, since Lantern reads the file when it starts.
//!
//! Never seed the real app's remote.json: run the dev build with LANTERN_REMOTE_FILE=/tmp/lantern-dev-remote.json (its
//! Mac key then has a Keychain entry of its own too) and seed that file.

use base64::Engine;
use lantern_lib::remote::protocol::{ClientMessage, Request, ServerMessage, PROTOCOL_VERSION};
use lantern_lib::remote::secure::{self, generate_keypair, Handshake, Keypair};
use lantern_lib::remote::transport::connect_lan;
use std::time::Duration;

const KEY: &str = "/tmp/lantern-probe.key";
const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

fn load_key() -> Keypair {
    let text = std::fs::read_to_string(KEY).expect("no probe key: run `seed` first");
    let (private, public) = text.trim().split_once(':').expect("a probe key");
    Keypair { private: B64.decode(private).unwrap(), public: B64.decode(public).unwrap() }
}

fn seed(path: &str) {
    use std::os::unix::fs::OpenOptionsExt;
    let key = generate_keypair().unwrap();
    std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(KEY).and_then(|mut f| std::io::Write::write_all(&mut f, format!("{}:{}", B64.encode(&key.private), B64.encode(&key.public)).as_bytes())).unwrap();
    let mut saved: serde_json::Value = std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| serde_json::json!({}));
    saved["enabled"] = true.into();
    let devices = saved["devices"].as_array().cloned().unwrap_or_default();
    let mut devices: Vec<serde_json::Value> = devices.into_iter().filter(|d| d["name"] != "Remote probe").collect();
    let encoded = B64.encode(&key.public);
    devices.push(serde_json::json!({"id": format!("phone-{}", &encoded[..12]), "name": "Remote probe", "key": encoded, "paired_at": 0, "last_seen": null, "push_token": null}));
    saved["devices"] = devices.into();
    std::fs::write(path, serde_json::to_vec_pretty(&saved).unwrap()).unwrap();
    println!("seeded {path}: Remote control on, with the probe paired");
}

async fn connect(addr: &str, say: Option<&str>) {
    let key = load_key();
    let mut link = connect_lan(addr).await.expect("Lantern isn't listening there");
    link.to_peer.send(vec![secure::CONNECT]).await.unwrap();
    let mut hs = Handshake::connect_initiator(&key).unwrap();
    link.to_peer.send(hs.write().unwrap()).await.unwrap();
    hs.read(&link.from_peer.recv().await.expect("closed during the handshake")).unwrap();
    println!("Mac's key: {}", B64.encode(hs.remote_key().unwrap()));
    link.to_peer.send(hs.write().unwrap()).await.unwrap();
    let (_, mut channel) = hs.finish().unwrap();
    let send = |channel: &mut secure::Channel, msg: &ClientMessage| {
        for f in channel.seal(&serde_json::to_vec(msg).unwrap()).unwrap() {
            link.to_peer.try_send(f).unwrap();
        }
    };
    send(&mut channel, &ClientMessage::Hello { protocol: PROTOCOL_VERSION, app_version: "probe".into(), device_name: "Remote probe".into(), features: vec![] });
    send(&mut channel, &ClientMessage::Request { id: 1, request: Request::ListChats });
    send(&mut channel, &ClientMessage::Request { id: 2, request: Request::ListWaiting });
    let mut epoch = 0;
    let mut followed = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(if say.is_some() { 90 } else { 20 });
    loop {
        let Ok(Some(frame)) = tokio::time::timeout_at(deadline, link.from_peer.recv()).await else { break };
        let Ok(Some(plain)) = channel.open(&frame) else { continue };
        let msg: ServerMessage = serde_json::from_slice(&plain).unwrap();
        match &msg {
            ServerMessage::Welcome { epoch: e, mac_name, app_version, .. } => {
                epoch = *e;
                println!("welcome from {mac_name} (Lantern {app_version})");
            }
            ServerMessage::Response { id: 1, ok: Some(chats), .. } if !followed => {
                println!("chats: {chats}");
                if let Some(slot) = chats.as_array().and_then(|c| c.first()).and_then(|c| c["slot"].as_str()) {
                    followed = true;
                    println!("following {slot}");
                    send(&mut channel, &ClientMessage::Request { id: 3, request: Request::Subscribe { slot: slot.into(), after: 0, epoch } });
                    if let Some(text) = say {
                        send(&mut channel, &ClientMessage::Request { id: 4, request: Request::Send { slot: slot.into(), text: text.into(), client_id: "probe-1".into() } });
                    }
                }
            }
            ServerMessage::Reset { slot, events, hidden, page, done, .. } => println!("reset of {slot}: page {page}, {} events, {hidden} earlier turns, done {done}", events.len()),
            ServerMessage::Event { slot, seq, event } => println!("event {slot} #{seq}: {}", serde_json::to_string(event).unwrap().chars().take(160).collect::<String>()),
            other => println!("{}", serde_json::to_string(other).unwrap().chars().take(300).collect::<String>()),
        }
    }
    println!("done");
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("seed") => seed(args.get(2).expect("the path of remote.json")),
        Some("connect") => connect(args.get(2).map_or("127.0.0.1:47123", String::as_str), None).await,
        Some("send") => connect("127.0.0.1:47123", Some(args.get(2).map_or("Reply with just the word pong, and use no tools.", String::as_str))).await,
        _ => eprintln!("usage: remote_probe seed <remote.json> | connect [host:port]"),
    }
}
