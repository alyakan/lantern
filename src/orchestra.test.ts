import { describe, expect, it } from "vitest";
import { initialState, reducer, totalCost, totalTokens, type Action, type State } from "./store";
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

  it("a stop the user asked for earlier does not make the app restart a worker the main agent later stops", () => {
    // The app restarts a chat that ended after the user pressed Stop; the main agent stopping it is its own decision.
    const pressed = reducer({ ...main, status: "running" }, { type: "stop_requested" });
    expect(pressed.stopRequested).toBe(true);
    expect(ev(pressed, { kind: "agent_stopped", reason: null })).toMatchObject({ status: "ended", stopRequested: false });
    expect(ev(pressed, { kind: "agent_message", from: "main agent", text: "x" }).stopRequested).toBe(false);
  });

  it("takes the mode its main agent's was lowered to", () => {
    expect(ev({ ...main, mode: "auto" }, { kind: "agent_mode", mode: "ask" }).mode).toBe("ask");
  });

  it("ends as stopped by the main agent, with a restart on offer, and never as a stop the app restarts on its own", () => {
    const stopped = ev({ ...main, status: "running", items: [{ type: "tool", id: "t", name: "Bash", summary: "", status: "running", output: null, edit: null, children: [] }] }, { kind: "agent_stopped", reason: null });
    expect(stopped.status).toBe("ended");
    expect(stopped.stopRequested).toBe(false); // App restarts an ended chat that has stopRequested
    expect(stopped.banner).toEqual({ kind: "info", text: expect.stringContaining("stopped this agent"), action: "restart" });
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

  it("are not sent to a chat that was just sent its queue in the same pass, which still reads idle", () => {
    const s = ev({ ...main, status: "idle", queued: ["a message the user typed while it worked"] }, { kind: "agent_wake", text: "note" });
    expect(wakesToSend({ s1: s })).toEqual([{ slot: "s1", text: "note" }]);
    expect(wakesToSend({ s1: s }, new Set(["s1"]))).toEqual([]);
    // Another chat in the same pass is not held back by it.
    expect(wakesToSend({ s1: s, s2: s }, new Set(["s1"]))).toEqual([{ slot: "s2", text: "note" }]);
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
  const proposed: UiEvent = { kind: "merge_proposed", worker: "w1", name: "Login form", branch: "lantern/login-form", into: "main", summary: "Adds the form", commits: 2, files: [{ path: "a.ts", added: 10, removed: 1 }], uncommitted: 1, loose: ["notes.md"] };

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
    // Changed since it was proposed: the card is retired, saying why.
    expect(ev(open, { kind: "merge_resolved", worker: "w1", outcome: "changed", detail: "Its loose files aren't the ones the merge was proposed with." }).proposals[0]).toMatchObject({ status: "declined", problem: "Its loose files aren't the ones the merge was proposed with." });
    expect(open.proposals[0].loose).toEqual(["notes.md"]);
    // Another worker's resolution leaves it alone.
    expect(ev(open, { kind: "merge_resolved", worker: "w2", outcome: "merged", detail: "main" }).proposals).toEqual(open.proposals);
  });

  it("count each answer from the backend, so an approval that fails the same way twice is still answered", () => {
    let s = ev(main, proposed);
    expect(s.proposals[0].attempts).toBe(0);
    const conflict: UiEvent = { kind: "merge_resolved", worker: "w1", outcome: "conflicts", detail: "a.ts" };
    s = ev(ev(s, conflict), conflict);
    expect(s.proposals[0]).toMatchObject({ attempts: 2, problem: "Conflicts with main in a.ts.", status: "open" });
    // A fresh proposal for the same worker starts over.
    expect(ev(s, proposed).proposals[0].attempts).toBe(0);
  });
});

describe("what a chat has cost", () => {
  const done = (cost: number | null): UiEvent => ({ kind: "turn_done", is_error: false, result: null, cost_usd: cost, duration_ms: 1000, auth_hint: false, denied: 0, context_window: null });

  it("is the running total claude reports, not a sum of totals", () => {
    // claude's total_cost_usd counts its whole process: 0.007 after turn one, 0.014 after turn two.
    let s = ev(main, done(0.007));
    s = ev(s, done(0.014));
    expect(totalCost(s)).toBeCloseTo(0.014);
  });

  it("carries what an earlier claude cost when a restart starts the count again", () => {
    let s = ev(main, done(0.02));
    s = ev(s, done(0.03));
    // The chat was restarted (a new mode): the new process starts from nothing.
    s = ev(s, done(0.005));
    expect(totalCost(s)).toBeCloseTo(0.035);
    s = ev(s, done(0.012));
    expect(totalCost(s)).toBeCloseTo(0.042);
  });

  it("keeps what an earlier claude cost when the new one's first total is higher than the old one's", () => {
    let s = ev(main, done(0.1));
    // Restarted from the app: the old claude's cost is set aside before the new one counts.
    s = reducer(s, { type: "restarting" });
    expect(totalCost(s)).toBeCloseTo(0.1);
    s = ev(s, done(0.3));
    expect(totalCost(s)).toBeCloseTo(0.4);
    s = ev(s, done(0.35));
    expect(totalCost(s)).toBeCloseTo(0.45);
  });

  it("counts tokens across restarts as it does cost", () => {
    const tok = (n: number): UiEvent => ({ kind: "turn_done", is_error: false, result: null, cost_usd: null, duration_ms: null, auth_hint: false, denied: 0, context_window: null, session_tokens: n } as UiEvent);
    let s = ev(main, tok(1000));
    s = ev(s, tok(3000));
    // A new claude starts its count again: what the old one used is kept.
    s = ev(s, tok(500));
    expect(totalTokens(s)).toBe(3500);
    s = reducer(s, { type: "restarting" });
    s = ev(s, tok(200));
    expect(totalTokens(s)).toBe(3700);
    expect(totalTokens(reducer(s, { type: "folder_opened", folder: "/q" }))).toBe(0);
  });

  it("is left alone by a turn that reports no cost, and starts over with a new conversation", () => {
    let s = ev(main, done(0.02));
    s = ev(s, done(null));
    expect(totalCost(s)).toBeCloseTo(0.02);
    expect(totalCost(reducer(s, { type: "folder_opened", folder: "/q" }))).toBe(0);
    expect(totalCost(initialState)).toBe(0);
  });
});

describe("user_sent", () => {
  it("a message the user types ends the run of automatic ones", () => {
    const auto: Action = { type: "user_sent", text: "note", auto: true };
    let s = reducer(reducer(main, auto), { type: "turn_numbered", turn: 1 });
    expect(s.autoStreak).toBe(1);
    s = reducer({ ...s, status: "idle" }, { type: "user_sent", text: "hello" });
    expect(s.autoStreak).toBe(0);
    expect(s.items[s.items.length - 1]).not.toHaveProperty("auto");
  });
});

describe("hiding a worker", () => {
  const withWorker = (): Chats => chatsReducer(initialChats(main), { type: "in", slot: "s1", action: { type: "ui_event", event: spawned } });

  it("marks it hidden, and shows it again by dropping the mark (not by saying false)", () => {
    const hidden = chatsReducer(withWorker(), { type: "set_hidden", slot: "w1", hidden: true });
    expect(hidden.agents.w1.hidden).toBe(true);
    const shown = chatsReducer(hidden, { type: "set_hidden", slot: "w1", hidden: false });
    expect(shown.agents.w1).toEqual(withWorker().agents.w1);
    expect("hidden" in shown.agents.w1).toBe(false);
  });

  it("changes nothing when it already is as asked, or the chat is no worker", () => {
    const c = withWorker();
    expect(chatsReducer(c, { type: "set_hidden", slot: "w1", hidden: false })).toBe(c);
    expect(chatsReducer(c, { type: "set_hidden", slot: "s1", hidden: true })).toBe(c);
    expect(chatsReducer(c, { type: "set_hidden", slot: "nope", hidden: true })).toBe(c);
    const hidden = chatsReducer(c, { type: "set_hidden", slot: "w1", hidden: true });
    expect(chatsReducer(hidden, { type: "set_hidden", slot: "w1", hidden: true })).toBe(hidden);
  });

  it("is kept when the worker is brought back with the chat", () => {
    let c = chatsReducer(initialChats(main), { type: "add", slot: "s2" });
    c = chatsReducer(c, { type: "adopt", slot: "s2", meta: { parent: "s1", name: "Login form", brief: "", folder: "/wt/login", branch: "lantern/login-form", base: "main", isolation: "worktree", hidden: true } });
    expect(c.agents.s2.hidden).toBe(true);
  });
});

describe("closing a worker from its card", () => {
  const withWorkers = (): Chats => {
    let c = chatsReducer(initialChats(main), { type: "in", slot: "s1", action: { type: "ui_event", event: spawned } });
    return chatsReducer(c, { type: "in", slot: "s1", action: { type: "ui_event", event: { ...spawned, worker: "w2", name: "Other" } } });
  };

  it("removes its chat and its place on the team", () => {
    const c = chatsReducer(withWorkers(), { type: "close_agent", slot: "w2" });
    expect(Object.keys(c.slots)).toEqual(["s1", "w1"]);
    expect(Object.keys(c.agents)).toEqual(["w1"]);
    expect(c.active).toBe("s1");
  });

  it("takes the chat on screen to the main agent instead of refusing, as removing the chat on screen would", () => {
    let c = chatsReducer(withWorkers(), { type: "activate", slot: "w1" });
    expect(chatsReducer(c, { type: "remove", slot: "w1" }).slots.w1).toBeTruthy();
    c = chatsReducer(c, { type: "close_agent", slot: "w1" });
    expect(c.slots.w1).toBeUndefined();
    expect(c.active).toBe("s1");
  });

  it("is a plain removal for a chat that is not a worker", () => {
    const c = chatsReducer(initialChats(main), { type: "add", slot: "s2" });
    expect(chatsReducer(c, { type: "close_agent", slot: "s2" }).slots.s2).toBeUndefined();
    expect(chatsReducer(c, { type: "close_agent", slot: "s1" })).toBe(c);
  });
});

describe("adopting a restored worker", () => {
  const meta = { parent: "s1", name: "Login form", brief: "", folder: "/wt/login", branch: "lantern/login-form", base: "main", isolation: "worktree" as const };

  it("makes a restored chat a worker of an open main agent again", () => {
    let c = chatsReducer(initialChats(main), { type: "add", slot: "s2" });
    c = chatsReducer(c, { type: "adopt", slot: "s2", meta });
    expect(c.agents.s2).toEqual(meta);
  });

  it("does nothing for a chat that is not open, or a main agent that is not", () => {
    const c = initialChats(main);
    expect(chatsReducer(c, { type: "adopt", slot: "gone", meta })).toBe(c);
    const orphan = chatsReducer(c, { type: "add", slot: "s2" });
    expect(chatsReducer(orphan, { type: "adopt", slot: "s2", meta: { ...meta, parent: "nope" } })).toBe(orphan);
  });
});
