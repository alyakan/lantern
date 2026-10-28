import { describe, expect, it } from "vitest";
import { WEEK_SECS, weekForecast, weekLevel, weekLine, weekSentence } from "./weekUsage";

const DAY = 24 * 3600;
// A window that resets at 1_800_000_000 s; "now" is `days` into it.
const RESET = 1_800_000_000;
const at = (days: number) => (RESET - WEEK_SECS + days * DAY) * 1000;

describe("the weekly limit's pace", () => {
  it("carries what is used so far on at the same pace, to when it runs out and where it is by the reset", () => {
    // 70% in three and a half days: at that pace it is all used 5 days in, two days before the reset.
    const f = weekForecast({ used: 0.7, resetsAt: RESET }, at(3.5))!;
    expect(f.byReset).toBeCloseTo(1.4, 6);
    expect(f.runsOutAt).toBeCloseTo(RESET - WEEK_SECS + 5 * DAY, 3);
  });

  it("says nothing runs out when the pace ends the week under the limit", () => {
    const f = weekForecast({ used: 0.3, resetsAt: RESET }, at(3.5))!;
    expect(f.byReset).toBeCloseTo(0.6, 6);
    expect(f.runsOutAt).toBeNull();
  });

  it("makes no forecast from the first hours of a week, from nothing used, from an unknown reset or from a window that is over", () => {
    expect(weekForecast({ used: 0.2, resetsAt: RESET }, at(0.1))).toBeNull();
    expect(weekForecast({ used: 0, resetsAt: RESET }, at(3))).toBeNull();
    expect(weekForecast({ used: 0.5, resetsAt: null }, at(3))).toBeNull();
    expect(weekForecast({ used: 0.5, resetsAt: RESET }, (RESET + 10) * 1000)).toBeNull();
  });

  it("has run out already at the limit", () => {
    expect(weekForecast({ used: 1, resetsAt: RESET }, at(4))!.runsOutAt).toBe(at(4) / 1000);
  });

  it("warns when the pace runs it out before the reset or it is past 80%, and stops at the limit", () => {
    expect(weekLevel({ used: 0.7, resetsAt: RESET }, at(3.5))).toBe("warn");
    expect(weekLevel({ used: 0.3, resetsAt: RESET }, at(3.5))).toBe("ok");
    expect(weekLevel({ used: 0.85, resetsAt: RESET }, at(6.9))).toBe("warn");
    expect(weekLevel({ used: 1, resetsAt: RESET }, at(4))).toBe("stop");
  });

  it("says it in words: the percent, when it runs out, or where the pace ends", () => {
    expect(weekLine({ used: 0.3, resetsAt: RESET }, at(3.5))).toBe("Week 30%");
    expect(weekLine({ used: 0.7, resetsAt: RESET }, at(3.5))).toMatch(/^Week 70% · out /);
    expect(weekLine({ used: 1, resetsAt: RESET }, at(4))).toBe("Week 100% · limit reached");
    expect(weekSentence({ used: 0.7, resetsAt: RESET }, at(3.5))).toMatch(/70% of the weekly limit used\. At this pace it runs out .*, before it resets /);
    expect(weekSentence({ used: 0.3, resetsAt: RESET }, at(3.5))).toMatch(/At this pace about 60% will be used by the reset/);
    expect(weekSentence({ used: 0.2, resetsAt: RESET }, at(0.1))).toMatch(/Too early in the week to tell/);
    expect(weekSentence({ used: 1, resetsAt: RESET }, at(4))).toMatch(/^Weekly limit reached\. It resets /);
    expect(weekSentence({ used: 0.4, resetsAt: null }, at(4))).toBe("Week: 40% of the weekly limit used.");
  });
});
