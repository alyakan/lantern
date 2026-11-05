import { beforeEach, describe, expect, it } from "vitest";
import { initialState, reducer, type State } from "../store";
import { chatTitle } from "../sessions";
import type { UiEvent } from "../types";
import { chatsToSave, sessionModesToSave } from "./restore";
import { canSleep, SLEEP_MINUTES_DEFAULT, setSleepMinutes, sleepMinutes, sleepNote, sweep } from "./idleSleep";

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

describe("a step still running", () => {
  const NOW = 10_000_000_000;
  const HOUR = 60 * 60_000;
  const step = { type: "tool" as const, id: "t1", name: "Bash", summary: "cargo build", status: "running" as const, output: null, edit: null, children: [], startedAt: NOW - 20 * 60_000 };
  const withItem = (item: State["items"][number]): State => ({ ...resting, items: [...resting.items, item] });

  it("keeps a chat awake even when its status says idle, so a build or an upload is not stopped under Claude", () => {
    expect(canSleep(withItem(step), own, NOW)).toBe(false);
    expect(canSleep(withItem({ ...step, status: "done" }), own, NOW)).toBe(true);
  });

  it("counts a subagent's running step too", () => {
    const agent = { ...step, name: "Agent", status: "done" as const, children: [step] };
    expect(canSleep(withItem(agent), own, NOW)).toBe(false);
  });

  it("does not keep a chat awake once a whole turn has run: every step it started, the advisor's and a subagent's included, is over", () => {
    const ui = (s: State, event: UiEvent): State => reducer(s, { type: "ui_event", event });
    const done = { kind: "turn_done" as const, is_error: false, result: null, cost_usd: null, duration_ms: 1, auth_hint: false, denied: 0, context_window: null };
    let s: State = { ...initialState, status: "starting", folder: "/p", claudePath: "/c" };
    const events: UiEvent[] = [
      { kind: "session_started", session_id: "sess-1", model: "m", cwd: "/p", permission_mode: "auto", claude_version: "1" },
      { kind: "user_text", text: "build it", sent_by: "phone" },
      { kind: "thinking", parent: null },
      { kind: "tool_started", parent: null, tool_use_id: "t1", name: "Bash", summary: "cargo build" },
      { kind: "tool_finished", parent: null, tool_use_id: "t1", is_error: false, output: "ok" },
      { kind: "advisor_started", parent: null, id: "a1" },
      { kind: "advisor_done", parent: null, id: "a1", outcome: "reviewed", error_code: null },
      { kind: "tool_started", parent: null, tool_use_id: "t2", name: "Agent", summary: "look around" },
      { kind: "tool_started", parent: "t2", tool_use_id: "t3", name: "Read", summary: "a.ts" },
      { kind: "tool_finished", parent: "t2", tool_use_id: "t3", is_error: false, output: "" },
      { kind: "tool_finished", parent: null, tool_use_id: "t2", is_error: false, output: "found it" },
      { kind: "assistant_text", parent: null, block_id: "b1", text: "Done." },
      done,
    ];
    for (const ev of events) {
      s = ui(s, ev);
      // Mid-turn the chat is running (or at least not allowed to sleep for another reason), never resting.
      if (ev.kind !== "turn_done") expect(canSleep(s, own)).toBe(false);
    }
    expect(s.status).toBe("idle");
    expect(canSleep(s, own)).toBe(true);
  });

  it("lets go of a step Claude never finished, and of one with no start time (replayed from History)", () => {
    expect(canSleep(withItem({ ...step, startedAt: NOW - 3 * HOUR }), own, NOW)).toBe(true);
    expect(canSleep(withItem({ ...step, startedAt: undefined }), own, NOW)).toBe(true);
  });
});

describe("what sleep.log says of a chat put to sleep", () => {
  const NOW = 10_000_000;
  const step = { type: "tool" as const, id: "t1", name: "Bash", summary: "a secret command", status: "done" as const, output: null, edit: null, children: [], startedAt: NOW - 90_000, endedAt: NOW - 30_000 };

  it("names the slot, the status, how long it was idle and its last step, and never a word said in the chat", () => {
    const s: State = { ...resting, items: [...resting.items, step], queued: ["x"] };
    const line = sleepNote("s7", s, "idle", 601_400, NOW);
    expect(line).toBe("slot=s7 why=idle status=idle thinking=false idle_for=601s items=2 last_item=tool last_tool=Bash:done@30s ago running_tools=0 queued=1 background=0 wakes=0");
    expect(line).not.toContain("secret");
    expect(line).not.toContain("login");
  });

  it("counts a running step even one too old to keep the chat awake, so a stuck one shows", () => {
    const s: State = { ...resting, items: [{ ...step, status: "running", endedAt: undefined, startedAt: NOW - 5 * 60 * 60_000 }] };
    expect(sleepNote("s7", s, "idle", 0, NOW + 5 * 60 * 60_000)).toContain("running_tools=1");
  });

  it("copes with a chat that has no step at all", () => {
    expect(sleepNote("s1", resting, "idle", 0, NOW)).toContain("last_tool=none");
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
