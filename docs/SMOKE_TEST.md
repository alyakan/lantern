# Lantern smoke test

Run against the built `Lantern.app` (launched from Finder, not a terminal, so PATH handling is exercised). Use a scratch git repo.

1. Launch: the app finds `claude` without a setup screen.
2. Open folder: the model name appears in the toolbar.
3. Ask: "Create notes.md with three bullet points." A Write card shows a green diff and `notes.md` shows in Changes.
4. Ask: "Change the second bullet." The Edit card shows red/green lines. Clicking `notes.md` in Changes shows a Monaco diff against the empty original (the file was created in this chat).
5. Permissions Ask: "Run `python3 -c 'print(7)'`." An Allow/Deny card appears. Deny: Claude reports it was denied. Repeat and Allow: the output `7` is visible when you expand the Bash card.
6. While an Allow/Deny card is pending, switch Permissions to Auto: the card shows Denied, the chat restarts, and the conversation continues (ask "what did I ask you before?").
7. Permissions Auto: "Run `ls`." No prompt appears.
8. Stop: ask for a long task, press Stop. The turn ends and the input unlocks. If a "Session ended" banner shows up, the app restarts the chat by itself.
9. Crash recovery: in a terminal, `pkill -f "claude -p --input-format stream-json"`. A "Claude stopped unexpectedly" banner appears; Restart chat resumes and remembers earlier messages.
10. Subagent: "Use a subagent to list the files here." A Task card appears; expanding it shows the nested steps.
11. Huge output: "Run `seq 1 100000`." The card output ends with `…` and the UI stays responsive.
12. Before the first message: the input is enabled right after opening a folder, and switching Permissions (Ask/Auto) and Workflow (Chat/Step by step/Team) right after opening works.
13. Press Stop mid-turn while an Allow/Deny card is pending. The card shows Denied, and the next prompt still works.

Teams (use a scratch git repo with at least one commit):

- Start a team (New ▾ ▸ Team in the sidebar, ⇧⌘N, or the Start a team card on an empty chat) asks nothing: the team's Lead starts on the project's last Permissions. The canvas shows one agent, the Lead, with Permissions and Workflow (Team) chips on its title bar, and a "Subagents: On the canvas" control. Choosing Team under Workflow in an ordinary chat does the same, on that conversation.
- Switch Permissions on the Lead's title bar: the Lead restarts and its agents (on their own title bars) follow, lowered to Ask if the Lead is on Ask. Switch Subagents to Inline: the Lead's built-in Agent tool now runs inline, with no card.
- Ask it: "Add a file a.txt in one agent and b.txt in another, each on its own branch." Two agents appear, tethered, each in a worktree under Lantern's app data (`~/Library/Application Support/…/worktrees`), each on a `lantern/…` branch. The Lead's chat names each agent it started.
- An agent that needs permission (on Ask) pulses amber, the pill says "1 agent needs you", and the prompt is in that agent's own window. Answering it there lets the worker carry on.
- Type to an agent directly. It answers; the Lead's next note mentions that you messaged it.
- When an agent finishes, the Lead gets a note and replies without you typing. When it asks to merge, the agent reads "Ready to merge". Approve merges its branch into the main checkout (check `git log`); a dirty main checkout says so and offers Try again; Not yet leaves it unmerged.
- Quit and reopen Lantern, then Restore all: the Lead and its agents come back as a team, with the tethers and the canvas, and the Lead can message them again.
- Pan, zoom and drag stay smooth with four agents streaming at once. Zoomed out, agents are cards and a click zooms in.
Sidebar:

- The left sidebar has a group per project: projects with a chat open first and expanded, the other recent folders folded. Open chats show a dot (orange while working, amber when they need you, blue when they finished while you were elsewhere); a chat that needs you is at the top of its group. Fold a project that has a waiting chat: its row shows a count and an amber dot.
- Click an open chat (switches), a past chat (resumes it, in its own project even when that isn't the one on screen), a team (opens its canvas) and one of its agents (focuses it). Agents are listed under their team only.
- Hover a project: **+** starts a chat there, **⋯** has New team, Bring old chats here…, Reveal in Finder (Finder opens on the folder) and Remove from recents (it goes; opening the folder again brings it back).
- **Show all…** opens that project's History: past chats only (the open ones are in the sidebar), with search, pin, rename, export. ⌘K opens History for the project on screen.
- **New ▾** has Chat (⌘N), Team (⇧⌘N) and Review a PR…. The title bar has no History clock, no New buttons and no "waiting" count.
- ⌃⌘S (View ▸ Show/Hide Sidebar) hides it completely: a Show sidebar button appears at the left of the title bar, badged with how many chats need you. Rest the pointer on the window's left edge: the sidebar slides in over the chat, and away when the pointer leaves it or on Esc; a click on a chat goes there and closes it. Drag the sidebar's edge to resize it; quit and reopen: the width and whether it was hidden are as left.
- With many projects, the first launch doesn't stall: a project's past chats are read only once it is expanded.

Starting work:

- An empty chat, in every Workflow, shows the start screen: the box, and cards for Build, Review a PR, Debug, Design and Start a team. Build, Debug and Design pick Step by step in that flavour (Build and Debug offer Explain as you go); Start a team makes the chat a Lead.
- Review a PR lists the repository's open pull requests (`gh pr list`); choosing one starts a Step by step Review on it. With `gh` missing or logged out, the list says so and a PR number can still be typed.
- The Work menu in the menu bar has the same five entries (Start a Team is ⇧⌘N), and so does the command palette.

14. With the app launched from Finder, a hook or MCP server that needs Homebrew or Node works.
15. Memory: Activity Monitor shows the Lantern process (plus its WebContent process) well under Electron-class usage (roughly 150+ MB); note the numbers here.
