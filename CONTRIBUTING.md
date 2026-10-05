# Contributing to Lantern

Thanks for taking a look. Bug reports, ideas and pull requests are all welcome.

## Setup

You need macOS, Node 20.19 or newer (`.nvmrc` has the version), a stable Rust toolchain, and Claude Code installed and logged in.

    npm install
    npm run tauri dev

## Working on the UI without Claude

`npm run dev` serves the frontend alone at http://localhost:1420 with a fake backend:

- `/?mock` opens the app with no folder.
- `/?mock=ready` opens a demo project with an empty chat.
- `/?mock=demo` plays a scripted turn by itself; add `&allow` to approve its permission prompt.

The fake backend lives in `src/dev/mockBackend.ts` and is never part of a build.

## Before opening a pull request

Run both test suites and the type check:

    npm test
    cargo test --manifest-path src-tauri/Cargo.toml
    npx tsc --noEmit

For changes to how the app runs Claude, also go through the relevant parts of [docs/SMOKE_TEST.md](docs/SMOKE_TEST.md) with a built app.

Keep each pull request to one change. Commit subjects follow the existing history: a `feat:`, `fix:`, `style:`, `docs:`, `test:` or `chore:` prefix, then a plain sentence about what changes for the person using the app.

## Bugs and ideas

Open an issue on GitHub. For a bug, include your macOS version, `claude --version`, what you did, and what you expected to happen instead.
