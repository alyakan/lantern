import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { chatsReducer, initialChats, type Chats } from "../sessions";
import { initialState, type State } from "../store";
import { CONTINUE_MESSAGE, setPauseAtPercent } from "./planPause";
import { setPlanUsage } from "./planUsage";
import { teamAgentsWorking, useTeamGuards, type GuardActions } from "./teamGuards";

const lead: State = { ...initialState, status: "idle", claudePath: "/bin/claude", folder: "/p", orchestrator: true, mode: "auto" };

function team(): Chats {
  let c = initialChats(lead);
  for (const w of ["w1", "w2"]) {
    c = chatsReducer(c, { type: "in", slot: "s1", action: { type: "ui_event", event: { kind: "agent_spawned", worker: w, name: w, brief: "task", folder: `/wt/${w}`, branch: `lantern/${w}`, base: "main", isolation: "worktree", mode: "auto" } } });
  }
  // A worker starts out running its brief: these are at rest until a test says otherwise.
  return withStatus(c, { w1: "idle", w2: "idle" });
}

/** The chats with each of these slots at the stated status. */
function withStatus(c: Chats, by: Record<string, State["status"]>): Chats {
  return { ...c, slots: Object.fromEntries(Object.entries(c.slots).map(([k, s]) => [k, k in by ? { ...s, status: by[k], thinking: by[k] === "running" } : s])) };
}

const actions = (): GuardActions => ({ stop: vi.fn(), send: vi.fn(), queue: vi.fn(), warn: vi.fn(), paused: vi.fn() });

/** When the window resets: later than now, so the text says how long. */
const RESET = Math.floor(Date.now() / 1000) + 72 * 60;
const reading = (percent: number, resetsAt = RESET) => act(() => setPlanUsage({ used: percent / 100, resetsAt }));

beforeEach(() => {
  localStorage.clear();
  setPauseAtPercent(95);
  // What an earlier test last heard would be what a new hook starts from.
  act(() => setPlanUsage({ used: 0, resetsAt: 1 }));
});
afterEach(() => vi.useRealTimers());

describe("which agents a pause stops", () => {
  it("is every working chat of a team: its Lead and its agents, and no one else", () => {
    const c = withStatus(team(), { s1: "running", w2: "running" });
    expect(teamAgentsWorking(c)).toEqual(["s1", "w2"]);
    expect(teamAgentsWorking(withStatus(team(), { s1: "idle" }))).toEqual([]);
    // A plain chat is not on any team.
    const plain = chatsReducer(withStatus(team(), { w1: "running" }), { type: "add", slot: "s9" });
    const running = { ...plain, slots: { ...plain.slots, s9: { ...plain.slots.s9, status: "running" as const } } };
    expect(teamAgentsWorking(running)).toEqual(["w1"]);
  });
});

describe("the pause at the plan's limit", () => {
  it("interrupts every working agent of every team the first time the plan reaches it, and says so", () => {
    const act_ = actions();
    const chats = withStatus(team(), { s1: "running", w1: "running", w2: "idle" });
    const { result } = renderHook(() => useTeamGuards(chats, act_));
    expect(result.current.pause).toBeNull();
    reading(95);
    expect(act_.stop).toHaveBeenCalledTimes(2);
    expect(act_.stop).toHaveBeenCalledWith("s1");
    expect(act_.stop).toHaveBeenCalledWith("w1");
    expect(act_.paused).toHaveBeenCalledWith(expect.stringMatching(/^Paused: your plan is 95% used, it resets in /));
    expect(result.current.pause).toMatchObject({ percent: 95, resetsAt: RESET, slots: ["s1", "w1"] });
    // It resumes nothing by itself.
    expect(act_.send).not.toHaveBeenCalled();
  });

  it("never pauses twice for the same window, not even after a restart of the app", () => {
    const act_ = actions();
    const chats = withStatus(team(), { w1: "running" });
    const first = renderHook(() => useTeamGuards(chats, act_));
    reading(95);
    reading(97);
    expect(act_.stop).toHaveBeenCalledTimes(1);
    first.unmount();
    const again = renderHook(() => useTeamGuards(chats, act_));
    reading(98);
    expect(act_.stop).toHaveBeenCalledTimes(1);
    expect(again.result.current.pause).toBeNull();
    // The next window pauses again.
    reading(96, RESET + 5 * 3600);
    expect(act_.stop).toHaveBeenCalledTimes(2);
  });

  it("does nothing when the setting is off, or when nothing is working", () => {
    setPauseAtPercent(0);
    const off = actions();
    renderHook(() => useTeamGuards(withStatus(team(), { w1: "running" }), off));
    reading(99);
    expect(off.stop).not.toHaveBeenCalled();
    setPauseAtPercent(95);
    const idle = actions();
    const { result } = renderHook(() => useTeamGuards(team(), idle));
    reading(99, RESET + 10 * 3600);
    expect(idle.stop).not.toHaveBeenCalled();
    expect(result.current.pause).toBeNull();
  });

  it("warns once, 5 points before the limit", () => {
    const act_ = actions();
    renderHook(() => useTeamGuards(withStatus(team(), { w1: "running" }), act_));
    reading(89);
    expect(act_.warn).not.toHaveBeenCalled();
    reading(90);
    reading(92);
    expect(act_.warn).toHaveBeenCalledTimes(1);
    expect(act_.warn).toHaveBeenCalledWith("Your plan is 90% used. Lantern will pause the teams' work at 95%.");
    expect(act_.stop).not.toHaveBeenCalled();
    reading(95);
    expect(act_.stop).toHaveBeenCalledTimes(1);
  });
});

describe("Resume", () => {
  /** A chat that was stopped by the pause: idle, its last turn stopped. */
  const stopped = (s: State): State => ({ ...s, status: "idle", thinking: false, items: [...s.items, { type: "turn", id: "t9", isError: false, stopped: true, result: null, durationMs: 1, denied: [], cost: null, tokens: null } as never] });

  it("tells each agent that was stopped to continue, and clears the pause", () => {
    const act_ = actions();
    let chats = withStatus(team(), { s1: "running", w1: "running" });
    const { result, rerender } = renderHook(({ c }) => useTeamGuards(c, act_), { initialProps: { c: chats } });
    reading(96);
    chats = { ...chats, slots: { ...chats.slots, s1: stopped(chats.slots.s1), w1: stopped(chats.slots.w1) } };
    rerender({ c: chats });
    act(() => result.current.resume());
    expect(act_.send).toHaveBeenCalledTimes(2);
    expect(act_.send).toHaveBeenCalledWith("s1", CONTINUE_MESSAGE);
    expect(act_.send).toHaveBeenCalledWith("w1", CONTINUE_MESSAGE);
    expect(result.current.pause).toBeNull();
  });

  it("sends what was queued for an agent along with it, and leaves one the user already spoke to alone", () => {
    const act_ = actions();
    let chats = withStatus(team(), { s1: "running", w1: "running" });
    const { result, rerender } = renderHook(({ c }) => useTeamGuards(c, act_), { initialProps: { c: chats } });
    reading(96);
    const spoken = { ...stopped(chats.slots.w1), items: [...stopped(chats.slots.w1).items, { type: "user", id: "u9", text: "go on", at: 1 } as never] };
    chats = { ...chats, slots: { ...chats.slots, s1: { ...stopped(chats.slots.s1), queued: ["also this"] }, w1: spoken } };
    rerender({ c: chats });
    act(() => result.current.resume());
    expect(act_.send).toHaveBeenCalledTimes(1);
    expect(act_.send).toHaveBeenCalledWith("s1", `${CONTINUE_MESSAGE}\n\nalso this`);
    expect(act_.queue).toHaveBeenCalledWith("s1", []);
  });

  it("queues it behind an agent whose interrupt hasn't landed yet", () => {
    const act_ = actions();
    const chats = withStatus(team(), { w1: "running" });
    const { result, rerender } = renderHook(({ c }) => useTeamGuards(c, act_), { initialProps: { c: chats } });
    reading(96);
    rerender({ c: { ...chats, slots: { ...chats.slots, w1: { ...chats.slots.w1, stopRequested: true } } } });
    act(() => result.current.resume());
    expect(act_.send).not.toHaveBeenCalled();
    expect(act_.queue).toHaveBeenCalledWith("w1", [CONTINUE_MESSAGE]);
  });

  it("does nothing when nothing is paused", () => {
    const act_ = actions();
    const { result } = renderHook(() => useTeamGuards(team(), act_));
    act(() => result.current.resume());
    expect(act_.send).not.toHaveBeenCalled();
  });
});
