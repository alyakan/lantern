import { describe, expect, it } from "vitest";
import { hasPendingPrompt, initialState, reducer, type State, type ToolItem } from "./store";
import { chatState, firstPrompt, isBusy } from "./sessions";
import type { UiEvent } from "./types";

const ev = (state: State, event: UiEvent) => reducer(state, { type: "ui_event", event });
const running: State = { ...initialState, status: "running", folder: "/p", claudePath: "/c" };
const tool = (id: string, name = "Bash", parent: string | null = null): UiEvent => ({ kind: "tool_started", parent, tool_use_id: id, name, summary: "x" });

describe("reducer", () => {
  it("leaves the chat as it is for an event it doesn't know, instead of losing it", () => {
    const s = { ...initialState, status: "idle" as const };
    expect(reducer(s, { type: "ui_event", event: { kind: "offstream", tool_use_id: "x" } as unknown as UiEvent })).toBe(s);
  });


  it("user_sent adds a user item, stamped with when, and marks running", () => {
    const before = Date.now();
    const s = reducer({ ...initialState, status: "idle" }, { type: "user_sent", text: "hi" });
    expect(s.status).toBe("running");
    expect(s.items).toEqual([{ type: "user", id: "u1", text: "hi", at: expect.any(Number) }]);
    expect((s.items[0] as { at: number }).at).toBeGreaterThanOrEqual(before);
  });

  it("keeps the box's draft on a sent message, so Edit can bring its paste placeholders back", () => {
    const s = reducer({ ...initialState, status: "idle" }, { type: "user_sent", text: "hi", draft: "[Pasted text #1 · 9 lines]" });
    expect(s.items[0]).toMatchObject({ type: "user", text: "hi", draft: "[Pasted text #1 · 9 lines]" });
  });

  it("keeps what each turn cost and used, and the session's running totals", () => {
    const s = ev(running, { kind: "turn_done", is_error: false, result: null, cost_usd: 0.04, tokens: 12_000, session_cost_usd: 0.9, session_tokens: 400_000, duration_ms: 1000, auth_hint: false, denied: 0, context_window: null });
    expect(s.items[s.items.length - 1]).toMatchObject({ type: "turn", cost: 0.04, tokens: 12_000 });
    expect(s).toMatchObject({ sessionCost: 0.9, sessionTokens: 400_000 });
  });

  it("keeps the background task list, with when each one started", () => {
    const ev = (tasks: { id: string; task_type: string; description: string }[]) => ({ type: "ui_event" as const, event: { kind: "background_tasks" as const, tasks } });
    const dev = { id: "b1", task_type: "local_bash", description: "npm run dev" };
    let s = reducer({ ...initialState, status: "idle" }, ev([dev]));
    expect(s.backgroundTasks).toEqual([{ id: "b1", taskType: "local_bash", description: "npm run dev", since: expect.any(Number) }]);
    // A task listed again keeps when it started; a new one starts now.
    s = { ...s, backgroundTasks: [{ ...s.backgroundTasks[0], since: 1 }] };
    s = reducer(s, ev([dev, { id: "a2", task_type: "local_agent", description: "Search the docs" }]));
    expect(s.backgroundTasks.map((t) => [t.id, t.since > 1])).toEqual([["b1", false], ["a2", true]]);
    expect(reducer(s, ev([])).backgroundTasks).toEqual([]);
    expect(reducer(s, { type: "ui_event", event: { kind: "session_ended", code: 1, stderr_tail: "" } }).backgroundTasks).toEqual([]);
  });

  it("remembers which step started a background task, and how it ended", () => {
    let s = reducer({ ...initialState, status: "idle" }, { type: "ui_event", event: { kind: "task_started", task_id: "b1", tool_use_id: "toolu_1" } });
    expect(s.backgroundRuns).toEqual({ toolu_1: { status: "running" } });
    s = reducer(s, { type: "ui_event", event: { kind: "task_ended", task_id: "b1", tool_use_id: "toolu_1", status: "completed", summary: "done (exit code 0)" } });
    expect(s.backgroundRuns.toolu_1).toEqual({ status: "completed", summary: "done (exit code 0)" });
  });

  it("a reply with no prompt (a background task ended) makes the chat busy until its turn ends, opened by a note", () => {
    const tasks = (list: { id: string; task_type: string; description: string }[]) => ({ type: "ui_event" as const, event: { kind: "background_tasks" as const, tasks: list } });
    let s = reducer({ ...initialState, status: "idle" }, tasks([{ id: "b1", task_type: "local_bash", description: "npx vitest --watch" }]));
    s = reducer(s, tasks([]));
    s = reducer(s, { type: "ui_event", event: { kind: "text_delta", parent: null, block_id: "m:0", text: "It finished." } });
    expect(s.status).toBe("running");
    expect(s.items[0]).toEqual({ type: "user", id: expect.any(String), text: "After npx vitest --watch ended", at: expect.any(Number), auto: true });
    expect(s.items[1]).toMatchObject({ type: "assistant", text: "It finished." });
    s = reducer(s, { type: "ui_event", event: { kind: "turn_done", is_error: false, result: null, cost_usd: null, duration_ms: 1, auth_hint: false, denied: 0, context_window: null } });
    expect(s.status).toBe("idle");
  });

  it("text deltas accumulate and the final text replaces them", () => {
    let s = ev(running, { kind: "text_delta", parent: null, block_id: "m:1", text: "Hel" });
    s = ev(s, { kind: "text_delta", parent: null, block_id: "m:1", text: "lo" });
    expect(s.items).toEqual([{ type: "assistant", id: "m:1", text: "Hello" }]);
    s = ev(s, { kind: "assistant_text", parent: null, block_id: "m:1", text: "Hello!" });
    expect(s.items).toEqual([{ type: "assistant", id: "m:1", text: "Hello!" }]);
  });

  it("keeps every item a word or a step didn't change as the same object, so the chat draws only what changed", () => {
    let s = ev(running, tool("t1", "Read"));
    s = ev(s, { kind: "tool_finished", parent: null, tool_use_id: "t1", is_error: false, output: "ok" });
    s = ev(s, tool("t2", "Task"));
    s = ev(s, tool("t3", "Bash", "t2"));
    s = ev(s, { kind: "text_delta", parent: null, block_id: "m:1", text: "Hel" });
    const [read, task, message] = s.items;
    s = ev(s, { kind: "text_delta", parent: null, block_id: "m:1", text: "lo" });
    expect(s.items[0]).toBe(read);
    expect(s.items[1]).toBe(task);
    expect(s.items[2]).not.toBe(message);
    expect(s.items[2]).toMatchObject({ text: "Hello" });
    // A step finishing inside a subagent: that step and the one it is in are new, the rest are not.
    const before = s.items;
    s = ev(s, { kind: "tool_finished", parent: "t2", tool_use_id: "t3", is_error: false, output: "done" });
    expect(s.items[0]).toBe(before[0]);
    expect(s.items[1]).not.toBe(before[1]);
    expect((s.items[1] as ToolItem).children[0]).toMatchObject({ id: "t3", status: "done" });
    expect(s.items[2]).toBe(before[2]);
    // A step it doesn't have changes nothing.
    expect(ev(s, { kind: "tool_finished", parent: null, tool_use_id: "nope", is_error: false, output: "" }).items).toBe(s.items);
  });

  it("says whether a prompt is waiting, again for each new list of items", () => {
    const asked = ev(running, { kind: "permission_requested", request_id: "r1", tool_name: "Bash", input: { command: "ls" } });
    expect(hasPendingPrompt(asked.items)).toBe(true);
    expect(hasPendingPrompt(asked.items)).toBe(true);
    const answered = reducer(asked, { type: "permission_decided", id: "r1", allow: true });
    expect(answered.items).not.toBe(asked.items);
    expect(hasPendingPrompt(answered.items)).toBe(false);
    expect(hasPendingPrompt(running.items)).toBe(false);
  });

  it("nests subagent tools under their parent", () => {
    let s = ev(running, tool("toolu_task", "Task"));
    s = ev(s, tool("toolu_sub", "Bash", "toolu_task"));
    expect(s.items).toHaveLength(1);
    expect((s.items[0] as ToolItem).children.map((c) => c.id)).toEqual(["toolu_sub"]);
    s = ev(s, { kind: "tool_finished", parent: "toolu_task", tool_use_id: "toolu_sub", is_error: false, output: "ok" });
    expect(((s.items[0] as ToolItem).children[0] as ToolItem).status).toBe("done");
  });

  it("edit_applied_lists_file_once", () => {
    const hunks = [{ old_start: 1, old_lines: 1, new_start: 1, new_lines: 1, lines: ["-a", "+b"] }];
    let s = ev(running, tool("e1", "Edit"));
    s = ev(s, { kind: "edit_applied", parent: null, tool_use_id: "e1", path: "/p/a.ts", created: false, hunks });
    s = ev(s, tool("e2", "Edit"));
    s = ev(s, { kind: "edit_applied", parent: null, tool_use_id: "e2", path: "/p/a.ts", created: false, hunks });
    expect(s.changedFiles).toEqual([{ path: "/p/a.ts", created: false, added: 2, removed: 2 }]);
    expect(s.editCount).toBe(2);
    expect((s.items[0] as ToolItem).edit?.path).toBe("/p/a.ts");
  });

  const edit = (s: State, id: string, path: string, created = false) =>
    ev(ev(s, tool(id, "Edit")), { kind: "edit_applied", parent: null, tool_use_id: id, path, created, hunks: [{ old_start: 1, old_lines: 0, new_start: 1, new_lines: 1, lines: ["+x"] }] });

  it("a file stays created once any edit created it", () => {
    let s = edit(running, "e1", "/p/n.ts", true);
    s = edit(s, "e2", "/p/n.ts");
    expect(s.changedFiles[0]).toMatchObject({ created: true, added: 2 });
  });

  it("follows the latest edit until the user selects a file", () => {
    let s = edit(running, "e1", "/p/a.ts");
    expect(s.selectedFile).toBe("/p/a.ts");
    s = edit(s, "e2", "/p/b.ts");
    expect(s.selectedFile).toBe("/p/b.ts");
    s = reducer(s, { type: "select_file", path: "/p/a.ts" });
    expect(s.follow).toBe(false);
    s = edit(s, "e3", "/p/c.ts");
    expect(s.selectedFile).toBe("/p/a.ts");
    s = reducer(s, { type: "follow_latest" });
    expect(s).toMatchObject({ follow: true, selectedFile: "/p/c.ts" });
  });

  it("turn_done with auth_hint shows the login banner", () => {
    const s = ev(running, { kind: "turn_done", is_error: true, result: "Please run /login", cost_usd: null, duration_ms: 10, auth_hint: true, denied: 0, context_window: null });
    expect(s.status).toBe("idle");
    expect(s.banner?.kind).toBe("auth");
    expect(s.items[s.items.length - 1]).toMatchObject({ type: "turn", isError: true, result: "Please run /login" });
  });

  it("keeps the slash commands claude offers, and /clear empties the chat back to the start screen", () => {
    let s = ev(running, { kind: "commands", commands: [{ name: "compact", description: "Summarize", argument_hint: "" }] });
    expect(s.commands.map((c) => c.name)).toEqual(["compact"]);
    s = reducer(s, { type: "user_sent", text: "/clear" });
    s = ev(s, { kind: "conversation_reset" });
    s = ev(s, { kind: "turn_done", is_error: false, result: "", cost_usd: null, duration_ms: 1, auth_hint: false, denied: 0, context_window: null });
    expect(s).toMatchObject({ items: [], status: "idle", sessionId: null, cleared: false });
    // The next turn is marked as usual.
    s = reducer(s, { type: "user_sent", text: "hi" });
    s = ev(s, { kind: "turn_done", is_error: false, result: "ok", cost_usd: null, duration_ms: 1, auth_hint: false, denied: 0, context_window: null });
    expect(s.items.map((i) => i.type)).toEqual(["user", "turn"]);
  });

  it("syncs the changed files with the disk: true counts, reverted files gone, order kept", () => {
    const hunks = [{ old_start: 1, old_lines: 1, new_start: 1, new_lines: 1, lines: ["-a", "+b"] }];
    let s = ev(running, { kind: "edit_applied", parent: null, tool_use_id: "e1", path: "/p/a.ts", created: false, hunks });
    s = ev(s, { kind: "edit_applied", parent: null, tool_use_id: "e2", path: "/p/scratch.txt", created: true, hunks });
    s = ev(s, { kind: "edit_applied", parent: null, tool_use_id: "e3", path: "/p/b.ts", created: false, hunks });
    expect(s.selectedFile).toBe("/p/b.ts");
    // scratch.txt was deleted again by a shell command; b.ts was reverted with git; a.ts grew.
    s = reducer(s, { type: "changes_synced", files: [{ path: "/p/a.ts", created: false, deleted: false, added: 5, removed: 1 }] });
    expect(s.changedFiles).toEqual([{ path: "/p/a.ts", created: false, deleted: false, added: 5, removed: 1 }]);
    expect(s.selectedFile).toBe("/p/a.ts");
    // Nothing new: the same state comes back, so nothing re-renders.
    expect(reducer(s, { type: "changes_synced", files: [{ path: "/p/a.ts", created: false, deleted: false, added: 5, removed: 1 }] })).toBe(s);
  });

  it("doesn't list the plan file plan mode writes as a project change", () => {
    const hunks = [{ old_start: 0, old_lines: 0, new_start: 1, new_lines: 1, lines: ["+# Plan"] }];
    let s = ev(running, { kind: "edit_applied", parent: null, tool_use_id: "w1", path: "/Users/me/.claude/plans/plan-humble-axolotl.md", created: true, hunks });
    expect(s.changedFiles).toEqual([]);
    s = ev(s, { kind: "edit_applied", parent: null, tool_use_id: "w2", path: "/p/src/a.ts", created: true, hunks });
    expect(s.changedFiles.map((f) => f.path)).toEqual(["/p/src/a.ts"]);
  });

  it("tracks context use; the window survives a new session but the use does not", () => {
    let s = ev(running, { kind: "context_used", tokens: 37_187 });
    s = ev(s, { kind: "turn_done", is_error: false, result: "ok", cost_usd: null, duration_ms: 5, auth_hint: false, denied: 0, context_window: 200_000 });
    expect(s).toMatchObject({ contextUsed: 37_187, contextWindow: 200_000 });
    s = ev(s, { kind: "turn_done", is_error: false, result: "ok", cost_usd: null, duration_ms: 5, auth_hint: false, denied: 0, context_window: null });
    expect(s.contextWindow).toBe(200_000);
    s = reducer(s, { type: "folder_opened", folder: "/q" });
    expect(s).toMatchObject({ contextUsed: null, contextWindow: 200_000 });
  });

  it("a new folder forgets the last background task, a Stop and a /clear from the one before", () => {
    const s = reducer({ ...running, lastEndedTask: "npm run dev", stopRequested: true, cleared: true }, { type: "folder_opened", folder: "/q" });
    expect(s).toMatchObject({ lastEndedTask: null, stopRequested: false, cleared: false });
  });

  it("an interrupted turn after Stop reads as stopped, not as an error, and the session stays usable", () => {
    let s = reducer(running, { type: "stop_requested" });
    s = ev(s, { kind: "turn_done", is_error: true, result: null, cost_usd: null, duration_ms: 5, auth_hint: false, denied: 0, context_window: null });
    expect(s.status).toBe("idle");
    expect(s.banner).toBeNull();
    expect(s.items[s.items.length - 1]).toMatchObject({ type: "turn", isError: false, stopped: true });
    s = reducer(s, { type: "user_sent", text: "next" });
    expect(s.stopRequested).toBe(false);
  });

  it("a command replayed as still running is unknown, not done", () => {
    const sent = "<bash-input>tail -f app.log</bash-input>\n<bash-stdout>ready\n[still running]</bash-stdout><bash-stderr></bash-stderr>\n\nwhat happened?";
    const s = ev(initialState, { kind: "user_text", text: sent });
    expect(s.items[0]).toMatchObject({ type: "shell", command: "tail -f app.log", status: "unknown", code: null });
  });

  it("a message replayed with Lantern's notes shows as it was typed, and keeps the flavour it switched to", () => {
    const page = '[Lantern: your last message began "## Review · x", which isn\'t one of Review\'s headings, so it wasn\'t shown as a page. (end of Lantern\'s note)]';
    const flavour = '[Lantern: this chat switched to Architecture. The user picked it. How Architecture works:\n\n{"nodes": [{"id": "a"}]}\n\n(end of Lantern\'s note)]';
    const s = ev(initialState, { kind: "user_text", text: `${page}\n\n${flavour}\n\nmap it` });
    expect(s.items[0]).toMatchObject({ type: "user", text: "map it", switchedTo: "architecture" });
  });

  it("a message sent from a paired phone shows in the chat, and Claude is working on it", () => {
    const s = ev({ ...initialState, status: "idle" }, { kind: "user_text", text: "ship it", at: 5, sent_by: "phone-1" });
    expect(s.items[0]).toMatchObject({ type: "user", text: "ship it", at: 5 });
    expect(s).toMatchObject({ status: "running", thinking: true });
    // A replayed message (no sender) doesn't start anything.
    expect(ev({ ...initialState, status: "idle" }, { kind: "user_text", text: "old" }).status).toBe("idle");
  });

  it("a post-hook is a note of Lantern's own, not a prompt, whether it was sent now or replayed", () => {
    const sent = ev({ ...initialState, status: "running" }, { kind: "user_text", text: "[Lantern post-hook]\nUpdate the brain if needed", at: 9, sent_by: "lantern" });
    expect(sent.items[0]).toMatchObject({ type: "user", text: "Post-hook: Update the brain if needed", auto: true, at: 9 });
    expect(sent).toMatchObject({ status: "running", thinking: true });
    // Replayed (no sender): shown the same, and it starts nothing.
    const replayed = ev({ ...initialState, status: "idle" }, { kind: "user_text", text: "[Lantern post-hook]\nUpdate the brain if needed" });
    expect(replayed.items[0]).toMatchObject({ type: "user", text: "Post-hook: Update the brain if needed", auto: true });
    expect(replayed.status).toBe("idle");
    // It is never a chat's first prompt, so it names nothing.
    expect(firstPrompt(replayed)).toBeNull();
  });

  it("a compaction is Lantern's bookkeeping: the chat shows nothing of it", () => {
    const s = { ...initialState, status: "running" as const };
    expect(ev(s, { kind: "compacted" })).toEqual(s);
  });

  it("a phone's message with photos says how many, and photos alone are still a message", () => {
    const s = ev({ ...initialState, status: "idle" }, { kind: "user_text", text: "what is this?", at: 5, sent_by: "phone-1", images: 2 });
    expect(s.items[0]).toMatchObject({ type: "user", text: "what is this?", images: 2 });
    const alone = ev({ ...initialState, status: "idle" }, { kind: "user_text", text: "", at: 6, sent_by: "phone-1", images: 1 });
    expect(alone.items[0]).toMatchObject({ type: "user", text: "", images: 1 });
    expect(alone).toMatchObject({ status: "running", thinking: true });
    // A message with none carries no count.
    expect(ev(initialState, { kind: "user_text", text: "hi", sent_by: "phone-1" }).items[0]).not.toHaveProperty("images");
  });

  it("a prompt answered on a phone first closes its card here with that answer, and one answered here stays as it was", () => {
    let s = ev(initialState, { kind: "permission_requested", request_id: "p1", tool_name: "Bash", input: {} });
    s = ev(s, { kind: "permission_resolved", request_id: "p1", allow: false, by: "phone-1" });
    expect(s.items[0]).toMatchObject({ type: "permission", id: "p1", decision: "denied" });
    s = ev(s, { kind: "permission_requested", request_id: "p2", tool_name: "Bash", input: {} });
    s = reducer(s, { type: "permission_decided", id: "p2", allow: true });
    s = ev(s, { kind: "permission_resolved", request_id: "p2", allow: true, by: "desktop" });
    expect(s.items[1]).toMatchObject({ id: "p2", decision: "allowed" });
  });

  it("a message replayed after a Workflow change shows without the backend's settings note, before a flavour note or alone", () => {
    // The note repeats the whole new prompt, which mentions other notes and brackets of its own.
    const settings = "[Lantern: this chat's Permissions or Workflow changed, and Claude was restarted on the same conversation. From here on:\n\nA message that starts with \"[Lantern: this chat switched to <Flavour>…]\" means …\n\n(end of Lantern's note)]";
    const flavour = "[Lantern: this chat switched to Debug. The user picked it.]";
    expect(ev(initialState, { kind: "user_text", text: `${settings}\n\n${flavour}\n\nit crashes` }).items[0]).toMatchObject({ type: "user", text: "it crashes", switchedTo: "debug" });
    expect(ev(initialState, { kind: "user_text", text: `${settings}\n\nbuild it` }).items[0]).toMatchObject({ type: "user", text: "build it" });
    expect(ev(initialState, { kind: "user_text", text: "[Lantern: something else]\n\nhi" }).items[0]).toMatchObject({ text: "[Lantern: something else]\n\nhi" });
  });

  it("a message replayed from a Learn (or explaining) chat is Build with Explain as you go on, and keeps it when sent", () => {
    const old = ev(initialState, { kind: "user_text", text: "[Lantern: this chat switched to Learn. The user picked it. How Learn works:\n\nLearn: …\n\n(end of Lantern's note)]\n\nteach me" });
    expect(old.items[0]).toMatchObject({ type: "user", text: "teach me", switchedTo: "build", explained: true });
    const noted = ev(initialState, { kind: "user_text", text: "[Lantern: this chat switched to Debug, explaining as you go. The user picked it.]\n\nit crashes" });
    expect(noted.items[0]).toMatchObject({ switchedTo: "debug", explained: true });
    const plain = ev(initialState, { kind: "user_text", text: "[Lantern: this chat switched to Debug. The user picked it.]\n\nit crashes" });
    expect(plain.items[0]).not.toHaveProperty("explained");
    // Sent from the box: the pick (and its option) is used up with the message.
    let t = reducer(initialState, { type: "flavour_picked", flavour: "build", explain: true });
    expect(t).toMatchObject({ flavourPick: "build", explainPick: true });
    t = reducer(t, { type: "user_sent", text: "go", switchedTo: "build", explained: true });
    expect(t).toMatchObject({ flavourPick: null, explainPick: false });
    expect(t.items[0]).toMatchObject({ switchedTo: "build", explained: true });
    // Taking the pick back takes the option with it.
    expect(reducer(reducer(initialState, { type: "flavour_picked", flavour: "build", explain: true }), { type: "flavour_picked", flavour: null })).toMatchObject({ flavourPick: null, explainPick: false });
  });

  it("turn_done clears a retry banner", () => {
    let s = ev(running, { kind: "retrying", attempt: 1, max_retries: 10, error: "overloaded" });
    expect(s.banner?.kind).toBe("info");
    s = ev(s, { kind: "turn_done", is_error: false, result: "ok", cost_usd: null, duration_ms: 5, auth_hint: false, denied: 0, context_window: null });
    expect(s.banner).toBeNull();
  });

  it("session_ended unexpectedly offers restart and fails running tools", () => {
    let s = ev(running, tool("t1"));
    s = ev(s, { kind: "session_ended", code: 1, stderr_tail: "warn\nfatal: boom\n" });
    expect(s.status).toBe("ended");
    expect(s.banner).toEqual({ kind: "error", text: "Claude stopped unexpectedly (exit code 1). fatal: boom", action: "restart" });
    expect((s.items[0] as ToolItem).status).toBe("error");
  });

  it("session_ended denies the permission still waiting, so the chat isn't left waiting or busy", () => {
    let s = ev(running, { kind: "permission_requested", request_id: "perm-1", tool_name: "Bash", input: { command: "ls" } });
    s = ev(s, { kind: "session_ended", code: 1, stderr_tail: "" });
    expect(s.items[0]).toMatchObject({ type: "permission", decision: "denied" });
    expect(isBusy(s)).toBe(false);
    expect(chatState(s)).toBe("done");
  });

  it("a failed call keeps the status of the chat; a start that failed ends with a restart to try again", () => {
    expect(reducer(running, { type: "failed", text: "model change refused" })).toMatchObject({ status: "running", banner: { kind: "error", action: null } });
    const starting = { ...initialState, status: "starting" as const };
    expect(reducer(starting, { type: "failed", text: "no claude" })).toMatchObject({ status: "ended", banner: { kind: "error", text: "no claude", action: "restart" } });
  });

  it("a message or answer that didn't reach claude ends the chat, and denies what was waiting", () => {
    let s = ev(running, { kind: "permission_requested", request_id: "perm-1", tool_name: "Bash", input: { command: "ls" } });
    s = reducer(s, { type: "turn_failed", text: "broken pipe" });
    expect(s).toMatchObject({ status: "ended", banner: { kind: "error", action: "restart" } });
    expect(s.items[0]).toMatchObject({ type: "permission", decision: "denied" });
  });

  it("a Stop that didn't reach claude isn't recorded as stopped", () => {
    let s = reducer(running, { type: "stop_requested" });
    s = reducer(s, { type: "stop_failed", text: "interrupt failed" });
    expect(s).toMatchObject({ status: "running", stopRequested: false, banner: { kind: "error", text: "interrupt failed" } });
  });

  it("session_ended after Stop shows no banner", () => {
    let s = reducer(running, { type: "stop_requested" });
    s = ev(s, { kind: "session_ended", code: null, stderr_tail: "" });
    expect(s.status).toBe("ended");
    expect(s.banner).toBeNull();
  });

  it("restarting denies undecided permission cards", () => {
    let s = ev(running, { kind: "permission_requested", request_id: "perm-1", tool_name: "Bash", input: { command: "ls" } });
    s = reducer(s, { type: "restarting" });
    expect(s.items[0]).toMatchObject({ type: "permission", decision: "denied" });
    expect(s.status).toBe("starting");
    s = ev(s, { kind: "session_started", session_id: "x", model: "m", cwd: "/p", permission_mode: "auto", claude_version: "2" });
    expect(s.status).toBe("idle");
    expect(s.model).toBe("m");
  });

  it("folder_opened resets the conversation", () => {
    const s = reducer(
      { ...running, items: [{ type: "user", id: "u1", text: "x" }], changedFiles: [{ path: "/p/a", created: false, added: 1, removed: 0 }], follow: false },
      { type: "folder_opened", folder: "/q" },
    );
    expect(s).toMatchObject({ folder: "/q", status: "starting", items: [], changedFiles: [], selectedFile: null, lastEdited: null, follow: true });
  });

  it("a withdrawn prompt is denied, and only the one that was withdrawn", () => {
    let s = ev(running, { kind: "permission_requested", request_id: "perm-1", tool_name: "Bash", input: {} });
    s = ev(s, { kind: "permission_requested", request_id: "perm-2", tool_name: "Bash", input: {} });
    s = ev(s, { kind: "permission_withdrawn", request_id: "perm-1" });
    expect(s.items.map((it) => (it.type === "permission" ? it.decision : null))).toEqual(["denied", null]);
  });

  it("a request a rule allowed is a decided card that says which rule, and is never waiting", () => {
    const rule = { tool: "Bash", kind: "prefix" as const, text: "npm test" };
    const s = ev(running, { kind: "permission_auto_allowed", request_id: "perm-1", tool_name: "Bash", input: { command: "npm test" }, scope: "chat", rule });
    expect(s.items[0]).toMatchObject({ type: "permission", id: "perm-1", decision: "allowed", autoRule: { scope: "chat", rule } });
    expect(s.status).not.toBe("waiting");
    expect(s.items.some((it) => it.type === "permission" && it.decision === null)).toBe(false);
  });

  it("stop_requested denies undecided permission cards", () => {
    let s = ev(running, { kind: "permission_requested", request_id: "perm-1", tool_name: "Bash", input: {} });
    s = reducer(s, { type: "stop_requested" });
    expect(s.items[0]).toMatchObject({ type: "permission", decision: "denied" });
    expect(s.stopRequested).toBe(true);
  });

  it("stop_requested then turn_done then session_ended keeps stopRequested and shows no banner", () => {
    let s = reducer(running, { type: "stop_requested" });
    s = ev(s, { kind: "turn_done", is_error: true, result: "interrupted", cost_usd: null, duration_ms: 1, auth_hint: false, denied: 0, context_window: null });
    expect(s.stopRequested).toBe(true);
    s = ev(s, { kind: "session_ended", code: null, stderr_tail: "" });
    expect(s.status).toBe("ended");
    expect(s.banner).toBeNull();
    expect(s.stopRequested).toBe(true);
  });

  it("user_sent clears stopRequested", () => {
    const s = reducer({ ...running, status: "idle", stopRequested: true }, { type: "user_sent", text: "hi" });
    expect(s.stopRequested).toBe(false);
  });

  it("session_ready moves starting to idle", () => {
    const s = reducer({ ...running, status: "starting" }, { type: "session_ready" });
    expect(s.status).toBe("idle");
  });

  it("session_ready leaves running unchanged", () => {
    expect(reducer(running, { type: "session_ready" }).status).toBe("running");
  });

  it("folder_opened then session_ready is idle without session_started", () => {
    let s = reducer(running, { type: "folder_opened", folder: "/q" });
    s = reducer(s, { type: "session_ready" });
    expect(s.status).toBe("idle");
  });

  it("session_started records the session id", () => {
    const s = ev(running, { kind: "session_started", session_id: "s-1", model: "m", cwd: "/p", permission_mode: "ask", claude_version: "2" });
    expect(s.sessionId).toBe("s-1");
  });

  it("history_loaded replaces the conversation with the replayed session", () => {
    const old = ev({ ...running, status: "idle", items: [{ type: "user", id: "u9", text: "old" }] }, tool("old"));
    const hunks = [{ old_start: 1, old_lines: 1, new_start: 1, new_lines: 1, lines: ["-a", "+b"] }];
    const s = reducer(old, {
      type: "history_loaded",
      sessionId: "past-1",
      events: [
        { kind: "user_text", text: "Add retries" },
        { kind: "assistant_text", parent: null, block_id: "b1", text: "On it." },
        tool("e1", "Edit"),
        { kind: "edit_applied", parent: null, tool_use_id: "e1", path: "/p/retry.ts", created: false, hunks },
        tool("t2"),
      ],
    });
    expect(s.sessionId).toBe("past-1");
    expect(s.status).toBe("starting");
    expect(s.items.map((i) => i.type)).toEqual(["user", "assistant", "tool", "tool"]);
    expect(s.items[0]).toMatchObject({ type: "user", text: "Add retries" });
    expect(s.changedFiles).toEqual([{ path: "/p/retry.ts", created: false, added: 1, removed: 1 }]);
    expect(s.selectedFile).toBe("/p/retry.ts");
    expect((s.items[3] as ToolItem).status).toBe("done");
    expect(s.folder).toBe("/p");
    expect(reducer(s, { type: "session_ready" }).status).toBe("idle");
  });

  it("folder_cleared goes back to the open-folder screen", () => {
    const s = reducer({ ...running, status: "starting", folder: "/gone" }, { type: "folder_cleared" });
    expect(s).toMatchObject({ status: "no_folder", folder: null, banner: null });
  });

  it("folder_opened clears the session id", () => {
    expect(reducer({ ...running, sessionId: "s" }, { type: "folder_opened", folder: "/q" }).sessionId).toBeNull();
  });

  it("keeps what review_target set the Changes pane to, until the conversation starts over", () => {
    let s = ev(running, { kind: "review_target", pr: 512, base: null });
    expect(s.reviewTarget).toEqual({ pr: 512, base: null });
    s = ev(s, { kind: "review_target", pr: null, base: "feat/core" });
    expect(s.reviewTarget).toEqual({ pr: null, base: "feat/core" });
    expect(s.items).toEqual([]);
    expect(ev(s, { kind: "conversation_reset" }).reviewTarget).toBeNull();
    expect(reducer(s, { type: "folder_opened", folder: "/q" }).reviewTarget).toBeNull();
  });

  it("unknown events and parse errors go to debug, not the chat", () => {
    let s = ev(running, { kind: "unknown", raw: { type: "new" } });
    s = ev(s, { kind: "parse_error", line: "garbage" });
    expect(s.items).toEqual([]);
    expect(s.debug).toEqual(['{"type":"new"}', "garbage"]);
  });
});

describe("test runs", () => {
  const testRun = (id: string, failed: number): UiEvent => ({
    kind: "test_run",
    parent: null,
    tool_use_id: id,
    command: "npm test",
    run: { framework: "vitest", outcome: failed ? "failed" : "passed", passed: 3, failed, skipped: 0, duration_ms: 10, cases: [], tail: "" },
  });

  it("keeps each run once, in order, and a new folder starts without them", () => {
    let s: State = { ...initialState, folder: "/p", status: "idle" };
    s = reducer(s, { type: "ui_event", event: testRun("t1", 1) });
    s = reducer(s, { type: "ui_event", event: testRun("t2", 0) });
    s = reducer(s, { type: "ui_event", event: testRun("t1", 2) });
    expect(s.testRuns.map((r) => [r.id, r.run.failed])).toEqual([["t2", 0], ["t1", 2]]);
    expect(reducer(s, { type: "folder_opened", folder: "/q" }).testRuns).toEqual([]);
  });
});

describe("turn numbers", () => {
  it("numbers the latest prompt with the backend's turn, and a reopened session's last prompt as turn 0", () => {
    let s: State = { ...initialState, folder: "/p", status: "idle" };
    s = reducer(s, { type: "user_sent", text: "a" });
    s = reducer(s, { type: "turn_numbered", turn: 3 });
    expect(s.items[0]).toMatchObject({ type: "user", turn: 3 });
    const replayed = reducer(s, { type: "history_loaded", sessionId: "x", events: [{ kind: "user_text", text: "one" }, { kind: "user_text", text: "two" }] });
    expect(replayed.items.map((it) => (it.type === "user" ? it.turn : "-"))).toEqual([undefined, 0]);
  });
});

describe("Permissions and Workflow", () => {
  it("keeps Step by step's Permissions with the mode, and Auto and Ask say theirs with the mode itself", () => {
    let s: State = { ...initialState, folder: "/p", status: "idle" };
    s = reducer(s, { type: "mode_changed", mode: "steps", autoApprove: true });
    expect(s).toMatchObject({ mode: "steps", autoApprove: true });
    // A change that doesn't say keeps what Step by step had.
    expect(reducer(s, { type: "mode_changed", mode: "steps" }).autoApprove).toBe(true);
    // Out of Step by step, Auto is the mode; there is no auto-approve left over to come back.
    s = reducer(s, { type: "mode_changed", mode: "auto", autoApprove: false });
    expect(s).toMatchObject({ mode: "auto", autoApprove: false });
    expect(reducer(s, { type: "mode_changed", mode: "steps" }).autoApprove).toBe(false);
  });

  it("lowers an agent's Permissions to Ask when its Lead's are lower, auto-approve included", () => {
    const agent: State = { ...initialState, folder: "/wt", status: "idle", mode: "steps", autoApprove: true };
    expect(ev(agent, { kind: "agent_mode", mode: "ask" })).toMatchObject({ mode: "ask", autoApprove: false });
  });

  it("holds a team's Subagents setting on its Lead, on the canvas until the user says otherwise", () => {
    expect(initialState.subagents).toBe("canvas");
    expect(reducer(initialState, { type: "subagents_set", subagents: "inline" }).subagents).toBe("inline");
  });
});
