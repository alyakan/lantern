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

## Starting a chat, and what Claude suggests

**A chat from the phone.** `Projects` lists the folders the user has used in Claude lately and those with a chat open; `NewChat` starts a chat in one with a first message. Three layers decide, each on its own: the gateway (the folder must be exactly one of `Projects`, an absolute path with no NUL, the message written and at most 20,000 characters, at most five starts per phone per ten minutes), then the window (it checks the project and message again, because any window can emit the event it listens to). The chat always starts on **Ask**, whatever Permissions the project was left on, because nobody is at the Mac to approve anything else; its questions come to the phone like any other. It is started beside what the window shows: the window doesn't switch to it, and neither the project's Permissions nor the folder to reopen is recorded. The backend asks the window through `remote-new-chat`, waits up to 15 s for its answer (`remote_new_chat_done`), and tells the phone the slot once the hub lists the chat, so the phone can follow it.

**Suggestions.** When nothing waits on the user, Home shows up to three drafts ("carry on in that chat", "start a chat in that project") that Claude made from the recent chats, and a button to start something of one's own. The Mac makes them with one call to a small model (`suggest.rs`: Haiku, no tools, no MCP servers, no settings or hooks, no saved session, run from the temp folder, stopped after 60 s). It spends the user's Claude usage (a small Haiku call), so it is bounded: **the model is called at most once a minute, whoever asks and however busy the chats are**. One copy is kept for every phone until the chats change (what was last said or replied in them, or where they stand: not a streamed piece of a reply, so a busy chat doesn't count as a change) or half an hour passes; within a minute of the last call whatever is kept comes back, even if the chats moved on; one call runs at a time; a failure isn't retried at once; the phone keeps them ten minutes too; and nothing is asked while something waits on the user. A request like this one, or a chat opening, runs beside the phone's other work (at most three at once per phone), so a phone waiting on Claude can still answer a prompt and hear its chats. What the model replies is treated as hostile: parsed strictly (at most three items, every field capped, control characters removed), a chat it names must exist and a project must be named, never given as a path, and a suggestion is only ever a draft in a sheet the user reads, changes and sends themselves. The model is told chat titles, project names and the last thing said and replied in each chat, never a folder path.

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

**Not yet tried for real:** the suggestions call to Claude has only run against the scripted Mac's canned reply and in tests. Whether Haiku answers with bare JSON under that system prompt, and that `ask_claude` works from the running app (the window tells the backend where `claude` is), needs one try with the desktop app and a paired phone. A chat started from the phone has likewise only been exercised against the scripted Mac and the window's tests.

## What was run by hand

On the iOS simulator, against `fixture_gateway` (the real Rust gateway behind scripted chats): pairing by deep link and the confirmation, reconnecting on launch, Home with live updates, the decision screen, deny, the swipe-to-allow drag (answer reached the Mac and Home updated), and a streaming chat. All of it over loopback. Not run: Android, a real device, the camera, push, Maestro. Simulator quirk when scripting taps with `cliclick`: the first mouse-up after a system alert is sometimes lost, which looks like a stuck button; send another `du`.

## Not built yet

- A relay or tailnet transport (the adapter is there, the transport isn't).
- A Live Activity for a running turn.
- A real-device pass: camera scanning, the Bonjour permission prompt, push delivery and the swipe-to-allow drag are verified only by tests and the simulator.
