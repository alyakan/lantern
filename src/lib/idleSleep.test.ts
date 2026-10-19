import { beforeEach, describe, expect, it } from "vitest";
import { initialState, reducer, type State } from "../store";
import { chatTitle } from "../sessions";
import { chatsToSave, sessionModesToSave } from "./restore";
import { canSleep, SLEEP_MINUTES_DEFAULT, setSleepMinutes, sleepMinutes, sweep } from "./idleSleep";

const resting: State = {
  ...initialState,
  status: "idle",
  folder: "/p",
  sessionId: "sess-1",
  claudePath: "/c",
  items: [{ type: "user", id: "u1", text: "fix the login redirect", at: 1 }],
};
const own = { active: false, agent: false, routine: false };

describe("which chats may go to sleep", () => {
  it("lets a resting chat that isn't on screen sleep", () => {
    expect(canSleep(resting, own)).toBe(true);
  });

  it("keeps the chat on screen, a team's chats and a routine's awake", () => {
    expect(canSleep(resting, { ...own, active: true })).toBe(false);
    expect(canSleep(resting, { ...own, agent: true })).toBe(false);
    expect(canSleep(resting, { ...own, routine: true })).toBe(false);
    expect(canSleep({ ...resting, orchestrator: true }, own)).toBe(false);
  });

  it("keeps awake a chat that is working, starting or stopped", () => {
    for (const status of ["running", "starting", "ended", "asleep"] as const) expect(canSleep({ ...resting, status }, own)).toBe(false);
    expect(canSleep({ ...resting, thinking: true }, own)).toBe(false);
  });

  it("keeps awake a chat with something still to do: queued messages, notes, background tasks, a question for the user", () => {
    expect(canSleep({ ...resting, queued: ["and then?"] }, own)).toBe(false);
    expect(canSleep({ ...resting, wakes: ["a worker finished"] }, own)).toBe(false);
    expect(canSleep({ ...resting, backgroundTasks: [{ id: "b1", taskType: "local_bash", description: "tests", since: 1 }] }, own)).toBe(false);
    const asking = { ...resting, items: [...resting.items, { type: "permission" as const, id: "p1", toolName: "Bash", input: {}, decision: null, at: 2 }] };
    expect(canSleep(asking, own)).toBe(false);
  });

  it("keeps awake a chat holding what waits for its next message, or for an Undo", () => {
    expect(canSleep({ ...resting, revertNotes: [{ path: "/p/a.ts", trashed: false, since: "that turn", revert: 1 }] }, own)).toBe(false);
    expect(canSleep({ ...resting, restoreUndo: { id: 4, summary: "2 files are back." } }, own)).toBe(false);
    expect(canSleep({ ...resting, flavourPick: "build" }, own)).toBe(false);
  });

  it("keeps awake a chat running a command, whose process would be stopped, or whose output hasn't gone to Claude yet", () => {
    const shell = { type: "shell" as const, id: "sh1", command: "npm run dev", output: "", status: "running" as const, code: null, startedAt: 1, shared: false };
    expect(canSleep({ ...resting, items: [...resting.items, shell] }, own)).toBe(false);
    expect(canSleep({ ...resting, items: [...resting.items, { ...shell, status: "done" }] }, own)).toBe(false);
    expect(canSleep({ ...resting, items: [...resting.items, { ...shell, status: "done", shared: true }] }, own)).toBe(true);
    expect(canSleep({ ...resting, run: { id: "run-1", command: "npm run dev", status: "running", code: null, output: "", url: null, startedAt: 1 } }, own)).toBe(false);
  });

  it("has nothing to put to sleep in a chat with no conversation to come back to", () => {
    expect(canSleep({ ...resting, items: [] }, own)).toBe(false);
    expect(canSleep({ ...resting, sessionId: null }, own)).toBe(false);
  });
});

describe("the idle clock", () => {
  const MIN = 60_000;

  it("starts when a chat becomes eligible, and names it once it has been idle long enough", () => {
    const first = sweep({}, new Set(["a"]), 1000, 10 * MIN);
    expect(first).toEqual({ clock: { a: 1000 }, due: [] });
    expect(sweep(first.clock, new Set(["a"]), 1000 + 10 * MIN - 1, 10 * MIN).due).toEqual([]);
    expect(sweep(first.clock, new Set(["a"]), 1000 + 10 * MIN, 10 * MIN).due).toEqual(["a"]);
  });

  it("starts over for a chat that was used in between", () => {
    const first = sweep({}, new Set(["a"]), 0, 10 * MIN);
    // Not eligible for a while (it was on screen), then eligible again: the wait begins again.
    const away = sweep(first.clock, new Set(), 9 * MIN, 10 * MIN);
    expect(away.clock).toEqual({});
    const back = sweep(away.clock, new Set(["a"]), 11 * MIN, 10 * MIN);
    expect(back).toEqual({ clock: { a: 11 * MIN }, due: [] });
  });

  it("keeps each chat's own clock", () => {
    const one = sweep({}, new Set(["a"]), 0, 10 * MIN);
    const two = sweep(one.clock, new Set(["a", "b"]), 6 * MIN, 10 * MIN);
    expect(sweep(two.clock, new Set(["a", "b"]), 10 * MIN, 10 * MIN).due).toEqual(["a"]);
  });

  it("never names a chat when sleeping is off", () => {
    const first = sweep({}, new Set(["a"]), 0, 0);
    expect(sweep(first.clock, new Set(["a"]), 24 * 60 * MIN, 0).due).toEqual([]);
  });
});

describe("the sleep setting", () => {
  beforeEach(() => localStorage.clear());

  it("is 10 minutes until it is changed, and can be turned off", () => {
    expect(sleepMinutes()).toBe(SLEEP_MINUTES_DEFAULT);
    expect(SLEEP_MINUTES_DEFAULT).toBe(10);
    setSleepMinutes(0);
    expect(sleepMinutes()).toBe(0);
    setSleepMinutes(30);
    expect(sleepMinutes()).toBe(30);
  });

  it("ignores a value that isn't one of the choices", () => {
    setSleepMinutes(7);
    expect(sleepMinutes()).toBe(SLEEP_MINUTES_DEFAULT);
    localStorage.setItem("lantern.sleepMinutes", "banana");
    expect(sleepMinutes()).toBe(SLEEP_MINUTES_DEFAULT);
  });
});

describe("an asleep chat", () => {
  const asleep = reducer(resting, { type: "sleep", folder: "/p", sessionId: "sess-1", title: "Fix the login redirect" });

  it("drops its messages but keeps what it is: its folder, conversation and name", () => {
    expect(asleep).toMatchObject({ status: "asleep", folder: "/p", sessionId: "sess-1", items: [], thinking: false });
    expect(chatTitle(asleep)).toBe("Fix the login redirect");
  });

  it("ignores what its stopped process says on the way out", () => {
    const after = reducer(asleep, { type: "ui_event", event: { kind: "session_ended", code: 143, stderr_tail: "" } });
    expect(after).toBe(asleep);
  });

  it("is still saved with the chats to bring back, under its name", () => {
    const saved = chatsToSave({ s2: asleep }, "s1", {}, {});
    expect(saved).toEqual([{ sessionId: "sess-1", folder: "/p", title: "Fix the login redirect", draft: "", active: false }]);
  });

  it("never has its saved mode written over by the mode it was made with", () => {
    const stub: State = { ...asleep, mode: "auto" };
    expect(sessionModesToSave({ s2: stub }, { "sess-1": "ask" })).toBeNull();
    expect(sessionModesToSave({ s2: stub, s3: { ...resting, sessionId: "sess-2", mode: "steps" } }, { "sess-1": "ask" })).toEqual({ "sess-1": "ask", "sess-2": "steps" });
  });

  it("wakes with the history it is given and forgets the name it slept under", () => {
    const woken = reducer(reducer(asleep, { type: "folder_opened", folder: "/p" }), { type: "history_loaded", sessionId: "sess-1", events: [{ kind: "user_text", text: "fix the login redirect" }] });
    expect(woken.status).toBe("starting");
    expect(woken.asleepTitle).toBeNull();
    expect(woken.items).toHaveLength(1);
  });
});
