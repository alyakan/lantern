# Lantern smoke test

Run against the built `Lantern.app` (launched from Finder, not a terminal, so PATH handling is exercised). Use a scratch git repo.

1. Launch: the app finds `claude` without a setup screen.
2. Open folder: the model name appears in the toolbar.
3. Ask: "Create notes.md with three bullet points." A Write card shows a green diff and `notes.md` shows in Changes.
4. Ask: "Change the second bullet." The Edit card shows red/green lines. Clicking `notes.md` in Changes shows a Monaco diff against the empty original (the file was created this session).
5. Ask mode: "Run `python3 -c 'print(7)'`." An Allow/Deny card appears. Deny: Claude reports it was denied. Repeat and Allow: the output `7` is visible when you expand the Bash card.
6. While an Allow/Deny card is pending, switch to Auto: the card shows Denied, the session restarts, and the conversation continues (ask "what did I ask you before?").
7. Auto mode: "Run `ls`." No prompt appears.
8. Stop: ask for a long task, press Stop. The turn ends and the input unlocks. If a "Session ended" banner shows up, the app restarts the session by itself.
9. Crash recovery: in a terminal, `pkill -f "claude -p --input-format stream-json"`. A "Claude stopped unexpectedly" banner appears; Restart session resumes and remembers earlier messages.
10. Subagent: "Use a subagent to list the files here." A Task card appears; expanding it shows the nested steps.
11. Huge output: "Run `seq 1 100000`." The card output ends with `…` and the UI stays responsive.
12. Before the first message: the input is enabled right after opening a folder, and switching Ask/Auto right after opening works.
13. Press Stop mid-turn while an Allow/Deny card is pending. The card shows Denied, and the next prompt still works.
14. With the app launched from Finder, a hook or MCP server that needs Homebrew or Node works.
15. Memory: Activity Monitor shows the Lantern process (plus its WebContent process) well under Electron-class usage (roughly 150+ MB); note the numbers here.
