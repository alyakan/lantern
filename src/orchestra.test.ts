import { describe, expect, it } from "vitest";
import { initialState, reducer, type Action, type State } from "./store";
import { chatsReducer, initialChats, WAKE_LIMIT, wakesPaused, wakesToSend, type Chats } from "./sessions";
import type { UiEvent } from "./types";

const main: State = { ...initialState, status: "idle", claudePath: "/bin/claude", mode: "ask", folder: "/p", contextWindow: 200_000, orchestrator: true, sessionId: "m1" };

const spawned: UiEvent = { kind: "agent_spawned", worker: "w1", name: "Login form", brief: "Build the login form", folder: "/wt/login-form", branch: "lantern/login-form", base: "main", isolation: "worktree", mode: "auto" };

const on = (slot: string, event: UiEvent) => ({ type: "in" as const, slot, action: { type: "ui_event" as const, event } });
const ev = (state: State, event: UiEvent) => reducer(state, { type: "ui_event", event });

function withWorker(): Chats {
  return chatsReducer(initialChats(main), on("s1", spawned));
}

describe("a worker the main agent starts", () => {
  it("opens as a chat of its own, already working on its brief, before any of its own events", () => {
    const c = withWorker();
    expect(Object.keys(c.slots)).toEqual(["s1", "w1"]);
    expect(c.slots.w1).toMatchObject({ folder: "/wt/login-form", mode: "auto", status: "running", thinking: true, claudePath: "/bin/claude", contextWindow: 200_000 });
    expect(c.slots.w1.items).toEqual([expect.objectContaining({ type: "user", text: "Build the login form", from: "main agent" })]);
    expect(c.agents.w1).toEqual({ parent: "s1", name: "Login form", brief: "Build the login form", folder: "/wt/login-form", branch: "lantern/login-form", base: "main", isolation: "worktree" });
    // The main agent's own chat gets no item for it.
    expect(c.slots.s1.items).toEqual([]);
    expect(c.active).toBe("s1");
  });

  it("starts in the mode the backend gave it, never assumed", () => {
    const c = chatsReducer(initialChats(main), on("s1", { ...spawned, mode: "ask" }));
    expect(c.slots.w1.mode).toBe("ask");
  });

  it("is not opened twice, and its first events land in it", () => {
    let c = withWorker();
    const again = chatsReducer(c, on("s1", spawned));
    expect(again).toBe(c);
    c = chatsReducer(c, on("w1", { kind: "session_started", session_id: "sess-w1", model: "m", cwd: "/wt/login-form", permission_mode: "auto", claude_version: "1" }));
    c = chatsReducer(c, on("w1", { kind: "assistant_text", parent: null, block_id: "b", text: "On it" }));
    expect(c.slots.w1.sessionId).toBe("sess-w1");
    expect(c.slots.w1.status).toBe("running");
    expect(c.slots.w1.items.map((i) => i.type)).toEqual(["user", "assistant"]);
  });

  it("is dropped from the agents when its chat is closed", () => {
    let c = withWorker();
    c = chatsReducer(c, { type: "remove", slot: "w1" });
    expect(c.slots.w1).toBeUndefined();
    expect(c.agents).toEqual({});
  });

  it("shows the main agent's later messages as from it, and is at work on them", () => {
    let w = ev({ ...main, orchestrator: false }, { kind: "agent_message", from: "main agent", text: "also add a test" });
    expect(w.items).toEqual([expect.objectContaining({ type: "user", text: "also add a test", from: "main agent" })]);
    expect(w).toMatchObject({ status: "running", thinking: true });
    // A worker already running just gets the message in its stream.
    w = ev({ ...main, status: "running", thinking: false }, { kind: "agent_message", from: "main agent", text: "x" });
    expect(w.status).toBe("running");
  });

  it("ends as stopped by the main agent, with a restart on offer, and never as a stop the app restarts on its own", () => {
    const stopped = ev({ ...main, status: "running", items: [{ type: "tool", id: "t", name: "Bash", summary: "", status: "running", output: null, edit: null, children: [] }] }, { kind: "agent_stopped", reason: null });
    expect(stopped.status).toBe("ended");
    expect(stopped.stopRequested).toBe(false); // App restarts an ended chat that has stopRequested
    expect(stopped.banner).toEqual({ kind: "info", text: expect.stringContaining("stopped this worker"), action: "restart" });
    expect(stopped.items[0]).toMatchObject({ status: "error" });
    const failed = ev(main, { kind: "agent_stopped", reason: "It didn't start: claude is not installed" });
    expect(failed.banner).toEqual({ kind: "error", text: "It didn't start: claude is not installed", action: null });
  });
});

describe("notes for the main agent", () => {
  it("collect on the main agent's chat and go out joined once it is idle", () => {
    let c = initialChats(main);
    c = chatsReducer(c, on("s1", { kind: "agent_wake", text: "[Lantern: worker \"a\" (w1) finished its turn: done]" }));
    c = chatsReducer(c, on("s1", { kind: "agent_wake", text: "[Lantern: worker \"b\" (w2) finished its turn: also done]" }));
    expect(wakesToSend(c.slots)).toEqual([{ slot: "s1", text: "[Lantern: worker \"a\" (w1) finished its turn: done]\n\n[Lantern: worker \"b\" (w2) finished its turn: also done]" }]);
  });

  it("wait while the main agent is busy, rather than interrupting or queueing behind the user's own messages", () => {
    const busy = ev({ ...main, status: "running" }, { kind: "agent_wake", text: "note" });
    expect(wakesToSend({ s1: busy })).toEqual([]);
    expect(wakesToSend({ s1: { ...busy, status: "idle" } })).toEqual([{ slot: "s1", text: "note" }]);
    for (const status of ["starting", "ended", "no_folder"] as const) expect(wakesToSend({ s1: { ...busy, status } })).toEqual([]);
  });

  it("are sent as an automatic turn, which the chat shows as a note and never as its title", () => {
    let s = ev(main, { kind: "agent_wake", text: "[Lantern: worker \"a\" (w1) finished its turn: done]" });
    s = reducer(reducer(s, { type: "wakes_taken" }), { type: "user_sent", text: "[Lantern: worker …]", auto: true });
    expect(s.wakes).toEqual([]);
    expect(s.autoStreak).toBe(1);
    expect(s.status).toBe("running");
    expect(s.items[0]).toMatchObject({ type: "user", auto: true });
  });

  it("stop after a run of automatic turns nobody watched, until the user writes", () => {
    let s: State = main;
    for (let i = 0; i < WAKE_LIMIT; i++) {
      s = ev({ ...s, status: "idle" }, { kind: "agent_wake", text: `note ${i}` });
      expect(wakesToSend({ s1: s })).toHaveLength(1);
      s = reducer(reducer(s, { type: "wakes_taken" }), { type: "user_sent", text: `note ${i}`, auto: true });
    }
    expect(s.autoStreak).toBe(WAKE_LIMIT);
    const held = ev({ ...s, status: "idle" }, { kind: "agent_wake", text: "one more" });
    expect(wakesToSend({ s1: held })).toEqual([]);
    expect(wakesPaused(held)).toBe(true);
    // The user speaking resets the count, and the held notes go out after that turn.
    const user = reducer(held, { type: "user_sent", text: "carry on" });
    expect(user.autoStreak).toBe(0);
    expect(wakesPaused({ ...user, status: "idle" })).toBe(false);
    expect(wakesToSend({ s1: { ...user, status: "idle" } })).toEqual([{ slot: "s1", text: "one more" }]);
  });

  it("are not paused when there is nothing waiting", () => {
    expect(wakesPaused({ ...main, autoStreak: WAKE_LIMIT })).toBe(false);
  });

  it("do not survive starting the chat over", () => {
    const s = ev(main, { kind: "agent_wake", text: "note" });
    const fresh = reducer(s, { type: "folder_opened", folder: "/other" });
    expect(fresh).toMatchObject({ wakes: [], autoStreak: 0, proposals: [], orchestrator: true });
  });
});

describe("merge proposals", () => {
  const proposed: UiEvent = { kind: "merge_proposed", worker: "w1", name: "Login form", branch: "lantern/login-form", into: "main", summary: "Adds the form", commits: 2, files: [{ path: "a.ts", added: 10, removed: 1 }], uncommitted: 0 };

  it("are kept on the main agent's chat, one per worker, newest proposal replacing an older one", () => {
    let s = ev(main, proposed);
    expect(s.proposals).toEqual([expect.objectContaining({ worker: "w1", branch: "lantern/login-form", status: "open", problem: null })]);
    s = ev(s, { ...proposed, summary: "Adds the form and its test", commits: 3 } as UiEvent);
    expect(s.proposals).toHaveLength(1);
    expect(s.proposals[0]).toMatchObject({ summary: "Adds the form and its test", commits: 3 });
  });

  it("close when merged or declined, and stay open with the reason when they conflict or fail", () => {
    const open = ev(main, proposed);
    expect(ev(open, { kind: "merge_resolved", worker: "w1", outcome: "merged", detail: "main" }).proposals[0]).toMatchObject({ status: "merged", problem: null });
    expect(ev(open, { kind: "merge_resolved", worker: "w1", outcome: "declined", detail: "" }).proposals[0]).toMatchObject({ status: "declined" });
    expect(ev(open, { kind: "merge_resolved", worker: "w1", outcome: "conflicts", detail: "a.ts, b.ts" }).proposals[0]).toMatchObject({ status: "open", problem: "Conflicts with main in a.ts, b.ts." });
    expect(ev(open, { kind: "merge_resolved", worker: "w1", outcome: "failed", detail: "The main checkout has 1 uncommitted change" }).proposals[0]).toMatchObject({ status: "open", problem: "The main checkout has 1 uncommitted change" });
    // Another worker's resolution leaves it alone.
    expect(ev(open, { kind: "merge_resolved", worker: "w2", outcome: "merged", detail: "main" }).proposals).toEqual(open.proposals);
  });
});

describe("user_sent", () => {
  it("a message the user types ends the run of automatic ones", () => {
    const auto: Action = { type: "user_sent", text: "note", auto: true };
    let s = reducer(reducer(main, auto), { type: "turn_numbered", turn: 1 });
    expect(s.autoStreak).toBe(1);
    s = reducer({ ...s, status: "idle" }, { type: "user_sent", text: "hello" });
    expect(s.autoStreak).toBe(0);
    expect(s.items.at(-1)).not.toHaveProperty("auto");
  });
});
