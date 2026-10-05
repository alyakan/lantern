# Lantern for Claude Code

A macOS desktop app for the `claude` CLI you already have. It shows what Claude is doing while it works (tool calls, file edits as diffs, commands still running in the background), and it can walk through a task one reviewable step at a time.

![A Lantern chat with a diff and tool calls](docs/screenshots/chat.png)

## Why

The terminal is a fine place to talk to Claude Code, but a hard place to follow a long turn: edits scroll past, background commands disappear, and a twelve-step plan arrives as one wall of text. Lantern keeps the same Claude Code underneath and gives each piece room to be read.

## Features

- **Readable turns.** Every tool call is a card. Edits and new files show as diffs, and the Changes list opens any touched file in a full side-by-side diff.
- **Ask and Auto.** In Ask mode edits apply and anything else asks you with Allow/Deny. In Auto mode Claude Code's own classifier approves most actions.
- **Step by step.** Build, Teach or Review a change one page at a time. Each step is a page with Previous and Next; you approve it, ask about it, or ask for a change, and only that step is rewritten.
- **Review mode.** Point it at a pull request or branch. Each changed file gets its own page, findings become cards you Agree with or Reject, and your verdicts go back to Claude together.
- **Tests tab.** Test runs from pytest, jest, vitest, cargo and xcodebuild are parsed into passes and failures with file:line links.
- **Search.** ⌘P finds files, ⌘⇧F searches text (regex, case, whole word), ⌘F searches inside an open file or diff.
- **History and sessions.** Pick up any earlier Claude Code session for a folder, including ones started in the terminal. Several chats can run side by side, with a notice when one finishes or needs you.

![A Step-by-step plan page](docs/screenshots/steps.png)

## Requirements

- macOS.
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and logged in. Lantern runs your `claude` CLI and never handles authentication itself.

## Install

Download the latest `.dmg` from [Releases](../../releases), open it and drag Lantern to Applications. The app is signed and notarized by Apple, so it opens like any other Mac app.

## Build from source

Requires Node 20.19 or newer (see `.nvmrc`) and a stable Rust toolchain.

    npm install
    npm run tauri dev

To build the app bundle:

    npm run tauri build -- --bundles app

Tests: `npm test` and `cargo test --manifest-path src-tauri/Cargo.toml`. Manual checks before a release are in [docs/SMOKE_TEST.md](docs/SMOKE_TEST.md). See [CONTRIBUTING.md](CONTRIBUTING.md) to send a change.

## License

[MIT](LICENSE). Lantern is an independent project and is not affiliated with or endorsed by Anthropic.
