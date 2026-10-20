# Lantern on your phone

A paired phone (iOS or Android, one React Native app in `mobile/`) sees the chats you have open, answers Claude's cards, sends messages, stops a turn and wakes a sleeping chat. Over the same Wi-Fi only for now; a relay or tailnet can be added later as another transport, because pairing, authentication and encryption sit above the transport.

## Where things live

| Layer | Desktop (Rust, `src-tauri/src/remote/`) | Phone (`mobile/src/`) |
| --- | --- | --- |
| Shared state | `bus.rs` (every chat's events leave from here), `hub.rs` (what a late joiner needs: the current turn, pending prompts) | `sync/` (per-chat state rebuilt from events) |
| Protocol | `protocol.rs` (`RemoteEvent`, requests; types generated into `mobile/src/protocol/generated` by ts-rs) | `protocol/`, `view/` |
| Secure channel | `secure.rs`, `pairing.rs`, `keys.rs` (Noise `XXpsk3` to pair, `XX` to reconnect) | `noise/` (@noble, checked byte for byte against `snow` through `noise-vectors.json`) |
| Transport | `transport.rs` (WebSocket on the LAN, Bonjour `_lantern._tcp`) | `net/` (transport, discovery, connection, session) |
| Gateway | `gateway.rs` (allowlist of requests, per-phone outbox, catch-up) | `shell/` (controller), `screens/` |
| Pushes | `notifier.rs` (Expo push service; generic words, titles only if switched on) | `notifications.ts` |

The phone never sends tool input. To answer an `AskUserQuestion` it sends only the `answers`, which Rust adds to Claude's original input (`answers.rs`).

## Pairing

Settings > Remote control > turn it on > Show a pairing code. The code is a QR (and a link you can copy) holding the Mac's public key, its addresses and a one-time secret that works once, for five minutes. The phone checks the Mac's key before it sends the third handshake message.

## Running it

- Desktop: `LANTERN_REMOTE_FILE=/tmp/lantern-remote.json npm run tauri dev` keeps a dev run's settings and paired phones out of the real app's `remote.json`, and its Mac key in a Keychain item of its own ("Lantern Remote control (dev)"), so nothing of the real app's is touched.
- Phone, against a scripted Mac (no Claude needed): `cargo run --example fixture_gateway -- --bonjour` in `src-tauri/`; type `pair` on its stdin for a link, open it on the phone (`xcrun simctl openurl booted "<link>"` on a simulator).
- Phone build: `cd mobile && npx expo run:ios` (or `run:android`). Expo Go can't run it: the app has native modules (Bonjour, camera).
- Pushes need an EAS project: put its id in `mobile/app.json` under `extra.eas.projectId`.
- macOS Firewall: the first time Remote control listens, macOS asks whether Lantern may accept incoming connections: Allow, or a phone connects to nothing (the connection is accepted and then ignored, so it looks like "didn't answer"). An unsigned dev build or example binary is asked about again after every rebuild; `socketfilterfw --getappblocked <binary>` says whether one is blocked. Over loopback (a simulator on the same Mac) the firewall doesn't matter, so a simulator test passes where a real phone would not.
- Clipboard: "Copy the link" puts the one-time pairing secret on the clipboard, which Universal Clipboard may sync to the user's other devices. It works once and for five minutes only.

## Tests

- Rust: `cargo test` in `src-tauri/` (the gateway, hub, bus, pairing, notifier and Noise vectors).
- Phone: `npx jest` in `mobile/`. With `LANTERN_FIXTURE_GATEWAY` set to the fixture gateway's binary, `src/integration/` also runs the phone's real code against the real Rust gateway.
- CI regenerates the protocol types and fails if `git status` shows a difference.
- Maestro flows in `mobile/.maestro/` (pair, deny, swipe to allow) are written but have never been run: Maestro isn't installed where they were written. The same steps were done by hand in the iOS simulator (see below), so expect small fixes to the first real run.

## What was run by hand

On the iOS simulator, against `fixture_gateway` (the real Rust gateway behind scripted chats): pairing by deep link and the confirmation, reconnecting on launch, Home with live updates, the decision screen, deny, the swipe-to-allow drag (answer reached the Mac and Home updated), and a streaming chat. All of it over loopback. Not run: Android, a real device, the camera, push, Maestro. Simulator quirk when scripting taps with `cliclick`: the first mouse-up after a system alert is sometimes lost, which looks like a stuck button; send another `du`.

## Not built yet

- A relay or tailnet transport (the adapter is there, the transport isn't).
- A Live Activity for a running turn.
- A real-device pass: camera scanning, the Bonjour permission prompt, push delivery and the swipe-to-allow drag are verified only by tests and the simulator.
