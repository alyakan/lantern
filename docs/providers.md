# Provider architecture

Lantern owns conversations; providers own native sessions. Desktop and mobile use the same backend operations and capabilities.

- `conversations::Store` keeps private, atomic snapshots in the app's data directory. The conversation ID remains stable when its provider changes; `native_id` identifies the current CLI session. Messages, provider transitions, model/effort choices, and edit originals survive restart. Public events omit edit originals.
- `Session` accepts neutral text and image inputs. Each adapter encodes its own protocol, approvals, model/effort changes, and compaction. Clients never emulate Codex operations by sending Claude slash commands.
- `ConversationConfiguration` and `Capabilities` generate TypeScript types consumed by both clients. The `conversation` remote feature gates the new settings/action requests, so older Macs aren't sent unknown operations. Legacy controls remain readable.
- Provider changes require an idle, independent chat without background tasks. Lantern starts and checks the replacement adapter before stopping the old session. The new provider receives the beginning and recent end of long conversations as context (80,000 characters maximum); the full visible history remains available. Provider-native hidden reasoning and in-flight tool calls are not transferred.
- Claude's existing transcripts remain readable. Codex rollouts are discovered under `CODEX_HOME/sessions` (otherwise `~/.codex/sessions`); the live adapter supplies full native replay when opened. History, search, export, phone scrollback, and Desk also read the neutral archive.
- Discovery lists installed CLIs rather than requiring Claude. Endpoint providers still use Claude Code as their transport. Capabilities such as Auto, advisor presets, team leadership, images and thinking effort remain explicit; a provider isn't assumed to support a feature because another one does.

Adding a provider requires an adapter, capability declaration, native history importer (if applicable), and protocol tests. UI decisions should depend on capabilities, not on whether the provider's name is Claude.

Regression coverage includes Codex-only startup, switching a populated conversation, phone provider/model controls, native image delivery, protocol compaction, approval routing, stable IDs across restart, first-message ordering, history import/search, and private edit restoration. Real-device sign-in and provider responses still require a paired phone and installed, authenticated CLIs.
