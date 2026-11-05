import { matchCommands, slashQuery } from "./slash";
import { contextOf, progressOf, shortTokens, untilText, usageOf, weekForecast, weekOf, windowOf } from "./plan";

const todo = (content: string, status: string, active_form = `${content}…`) => ({ content, status, active_form });

describe("the plan", () => {
  it("counts what is done and says what is being done now", () => {
    const p = progressOf([todo("A", "completed"), todo("B", "in_progress", "Doing B"), todo("C", "pending")]);
    expect(p).toEqual({ done: 1, total: 3, current: "Doing B", finished: false });
  });

  it("names the first not done when nothing is in progress, and is finished when all are done", () => {
    expect(progressOf([todo("A", "completed"), todo("B", "pending")]).current).toBe("B");
    expect(progressOf([todo("A", "completed")])).toEqual({ done: 1, total: 1, current: null, finished: true });
    expect(progressOf([])).toEqual({ done: 0, total: 0, current: null, finished: false });
  });
});

describe("the usage", () => {
  const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
  const at = (min: number) => NOW / 1000 + min * 60;

  it("is a whole percent with when it resets", () => {
    expect(usageOf({ used: 0.426, resetsAt: at(130), status: "allowed" }, NOW)).toEqual({ percent: 43, resets: "Resets in 2 h 10 min", tone: "ok" });
    expect(usageOf({ used: 0.1, resetsAt: null, status: "allowed" }, NOW).resets).toBe("");
  });

  it("stays green however Claude words its warning, until the bar itself is at 80%", () => {
    // Claude's allowed_warning can be about a limit other than the five-hour window the bar shows.
    expect(usageOf({ used: 0.05, resetsAt: null, status: "allowed_warning" }, NOW).tone).toBe("ok");
    expect(usageOf({ used: 0.5, resetsAt: null, status: "allowed_warning" }, NOW).tone).toBe("ok");
    expect(usageOf({ used: 0.8, resetsAt: null, status: "allowed_warning" }, NOW).tone).toBe("warn");
  });

  it("warns near the limit and stops at it", () => {
    expect(usageOf({ used: 0.85, resetsAt: null, status: "allowed" }, NOW).tone).toBe("warn");
    expect(usageOf({ used: 0.8, resetsAt: null, status: "allowed" }, NOW).tone).toBe("warn");
    expect(usageOf({ used: 0.79, resetsAt: null, status: "allowed" }, NOW).tone).toBe("ok");
    expect(usageOf({ used: 1.2, resetsAt: null, status: "allowed" }, NOW)).toMatchObject({ percent: 100, tone: "stop" });
    expect(usageOf({ used: 0.9, resetsAt: null, status: "rejected" }, NOW).tone).toBe("stop");
  });

  it("says a time in hours and minutes, or soon", () => {
    const NOW2 = 1_000_000_000;
    expect(untilText(NOW2 / 1000 + 35 * 60, NOW2)).toBe("35 min");
    expect(untilText(NOW2 / 1000 + 120 * 60, NOW2)).toBe("2 h");
    expect(untilText(NOW2 / 1000 - 5, NOW2)).toBe("soon");
  });
});

describe("the context", () => {
  it("is a share of the window, warning at 75 and 90 as the Mac's meter does", () => {
    expect(contextOf({ tokens: 62_000, window: 200_000 })).toEqual({ percent: 31, label: "31% of context", tone: "ok" });
    expect(contextOf({ tokens: 150_000, window: 200_000 }).tone).toBe("warn");
    expect(contextOf({ tokens: 185_000, window: 200_000 }).tone).toBe("stop");
  });

  it("is only the tokens while nothing says the window, or when the window is below what is held", () => {
    expect(contextOf({ tokens: 84_000, window: null })).toEqual({ percent: null, label: "84k tokens", tone: "ok" });
    expect(contextOf({ tokens: 250_000, window: 200_000 }).percent).toBeNull();
  });

  it("says a count short", () => {
    expect([shortTokens(900), shortTokens(84_400), shortTokens(1_200_000), shortTokens(2_000_000)]).toEqual(["900", "84k", "1.2M", "2M"]);
  });
});

describe("slash commands", () => {
  const c = (name: string) => ({ name, description: "", argument_hint: "" });
  const all = [c("compact"), c("review"), c("compact-notes"), c("pr-review"), c("init")];

  it("tells a command being typed from other text", () => {
    expect(slashQuery("/rev")).toBe("rev");
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/review this")).toBeNull();
    expect(slashQuery("hello /x")).toBeNull();
  });

  it("puts names that start with it first, then a part that starts with it, then those that contain it, shorter first", () => {
    expect(matchCommands(all, "rev").map((x) => x.name)).toEqual(["review", "pr-review"]);
    expect(matchCommands(all, "comp").map((x) => x.name)).toEqual(["compact", "compact-notes"]);
    expect(matchCommands(all, "it").map((x) => x.name)).toEqual(["init"]);
    expect(matchCommands(all, "zzz")).toEqual([]);
    expect(matchCommands(all, "", 2)).toHaveLength(2);
  });
});

describe("the weekly limit's pace", () => {
  const DAY = 24 * 3600;
  const RESET = 1_800_000_000;
  const at = (days: number) => (RESET - 7 * DAY + days * DAY) * 1000;

  it("carries what is used so far on at the same pace, to when it runs out and where it is by the reset", () => {
    const f = weekForecast({ used: 0.7, resetsAt: RESET }, at(3.5))!;
    expect(f.byReset).toBeCloseTo(1.4, 6);
    expect(f.runsOutAt).toBeCloseTo(RESET - 7 * DAY + 5 * DAY, 3);
    expect(weekForecast({ used: 0.3, resetsAt: RESET }, at(3.5))!.runsOutAt).toBeNull();
  });

  it("makes no forecast from the first hours of a week, from nothing used, from an unknown reset or from a window that is over", () => {
    expect(weekForecast({ used: 0.2, resetsAt: RESET }, at(0.1))).toBeNull();
    expect(weekForecast({ used: 0, resetsAt: RESET }, at(3))).toBeNull();
    expect(weekForecast({ used: 0.5, resetsAt: null }, at(3))).toBeNull();
    expect(weekForecast({ used: 0.5, resetsAt: RESET }, (RESET + 10) * 1000)).toBeNull();
  });

  it("says it in words, amber when the pace runs it out before the reset and red at the limit", () => {
    const out = weekOf({ used: 0.7, resetsAt: RESET }, at(3.5));
    expect(out).toMatchObject({ percent: 70, tone: "warn" });
    expect(out.short).toMatch(/^Out /);
    expect(out.sentence).toMatch(/^70% of the weekly limit used\. At this pace it runs out .*, before it resets /);
    const calm = weekOf({ used: 0.3, resetsAt: RESET }, at(3.5));
    expect(calm).toMatchObject({ percent: 30, short: "On pace for 60%", tone: "ok" });
    expect(weekOf({ used: 0.2, resetsAt: RESET }, at(0.1)).sentence).toMatch(/Too early in the week to tell/);
    expect(weekOf({ used: 1, resetsAt: RESET }, at(4))).toMatchObject({ percent: 100, tone: "stop" });
    expect(weekOf({ used: 0.4, resetsAt: null }, at(4))).toMatchObject({ percent: 40, short: "", sentence: "40% of the weekly limit used." });
    expect(weekOf({ used: 0.85, resetsAt: RESET }, at(6.9)).tone).toBe("warn");
  });
});

describe("a provider's usage window", () => {
  const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
  const at = (minutes: number) => NOW / 1000 + minutes * 60;

  it("is a session with how long until it resets, never a full date", () => {
    const w = windowOf({ label: "Session", used: 0.42, resets_at: at(130), minutes: 300 }, NOW);
    expect(w).toEqual({ title: "Session", percent: 42, note: "Five-hour window · resets in 2 h 10 min", short: "Resets in 2 h 10 min", tone: "ok" });
  });

  it("is a weekly limit with where the pace leads, as the Mac's week row says it", () => {
    const w = windowOf({ label: "Week", used: 0.3, resets_at: at(3 * 24 * 60), minutes: 10080 }, NOW);
    expect(w.title).toBe("Weekly limit");
    expect(w.note).not.toMatch(/\d{4}|, \d/);
    expect(w.note).toMatch(/pace|resets/);
  });

  it("names another window by its own label and says the day it resets when that is more than a day away", () => {
    const w = windowOf({ label: "2 hours", used: 0.85, resets_at: at(30 * 60), minutes: 120 }, NOW);
    expect(w.title).toBe("2 hours");
    expect(w.tone).toBe("warn");
    expect(w.note).toMatch(/^Resets (tomorrow|\w{3}) \d\d:\d\d$/);
  });

  it("is red at the limit, and says nothing of a reset it wasn't told", () => {
    expect(windowOf({ label: "Session", used: 1, resets_at: null, minutes: 300 }, NOW)).toEqual({ title: "Session", percent: 100, note: "", short: "", tone: "stop" });
  });
});
