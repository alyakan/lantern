import { describe, expect, it } from "vitest";
import { initialState, reducer, type State, type ToolItem } from "./store";
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

  it("an interrupted turn after Stop reads as stopped, not as an error, and the session stays usable", () => {
    let s = reducer(running, { type: "stop_requested" });
    s = ev(s, { kind: "turn_done", is_error: true, result: null, cost_usd: null, duration_ms: 5, auth_hint: false, denied: 0, context_window: null });
    expect(s.status).toBe("idle");
    expect(s.banner).toBeNull();
    expect(s.items[s.items.length - 1]).toMatchObject({ type: "turn", isError: false, stopped: true });
    s = reducer(s, { type: "user_sent", text: "next" });
    expect(s.stopRequested).toBe(false);
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
