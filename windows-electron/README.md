# Lantern for Windows (separate app)

**This folder is a different app from the Lantern in the rest of this repo.** It is a Windows
desktop app that shares the name and the idea, not the code. Nothing outside this folder uses it,
and it changes nothing in the Mac app.

|          | Lantern (repo root)                     | Lantern for Windows (this folder)                                    |
| -------- | --------------------------------------- | -------------------------------------------------------------------- |
| Platform | macOS                                   | Windows (11)                                                         |
| Built on | Tauri + React, written for Lantern      | Electron, a fork of [AionUi](https://github.com/iOfficeAI/AionUi)     |
| Agents   | Claude Code                             | Claude Code, Codex and a local model (Qwen on Ollama)                |
| Backend  | `src-tauri` (Rust)                      | AionCore, AionUi's separate Rust backend binary (not in this folder) |
| License  | MIT                                     | Apache-2.0 (see `LICENSE` and `NOTICE` here)                         |
| Releases | Signed `.dmg` from this repo's Releases | None yet; run from source                                            |

## What it does

- **Project board.** Every project under a projects folder is a frame; its modules (agents,
  services, tools) are cards. The frame is the project's operator: click it to chat with the
  operator, click a card to chat with that module. The chat opens in a side panel or full window.
- **Several agents, one app.** Claude Code, Codex and a local Qwen. A dispatcher suggests which
  one should take a task (cost, quality, speed), and a chat can be continued in another agent.
- **Pulse.** Session (5-hour) and weekly dials for Claude and Codex, the local model's VRAM, GPU
  load and a Game mode that frees the GPU.
- **Today.** A home screen with what needs you across projects, a daily intention and a weekly
  review.
- **Two looks.** Classic and HUD, each in light and dark. Ctrl+K palette for everything.

## Running it

Windows, Node 22 to 24, [bun](https://bun.sh), and the AionCore backend binary in
`%USERPROFILE%\cockpit-core\bin` (the dev script adds it to `PATH`). Ollama for the local model.
Then:

```powershell
bun install
.\scripts\cockpit-dev.ps1
```

The original AionUi readme is kept as [AIONUI-README.md](AIONUI-README.md). Its large demo GIFs
and videos (files over 1 MB in `resources/`) were left out of this copy to keep the repo small;
they are in the upstream AionUi repo. The `docs/cockpit/` design notes that `NOTICE` mentions are
personal planning notes and are not included either.

## Credits

Built on AionUi by iOfficeAI (Apache-2.0). Several features were modelled on Poracode; no Poracode
code is included. See `NOTICE`. Lantern is an independent project and is not affiliated with or
endorsed by Anthropic.
