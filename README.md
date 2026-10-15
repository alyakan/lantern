# Lantern for Claude Code

A Mac app for the `claude` CLI you already have: see what Claude is doing as cards and diffs, and steer it one reviewable step at a time. **[See all features →](docs/FEATURES.md)**

![A Lantern chat: tool calls as cards, the edit as a diff, and the file open in the side panel](docs/images/chat-cards.png)

## What it does

| | |
| --- | --- |
| **A chat you can read** | Every tool call is a card, edits and new files are diffs, and Allow / Deny prompts show up in the conversation instead of scrolling past. |
| **Step by step** | Claude works one page at a time and stops after each. Build, review a pull request file by file, debug from evidence, or review a design as a map. You approve a page, ask about it, or change it. |
| **Teams on a canvas** | A Lead splits the work between agents, each in its own git worktree and branch. They float on a canvas you can pan and zoom, and you decide which branches merge. |
| **A side panel for the rest** | Changes, Files, Plan, Activity, Tests and Network sit beside the chat: every diff, an editor, the plan or map, what each agent did, test results, and API traffic from [Network Monitor](https://github.com/alyakan/network-monitor). |
| **Yours to set up** | **Ask** or **Auto** permissions, a model preset per chat, a sidebar of every project, History for past chats, and a command palette for all of it. |

## Install and get started

Lantern needs macOS and [Claude Code](https://docs.claude.com/en/docs/claude-code), installed and logged in. Lantern runs your `claude` CLI and never handles authentication itself.

1. Download the latest `.dmg` from [Releases](../../releases), open it and drag Lantern to Applications. The app is signed and notarized by Apple, so it opens like any other Mac app.
2. Open Lantern. It finds `claude` by itself, with no setup screen.
3. Open a folder (⌘O). You land on a start screen: say what you're after, or pick **Build**, **Review a PR**, **Debug**, **Design** or **Start a team**.

Lantern updates itself: when a new release is out, "Update ready" appears under the chat box.

## More

- [All the features, with screenshots](docs/FEATURES.md)
- [Building from source](#build-from-source)
- [Contributing](CONTRIBUTING.md)
- [License](LICENSE): MIT. Lantern is an independent project and is not affiliated with or endorsed by Anthropic.

## Build from source

Requires Node 20.19 or newer (see `.nvmrc`) and a stable Rust toolchain.

    npm install
    npm run tauri dev

To build the app bundle:

    npm run tauri build -- --bundles app

Tests: `npm test` and `cargo test --manifest-path src-tauri/Cargo.toml`. Manual checks before a release are in [docs/SMOKE_TEST.md](docs/SMOKE_TEST.md).
