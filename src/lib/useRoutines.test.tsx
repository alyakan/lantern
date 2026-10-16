import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRoutines, type RoutinesOptions } from "./useRoutines";
import { setPlanUsage } from "./planUsage";
import { ROUTINES_KEY, TICK_MS, type Routine } from "./routines";
import { initialState, type State } from "../store";

const NOW = new Date(2026, 9, 14, 9, 0, 20).getTime();
const DUE = new Date(2026, 9, 14, 9, 0, 0).getTime();

function routine(patch: Partial<Routine> = {}): Routine {
  return {
    id: "r1",
    name: "Morning TODOs",
    folder: "/Users/you/dev/app",
    prompt: "Check the open TODOs",
    schedule: { kind: "weekdays", at: "09:00" },
    permissions: "ask",
    model: "sonnet",
    enabled: true,
    nextAt: DUE,
    pausedUntil: null,
    runs: [],
    ...patch,
  };
}
const save = (list: Routine[]) => localStorage.setItem(ROUTINES_KEY, JSON.stringify(list));
const saved = (): Routine[] => JSON.parse(localStorage.getItem(ROUTINES_KEY) ?? "[]");

const chat = (patch: Partial<State> = {}): State => ({ ...initialState, folder: "/Users/you/dev/app", claudePath: "/bin/claude", status: "idle", sessionId: "sess-1", ...patch });
const user = { type: "user", id: "u1", text: "Check the open TODOs", at: 0 } as never;
const permission = { type: "permission", id: "p1", decision: null } as never;

function setup(initial: Partial<RoutinesOptions> = {}) {
  const open = vi.fn((r: Routine) => Promise.resolve(`s-${r.id}`));
  const send = vi.fn();
  const hook = renderHook((props: Partial<RoutinesOptions>) => useRoutines({ ready: true, chats: {}, open, send, ...props }), { initialProps: initial });
  return { ...hook, open, send };
}
const flush = () => act(async () => {});

beforeEach(() => {
  localStorage.clear();
  setPlanUsage({ used: 0.1, resetsAt: null });
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("useRoutines", () => {
  it("reads the saved routines, drops what doesn't read, and settles runs that were working when Lantern closed", () => {
    save([routine({ runs: [{ at: 1, outcome: "running" }] }), { id: "bad" } as never]);
    const { result } = setup({ ready: false });
    expect(result.current.routines).toHaveLength(1);
    expect(result.current.routines[0].runs[0]).toEqual({ at: 1, outcome: "stopped", note: "Lantern was closed" });
    expect(saved()[0].runs[0].outcome).toBe("stopped");
  });

  it("starts a due routine: opens its chat, sends the prompt once the chat is ready, and follows the run to its end", async () => {
    save([routine()]);
    const { result, rerender, open, send } = setup();
    await flush();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0].id).toBe("r1");
    expect(result.current.routines[0].runs[0]).toEqual({ at: NOW, outcome: "running" });
    // The chat is still opening: nothing sent yet.
    rerender({ chats: { "s-r1": chat({ status: "starting", sessionId: null }) } });
    expect(send).not.toHaveBeenCalled();
    // Ready: the prompt goes, as the first message, and the run knows its chat.
    rerender({ chats: { "s-r1": chat() } });
    expect(send).toHaveBeenCalledWith("s-r1", "Check the open TODOs");
    expect(result.current.routines[0].runs[0].sessionId).toBe("sess-1");
    expect(result.current.titles).toEqual({ "sess-1": "Routine: Morning TODOs" });
    // Working, then waiting for the user on a permission, then working, then done.
    rerender({ chats: { "s-r1": chat({ status: "running", items: [user] }) } });
    expect(result.current.routines[0].runs[0].outcome).toBe("running");
    rerender({ chats: { "s-r1": chat({ status: "running", items: [user, permission] }) } });
    expect(result.current.routines[0].runs[0].outcome).toBe("waiting");
    rerender({ chats: { "s-r1": chat({ status: "running", items: [user] }) } });
    expect(result.current.routines[0].runs[0].outcome).toBe("running");
    rerender({ chats: { "s-r1": chat({ status: "idle", items: [user] }) } });
    expect(result.current.routines[0].runs[0].outcome).toBe("done");
    expect(send).toHaveBeenCalledTimes(1);
    expect(saved()[0].runs[0].outcome).toBe("done");
  });

  it("opens the chat of a routine only once for one due time", async () => {
    save([routine()]);
    const { open } = setup();
    await flush();
    act(() => void vi.advanceTimersByTime(TICK_MS));
    await flush();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("does not look until claude is found, then starts what is still due", async () => {
    save([routine()]);
    const { rerender, open } = setup({ ready: false });
    act(() => void vi.advanceTimersByTime(TICK_MS));
    expect(open).not.toHaveBeenCalled();
    rerender({ ready: true });
    await flush();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("records a run due long ago as missed, once", async () => {
    save([routine({ nextAt: DUE - 3 * 3_600_000 })]);
    const { result, open } = setup();
    await flush();
    act(() => void vi.advanceTimersByTime(TICK_MS * 3));
    expect(open).not.toHaveBeenCalled();
    expect(result.current.routines[0].runs).toEqual([{ at: DUE - 3 * 3_600_000, outcome: "missed" }]);
  });

  it("looks again when the window comes back after the Mac slept", async () => {
    save([routine({ nextAt: DUE + 10 * 3_600_000 })]);
    const { result, open } = setup();
    await flush();
    // Slept through a day's time: timers didn't run. Back, the focus event looks at once: missed, not late.
    vi.setSystemTime(DUE + 10 * 3_600_000 + 20 * 60_000);
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(open).not.toHaveBeenCalled();
    expect(result.current.routines[0].runs[0].outcome).toBe("missed");
  });

  it("skips a run while the last is still going, and says so", async () => {
    save([routine({ schedule: { kind: "every", every: 5, unit: "minutes" } })]);
    const { result, open } = setup();
    await flush();
    expect(open).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 5 * 60_000 + 1000);
    act(() => void vi.advanceTimersByTime(5 * 60_000));
    expect(open).toHaveBeenCalledTimes(1);
    expect(result.current.routines[0].runs[0]).toMatchObject({ outcome: "skipped", note: "the last run is still going" });
  });

  it("skips a run when the plan is at 95%, and says so", async () => {
    save([routine()]);
    setPlanUsage({ used: 0.96, resetsAt: Math.floor(NOW / 1000) + 3600 });
    const { result, open } = setup();
    await flush();
    expect(open).not.toHaveBeenCalled();
    expect(result.current.routines[0].runs[0]).toMatchObject({ outcome: "skipped", note: "the plan is at 96%" });
  });

  it("ignores a plan figure from a window that has ended", async () => {
    save([routine()]);
    setPlanUsage({ used: 0.99, resetsAt: Math.floor(NOW / 1000) - 60 });
    const { open } = setup();
    await flush();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("writes down why a chat couldn't be opened", async () => {
    save([routine()]);
    const open = vi.fn(() => Promise.reject(new Error("its project folder isn't there any more")));
    const { result } = setup({ open });
    await flush();
    expect(result.current.routines[0].runs[0]).toMatchObject({ outcome: "failed", note: "its project folder isn't there any more" });
  });

  it("marks a run failed when its chat never started, and stopped when the chat is closed", async () => {
    save([routine(), routine({ id: "r2", name: "Other" })]);
    const { result, rerender } = setup();
    await flush();
    rerender({ chats: { "s-r1": chat({ status: "ended", sessionId: null, banner: { kind: "error", text: "Claude didn't start", action: "restart" } }), "s-r2": chat() } });
    expect(result.current.routines[0].runs[0]).toMatchObject({ outcome: "failed", note: "Claude didn't start" });
    // r2 got its prompt; the user closes its chat.
    rerender({ chats: { "s-r2": chat({ status: "running", items: [user] }) } });
    rerender({ chats: {} });
    expect(result.current.routines[1].runs[0]).toMatchObject({ outcome: "stopped", note: "the chat was closed" });
  });

  describe("Run now", () => {
    it("starts a run of any routine, off or not, and leaves its schedule alone", async () => {
      save([routine({ enabled: false, nextAt: null })]);
      const { result, open } = setup();
      let error: string | null = "unset";
      act(() => {
        error = result.current.runNow("r1");
      });
      await flush();
      expect(error).toBeNull();
      expect(open).toHaveBeenCalledTimes(1);
      expect(result.current.routines[0].runs[0]).toEqual({ at: NOW, outcome: "running", manual: true });
      expect(result.current.routines[0].nextAt).toBeNull();
    });

    it("says no while the last run is going, while the plan is full, and while claude isn't ready", async () => {
      save([routine({ nextAt: NOW + 3_600_000 })]);
      const { result, rerender } = setup();
      await flush();
      act(() => void result.current.runNow("r1"));
      await flush();
      let again: string | null = null;
      act(() => {
        again = result.current.runNow("r1");
      });
      expect(again).toBe("Not started: the last run is still going.");
      save([routine({ nextAt: NOW + 3_600_000 })]);
      setPlanUsage({ used: 0.97, resetsAt: null });
      const second = setup();
      let full: string | null = null;
      act(() => {
        full = second.result.current.runNow("r1");
      });
      expect(full).toBe("Not started: the plan is at 97%.");
      second.rerender({ ready: false });
      setPlanUsage({ used: 0.1, resetsAt: null });
      let unready: string | null = null;
      act(() => {
        unready = second.result.current.runNow("r1");
      });
      expect(unready).toBe("Claude isn't ready yet.");
      rerender({});
    });
  });

  describe("editing", () => {
    const draft = { name: "  Tests  ", folder: "/Users/you/dev/app", prompt: "Run the tests", schedule: { kind: "every", every: 1, unit: "hours" } as const, permissions: "ask" as const, model: "haiku" };

    it("adds a routine that is on, due at its next time, with a trimmed name; and refuses a bad one", () => {
      const { result } = setup({ ready: false });
      let problem: string | null = "unset";
      act(() => {
        problem = result.current.add(draft);
      });
      expect(problem).toBeNull();
      expect(result.current.routines[0]).toMatchObject({ name: "Tests", enabled: true, nextAt: NOW + 3_600_000, runs: [], model: "haiku" });
      act(() => {
        problem = result.current.add({ ...draft, prompt: "" });
      });
      expect(problem).toMatch(/what Claude should do/);
      expect(result.current.routines).toHaveLength(1);
      expect(saved()).toHaveLength(1);
    });

    it("stops at 20 routines", () => {
      save(Array.from({ length: 20 }, (_, i) => routine({ id: `r${i}`, enabled: false, nextAt: null })));
      const { result } = setup({ ready: false });
      let problem: string | null = null;
      act(() => {
        problem = result.current.add(draft);
      });
      expect(problem).toBe("There can be 20 routines at most.");
    });

    it("changes the next time when the schedule changes, keeps the history, and never takes the permissions beyond what the form says", () => {
      save([routine({ nextAt: NOW + 1000, runs: [{ at: 5, outcome: "done" }] })]);
      const { result } = setup({ ready: false });
      act(() => void result.current.edit("r1", { ...draft, schedule: { kind: "every", every: 2, unit: "hours" } }));
      expect(result.current.routines[0]).toMatchObject({ nextAt: NOW + 2 * 3_600_000, permissions: "ask", name: "Tests", runs: [{ at: 5, outcome: "done" }] });
    });

    it("switches on and off, pauses, and deletes", () => {
      save([routine({ nextAt: null, enabled: false })]);
      const { result } = setup({ ready: false });
      act(() => void result.current.enable("r1", true));
      expect(result.current.routines[0]).toMatchObject({ enabled: true, nextAt: new Date(2026, 9, 15, 9).getTime() });
      act(() => void result.current.pause("r1", true));
      expect(result.current.routines[0].pausedUntil).toBe(NOW + 3_600_000);
      act(() => void result.current.remove("r1"));
      expect(result.current.routines).toEqual([]);
      expect(saved()).toEqual([]);
    });

    it("takes the routines a move of the folder changed", () => {
      save([routine()]);
      const { result } = setup({ ready: false });
      act(() => result.current.replace([{ ...routine(), folder: "/Users/you/new/app" }]));
      expect(result.current.routines[0].folder).toBe("/Users/you/new/app");
    });
  });
});
