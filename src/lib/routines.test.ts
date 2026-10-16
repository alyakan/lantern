import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error type error without @types/node package
import process from "node:process";
import {
  MAX_AT_ONCE,
  MAX_ROUTINES,
  MAX_RUNS,
  MISSED_AFTER_MS,
  ROUTINE_PAUSE_MS,
  describeSchedule,
  draftProblem,
  newRoutine,
  nextRun,
  outcomeText,
  readRoutines,
  routineTitles,
  runNow,
  settleStale,
  skipReason,
  tick,
  updateRun,
  validSchedule,
  when,
  withEnabled,
  withPause,
  type Context,
  type Routine,
  type Schedule,
} from "./routines";

// Every date below is on this Mac's own clock; New York changes its clocks on 8 March and 1 November 2026.
// Set while the file loads, so the dates made in describe blocks use it too.
const realTz = process.env.TZ;
process.env.TZ = "America/New_York";
afterAll(() => {
  if (realTz === undefined) delete process.env.TZ;
  else process.env.TZ = realTz;
});

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const MIN = 60_000;

describe("nextRun", () => {
  it("is every N minutes or hours after the moment given", () => {
    const now = at(2026, 10, 14, 9, 7);
    expect(nextRun({ kind: "every", every: 30, unit: "minutes" }, now)).toBe(now + 30 * MIN);
    expect(nextRun({ kind: "every", every: 2, unit: "hours" }, now)).toBe(now + 120 * MIN);
  });

  it("is today at the time if it hasn't passed, else tomorrow, for a daily routine", () => {
    const daily: Schedule = { kind: "daily", at: "09:00" };
    expect(nextRun(daily, at(2026, 10, 14, 8, 59))).toBe(at(2026, 10, 14, 9, 0));
    expect(nextRun(daily, at(2026, 10, 14, 9, 0))).toBe(at(2026, 10, 15, 9, 0));
    expect(nextRun(daily, at(2026, 10, 14, 23, 59))).toBe(at(2026, 10, 15, 9, 0));
  });

  it("skips the weekend for a weekday routine", () => {
    const weekdays: Schedule = { kind: "weekdays", at: "09:00" };
    // Thursday 15 October 2026 after the time: Friday. Friday after it: Monday.
    expect(nextRun(weekdays, at(2026, 10, 15, 10))).toBe(at(2026, 10, 16, 9));
    expect(nextRun(weekdays, at(2026, 10, 16, 10))).toBe(at(2026, 10, 19, 9));
    expect(nextRun(weekdays, at(2026, 10, 17, 12))).toBe(at(2026, 10, 19, 9));
    expect(nextRun(weekdays, at(2026, 10, 18, 12))).toBe(at(2026, 10, 19, 9));
  });

  it("is the chosen day of the week, a week on when that is today and passed", () => {
    const monday: Schedule = { kind: "weekly", day: 1, at: "08:30" };
    expect(nextRun(monday, at(2026, 10, 14, 9))).toBe(at(2026, 10, 19, 8, 30));
    expect(nextRun(monday, at(2026, 10, 19, 8, 29))).toBe(at(2026, 10, 19, 8, 30));
    expect(nextRun(monday, at(2026, 10, 19, 8, 30))).toBe(at(2026, 10, 26, 8, 30));
  });

  it("goes across a month's and a year's end", () => {
    expect(nextRun({ kind: "daily", at: "09:00" }, at(2026, 12, 31, 12))).toBe(at(2027, 1, 1, 9));
    expect(nextRun({ kind: "weekly", day: 5, at: "09:00" }, at(2026, 10, 30, 10))).toBe(at(2026, 11, 6, 9));
  });

  describe("when the clocks change", () => {
    it("keeps the same time on the day the clocks go forward (8 March), an hour of real time shorter", () => {
      const daily: Schedule = { kind: "daily", at: "09:00" };
      const before = at(2026, 3, 7, 9, 0);
      const after = nextRun(daily, before);
      expect(after).toBe(at(2026, 3, 8, 9, 0));
      expect(after - before).toBe(23 * 60 * MIN);
    });

    it("keeps the same time on the day the clocks go back (1 November), an hour of real time longer", () => {
      const daily: Schedule = { kind: "daily", at: "09:00" };
      const before = at(2026, 10, 31, 9, 0);
      const after = nextRun(daily, before);
      expect(after).toBe(at(2026, 11, 1, 9, 0));
      expect(after - before).toBe(25 * 60 * MIN);
    });

    it("runs a 02:30 routine at 03:30 on the day that hour doesn't exist, and once on the next", () => {
      const daily: Schedule = { kind: "daily", at: "02:30" };
      const gap = nextRun(daily, at(2026, 3, 7, 3, 0));
      expect(new Date(gap).getDate()).toBe(8);
      expect(new Date(gap).getHours()).toBe(3);
      // Run at 03:30; the next is the next day's 02:30, not another that day.
      expect(nextRun(daily, gap)).toBe(at(2026, 3, 9, 2, 30));
    });

    it("runs a 01:30 routine once on the day that hour happens twice", () => {
      const daily: Schedule = { kind: "daily", at: "01:30" };
      const first = nextRun(daily, at(2026, 10, 31, 12));
      expect(first).toBe(at(2026, 11, 1, 1, 30));
      expect(nextRun(daily, first)).toBe(at(2026, 11, 2, 1, 30));
    });

    it("counts an every-N-hours gap in real time across the change", () => {
      const now = at(2026, 3, 8, 0, 30);
      expect(nextRun({ kind: "every", every: 3, unit: "hours" }, now)).toBe(now + 3 * 60 * MIN);
    });
  });
});

describe("validSchedule", () => {
  it("wants a gap of at least five minutes, a real time and a real day", () => {
    expect(validSchedule({ kind: "every", every: 4, unit: "minutes" })).toBe(false);
    expect(validSchedule({ kind: "every", every: 5, unit: "minutes" })).toBe(true);
    expect(validSchedule({ kind: "every", every: 1.5, unit: "hours" })).toBe(false);
    expect(validSchedule({ kind: "every", every: 1000, unit: "hours" })).toBe(false);
    expect(validSchedule({ kind: "daily", at: "24:00" })).toBe(false);
    expect(validSchedule({ kind: "daily", at: "9:00" })).toBe(false);
    expect(validSchedule({ kind: "weekdays", at: "09:00" })).toBe(true);
    expect(validSchedule({ kind: "weekly", day: 7, at: "09:00" })).toBe(false);
    expect(validSchedule({ kind: "weekly", day: 0, at: "09:00" })).toBe(true);
  });
});

describe("describeSchedule", () => {
  it("says it in words", () => {
    expect(describeSchedule({ kind: "every", every: 30, unit: "minutes" })).toBe("Every 30 minutes");
    expect(describeSchedule({ kind: "every", every: 1, unit: "hours" })).toBe("Every hour");
    expect(describeSchedule({ kind: "daily", at: "09:00" })).toMatch(/^Every day at 9:00/);
    expect(describeSchedule({ kind: "weekdays", at: "09:00" })).toMatch(/^Every weekday at 9:00/);
    expect(describeSchedule({ kind: "weekly", day: 1, at: "17:15" })).toMatch(/^Every Monday at 5:15/);
  });
});

describe("when", () => {
  const now = at(2026, 10, 14, 12);
  it("names the day only when it isn't today", () => {
    expect(when(at(2026, 10, 14, 9), now)).toMatch(/^9:00/);
    expect(when(at(2026, 10, 15, 9), now)).toMatch(/^Tomorrow 9:00/);
    expect(when(at(2026, 10, 13, 9), now)).toMatch(/^Yesterday 9:00/);
    expect(when(at(2026, 10, 16, 9), now)).toMatch(/^Fri 9:00/);
    expect(when(at(2026, 11, 20, 9), now)).toMatch(/^Nov 20, 9:00/);
  });
});

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
    nextAt: at(2026, 10, 14, 9),
    pausedUntil: null,
    runs: [],
    ...patch,
  };
}
const ctx = (now: number, patch: Partial<Context> = {}): Context => ({ now, planUsed: 0.3, ready: true, ...patch });

describe("tick", () => {
  it("does nothing before a routine is due, or while it is off", () => {
    const r = routine();
    expect(tick([r], ctx(at(2026, 10, 14, 8, 59)))).toEqual({ routines: [r], start: [] });
    const off = routine({ enabled: false, nextAt: null });
    expect(tick([off], ctx(at(2026, 10, 14, 10)))).toEqual({ routines: [off], start: [] });
  });

  it("starts a routine that is due and sets its next time", () => {
    const now = at(2026, 10, 14, 9, 0) + 20_000;
    const { routines, start } = tick([routine()], ctx(now));
    expect(start).toEqual(["r1"]);
    expect(routines[0].nextAt).toBe(at(2026, 10, 15, 9));
    expect(routines[0].runs).toEqual([{ at: now, outcome: "running" }]);
  });

  it("starts one that is nearly late but still on time", () => {
    const now = at(2026, 10, 14, 9) + MISSED_AFTER_MS;
    expect(tick([routine()], ctx(now)).start).toEqual(["r1"]);
  });

  it("records a run that was due long ago as missed, once, and doesn't replay it", () => {
    const now = at(2026, 10, 14, 11, 30);
    const first = tick([routine()], ctx(now));
    expect(first.start).toEqual([]);
    expect(first.routines[0].runs).toEqual([{ at: at(2026, 10, 14, 9), outcome: "missed" }]);
    expect(first.routines[0].nextAt).toBe(at(2026, 10, 15, 9));
    // Looking again changes nothing: the missed run is there once.
    expect(tick(first.routines, ctx(now + 30_000)).routines).toEqual(first.routines);
  });

  it("counts a whole weekend closed as one missed run, and runs the next one on time", () => {
    const r = routine({ nextAt: at(2026, 10, 16, 9) });
    const monday = at(2026, 10, 19, 8, 0);
    const { routines } = tick([r], ctx(monday));
    expect(routines[0].runs).toHaveLength(1);
    expect(routines[0].runs[0]).toEqual({ at: at(2026, 10, 16, 9), outcome: "missed" });
    expect(routines[0].nextAt).toBe(at(2026, 10, 19, 9));
    expect(tick(routines, ctx(at(2026, 10, 19, 9, 0) + 5_000)).start).toEqual(["r1"]);
  });

  it("treats a Mac that woke from sleep an hour after the time as missed, and the next day's run as normal", () => {
    // Asleep from 08:50, awake at 10:05: the 09:00 run is missed.
    const woke = tick([routine()], ctx(at(2026, 10, 14, 10, 5)));
    expect(woke.routines[0].runs[0].outcome).toBe("missed");
    // Awake all night: the next morning's time is on time.
    expect(tick(woke.routines, ctx(at(2026, 10, 15, 9, 0, ) + 10_000)).start).toEqual(["r1"]);
  });

  it("starts an every-hour routine after a short sleep but marks a long one missed", () => {
    const hourly = routine({ schedule: { kind: "every", every: 1, unit: "hours" }, nextAt: at(2026, 10, 14, 10) });
    expect(tick([hourly], ctx(at(2026, 10, 14, 10, 1))).start).toEqual(["r1"]);
    const long = tick([hourly], ctx(at(2026, 10, 14, 13)));
    expect(long.start).toEqual([]);
    expect(long.routines[0].runs[0]).toEqual({ at: at(2026, 10, 14, 10), outcome: "missed" });
    expect(long.routines[0].nextAt).toBe(at(2026, 10, 14, 14));
  });

  it("skips a routine whose last run is still going, and says so", () => {
    const busy = routine({ runs: [{ at: at(2026, 10, 13, 9), outcome: "running" }] });
    const now = at(2026, 10, 14, 9, 0) + 1_000;
    const { routines, start } = tick([busy], ctx(now));
    expect(start).toEqual([]);
    expect(routines[0].runs[0]).toEqual({ at: now, outcome: "skipped", note: "the last run is still going" });
    expect(routines[0].nextAt).toBe(at(2026, 10, 15, 9));
  });

  it("counts a run that waits for the user as still going", () => {
    const waiting = routine({ runs: [{ at: at(2026, 10, 13, 9), outcome: "waiting" }] });
    expect(tick([waiting], ctx(at(2026, 10, 14, 9, 0) + 1_000)).routines[0].runs[0].outcome).toBe("skipped");
  });

  it("skips every routine when the plan is at 95% or more, and says so", () => {
    const now = at(2026, 10, 14, 9, 0) + 1_000;
    const { routines, start } = tick([routine(), routine({ id: "r2" })], ctx(now, { planUsed: 0.95 }));
    expect(start).toEqual([]);
    expect(routines.map((r) => r.runs[0])).toEqual([
      { at: now, outcome: "skipped", note: "the plan is at 95%" },
      { at: now, outcome: "skipped", note: "the plan is at 95%" },
    ]);
    expect(tick([routine()], ctx(now, { planUsed: 0.94 })).start).toEqual(["r1"]);
    // Not told yet: no reason to hold back.
    expect(tick([routine()], ctx(now, { planUsed: null })).start).toEqual(["r1"]);
  });

  it(`starts at most ${MAX_AT_ONCE} routine chats at once, counting those already working`, () => {
    const now = at(2026, 10, 14, 9, 0) + 1_000;
    const three = ["a", "b", "c"].map((id) => routine({ id }));
    const one = tick(three, ctx(now));
    expect(one.start).toEqual(["a", "b"]);
    expect(one.routines[2].runs[0]).toEqual({ at: now, outcome: "skipped", note: "2 routines were already running" });
    const working = routine({ id: "w", nextAt: at(2026, 10, 15, 9), runs: [{ at: now - 1000, outcome: "running" }] });
    expect(tick([working, ...three], ctx(now)).start).toEqual(["a"]);
  });

  it("lets a paused routine go by without a run or a note, and runs again after the hour", () => {
    const now = at(2026, 10, 14, 9, 0) + 1_000;
    const paused = routine({ pausedUntil: now + 30 * MIN });
    const { routines, start } = tick([paused], ctx(now));
    expect(start).toEqual([]);
    expect(routines[0].runs).toEqual([]);
    expect(routines[0].nextAt).toBe(at(2026, 10, 15, 9));
    const often = routine({ schedule: { kind: "every", every: 5, unit: "minutes" }, nextAt: now, pausedUntil: now + 1_000 });
    expect(tick([often], ctx(now + 500)).start).toEqual([]);
    expect(tick([often], ctx(now + 2_000)).start).toEqual(["r1"]);
  });

  it("waits, still due, until claude is found; and misses the run if that takes too long", () => {
    const now = at(2026, 10, 14, 9, 0) + 1_000;
    const waiting = tick([routine()], ctx(now, { ready: false }));
    expect(waiting.routines[0]).toEqual(routine());
    expect(tick(waiting.routines, ctx(now + 10_000)).start).toEqual(["r1"]);
    expect(tick(waiting.routines, ctx(now + 10 * MIN, { ready: false })).routines[0].runs[0].outcome).toBe("missed");
  });

  it("gives a routine switched on with no time saved its next one", () => {
    const now = at(2026, 10, 14, 7);
    expect(tick([routine({ nextAt: null })], ctx(now)).routines[0].nextAt).toBe(at(2026, 10, 14, 9));
  });

  it("keeps the ten latest runs", () => {
    const old = Array.from({ length: MAX_RUNS }, (_, i) => ({ at: i, outcome: "done" as const }));
    const now = at(2026, 10, 14, 9, 0) + 1_000;
    const runs = tick([routine({ runs: old })], ctx(now)).routines[0].runs;
    expect(runs).toHaveLength(MAX_RUNS);
    expect(runs[0].at).toBe(now);
    expect(runs[MAX_RUNS - 1].at).toBe(MAX_RUNS - 2);
  });
});

describe("skipReason", () => {
  it("names the first reason in plain words, or none", () => {
    expect(skipReason(routine(), { planUsed: 0.2 }, 0)).toBeNull();
    expect(skipReason(routine(), { planUsed: 0.97 }, 0)).toBe("the plan is at 97%");
    expect(skipReason(routine(), { planUsed: 0.2 }, 2)).toBe("2 routines were already running");
    expect(skipReason(routine({ runs: [{ at: 1, outcome: "running" }] }), { planUsed: 0.99 }, 2)).toBe("the last run is still going");
  });
});

describe("runNow", () => {
  const now = at(2026, 10, 14, 15);
  it("starts a run at the top of the history and leaves the schedule alone", () => {
    const r = routine({ nextAt: at(2026, 10, 15, 9) });
    const out = runNow([r], "r1", ctx(now));
    expect(out.error).toBeNull();
    expect(out.routines[0].runs).toEqual([{ at: now, outcome: "running", manual: true }]);
    expect(out.routines[0].nextAt).toBe(at(2026, 10, 15, 9));
  });

  it("runs a routine that is off, or paused, when asked", () => {
    expect(runNow([routine({ enabled: false, nextAt: null })], "r1", ctx(now)).error).toBeNull();
    expect(runNow([routine({ pausedUntil: now + MIN })], "r1", ctx(now)).error).toBeNull();
  });

  it("says no, and writes nothing, for each rule", () => {
    const busy = routine({ runs: [{ at: 1, outcome: "waiting" }] });
    expect(runNow([busy], "r1", ctx(now))).toEqual({ routines: [busy], error: "Not started: the last run is still going." });
    expect(runNow([routine()], "r1", ctx(now, { planUsed: 0.96 })).error).toBe("Not started: the plan is at 96%.");
    const two = [routine({ id: "a", runs: [{ at: 1, outcome: "running" }] }), routine({ id: "b", runs: [{ at: 1, outcome: "running" }] }), routine({ id: "c" })];
    expect(runNow(two, "c", ctx(now)).error).toBe("Not started: 2 routines were already running.");
    expect(runNow([routine()], "r1", ctx(now, { ready: false })).error).toBe("Claude isn't ready yet.");
    expect(runNow([routine()], "nope", ctx(now)).error).toBe("That routine is gone.");
  });
});

describe("a run's life", () => {
  it("settles runs that were working when Lantern closed", () => {
    const r = routine({ runs: [{ at: 3, outcome: "waiting" }, { at: 2, outcome: "done" }, { at: 1, outcome: "running" }] });
    expect(settleStale([r])[0].runs.map((x) => x.outcome)).toEqual(["stopped", "done", "stopped"]);
    expect(settleStale([r])[0].runs[0].note).toBe("Lantern was closed");
  });

  it("updates the run that started at a time, only while it is in progress", () => {
    const r = routine({ runs: [{ at: 5, outcome: "running" }, { at: 4, outcome: "done" }] });
    expect(updateRun(r, 5, { sessionId: "abc" }).runs[0]).toEqual({ at: 5, outcome: "running", sessionId: "abc" });
    expect(updateRun(r, 4, { outcome: "failed" }).runs[1].outcome).toBe("done");
  });

  it("says each outcome in words", () => {
    const now = at(2026, 10, 14, 12);
    expect(outcomeText({ at: now, outcome: "done" }, now)).toBe("Finished");
    expect(outcomeText({ at: now, outcome: "waiting" }, now)).toBe("Waiting for you");
    expect(outcomeText({ at: now, outcome: "failed", note: "no network" }, now)).toBe("Failed: no network");
    expect(outcomeText({ at: now, outcome: "skipped", note: "the plan is at 95%" }, now)).toBe("Skipped: the plan is at 95%");
    expect(outcomeText({ at: at(2026, 10, 14, 9), outcome: "missed" }, now)).toMatch(/^Missed 9:00/);
  });

  it("titles the chats a routine started, by session", () => {
    const r = routine({ runs: [{ at: 2, outcome: "done", sessionId: "s-2" }, { at: 1, outcome: "skipped" }] });
    expect(routineTitles([r])).toEqual({ "s-2": "Routine: Morning TODOs" });
  });
});

describe("withEnabled and withPause", () => {
  const now = at(2026, 10, 14, 12);
  it("makes a routine switched on due at its next time, and clears it when off", () => {
    const off = routine({ enabled: false, nextAt: null, pausedUntil: now + 5 });
    const on = withEnabled(off, true, now);
    expect(on.enabled).toBe(true);
    expect(on.nextAt).toBe(at(2026, 10, 15, 9));
    const back = withEnabled(on, false, now);
    expect(back).toMatchObject({ enabled: false, nextAt: null, pausedUntil: null });
  });

  it("pauses for an hour and resumes", () => {
    expect(withPause(routine(), true, now).pausedUntil).toBe(now + ROUTINE_PAUSE_MS);
    expect(withPause(routine({ pausedUntil: now + 1 }), false, now).pausedUntil).toBeNull();
  });
});

describe("draftProblem and newRoutine", () => {
  const draft = { name: "Tests", folder: "/p", prompt: "Run the tests", schedule: { kind: "every", every: 1, unit: "hours" } as Schedule };
  it("wants a name, a project, a prompt and a schedule that works", () => {
    expect(draftProblem(draft)).toBeNull();
    expect(draftProblem({ ...draft, name: "  " })).toMatch(/name/);
    expect(draftProblem({ ...draft, folder: "" })).toMatch(/project/);
    expect(draftProblem({ ...draft, prompt: " " })).toMatch(/what Claude should do/);
    expect(draftProblem({ ...draft, prompt: "x".repeat(20_001) })).toMatch(/too long/);
    expect(draftProblem({ ...draft, schedule: { kind: "every", every: 1, unit: "minutes" } })).toMatch(/at least 5 minutes/);
    expect(draftProblem({ ...draft, schedule: { kind: "daily", at: "" } })).toMatch(/time/);
  });

  it("makes a routine that is on and due at its next time", () => {
    const now = at(2026, 10, 14, 12);
    const r = newRoutine({ ...draft, permissions: "ask", model: "sonnet" }, "x", now);
    expect(r).toMatchObject({ id: "x", enabled: true, nextAt: now + 60 * MIN, runs: [], pausedUntil: null });
  });
});

describe("readRoutines", () => {
  it("reads what newRoutine wrote", () => {
    const r = newRoutine({ name: "A", folder: "/p", prompt: "go", schedule: { kind: "weekly", day: 2, at: "10:00" }, permissions: "auto", model: null }, "a", at(2026, 10, 14, 12));
    expect(readRoutines(JSON.parse(JSON.stringify([r])))).toEqual([r]);
  });

  it("drops what doesn't read and takes the safe value for what isn't allowed", () => {
    const good = routine();
    const out = readRoutines([
      "nope",
      null,
      { ...good, id: "" },
      { ...good, id: "b", schedule: { kind: "daily", at: "99:99" } },
      { ...good, id: "c", permissions: "bypass", model: "gpt-9" },
      { ...good, id: "d", permissions: "auto" },
      { ...good, id: "d" },
      { ...good, id: "e", runs: [{ at: 1, outcome: "exploded" }, { at: "x", outcome: "done" }, { at: 2, outcome: "done", sessionId: 5 }] },
    ]);
    expect(out.map((r) => r.id)).toEqual(["c", "d", "e"]);
    expect(out[0]).toMatchObject({ permissions: "ask", model: "sonnet" });
    expect(out[1].permissions).toBe("auto");
    expect(out[2].runs).toEqual([{ at: 2, outcome: "done" }]);
    expect(readRoutines({})).toEqual([]);
    expect(readRoutines(undefined)).toEqual([]);
  });

  it("cuts the list, the name and the prompt to their limits", () => {
    const many = Array.from({ length: MAX_ROUTINES + 5 }, (_, i) => routine({ id: `r${i}`, name: "n".repeat(100), prompt: "p".repeat(30_000) }));
    const out = readRoutines(many);
    expect(out).toHaveLength(MAX_ROUTINES);
    expect(out[0].name).toHaveLength(60);
    expect(out[0].prompt).toHaveLength(20_000);
  });
});
