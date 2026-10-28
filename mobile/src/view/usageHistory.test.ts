import type { PlanUsage } from "../sync/reducer";
import { dailyBars, daysKnown, HOUR_MS, KEEP_HOURS, parseBuckets, record, toRaw } from "./usageHistory";

const plan = (used: number, week?: number): PlanUsage => ({ used, resetsAt: null, status: "allowed", ...(week !== undefined ? { week: { used: week, resetsAt: null } } : {}) });
// A fixed local midday, so "today" and the hours around it fall on one day in any timezone.
const NOW = new Date(2026, 9, 27, 12, 0, 0).getTime();

describe("record", () => {
  it("keeps the highest five-hour use of an hour and the latest weekly one", () => {
    let b = record([], plan(0.3, 0.1), NOW);
    b = record(b, plan(0.5, 0.12), NOW + 60_000);
    b = record(b, plan(0.2), NOW + 120_000);
    expect(b).toEqual([{ h: Math.floor(NOW / HOUR_MS), five: 50, week: 12 }]);
  });

  it("makes a bucket per hour, oldest first, and lets the oldest go after two weeks", () => {
    let b: ReturnType<typeof record> = [];
    for (let n = 0; n < KEEP_HOURS + 5; n++) b = record(b, plan(0.1), NOW + n * HOUR_MS);
    expect(b).toHaveLength(KEEP_HOURS);
    expect(b[0].h).toBeLessThan(b[1].h);
    expect(b.at(-1)!.h).toBe(Math.floor((NOW + (KEEP_HOURS + 4) * HOUR_MS) / HOUR_MS));
  });

  it("clamps what the Mac says to 0 to 100", () => {
    expect(record([], plan(1.7, -3), NOW)[0]).toMatchObject({ five: 100, week: 0 });
  });
});

describe("dailyBars", () => {
  it("gives seven days, oldest first, today last, with the day's highest and a null for a day nothing was seen", () => {
    const hour = (back: number, h: number) => Math.floor(new Date(2026, 9, 27 - back, h).getTime() / HOUR_MS);
    const buckets = [
      { h: hour(0, 9), five: 40, week: null },
      { h: hour(0, 11), five: 70, week: null },
      { h: hour(2, 15), five: 95, week: null },
    ];
    const bars = dailyBars(buckets, NOW);
    expect(bars).toHaveLength(7);
    expect(bars[6]).toMatchObject({ peak: 70, today: true });
    expect(bars[4].peak).toBe(95);
    expect(bars[5].peak).toBeNull();
    expect(bars.filter((b) => b.today)).toHaveLength(1);
    // 27 October 2026 is a Tuesday.
    expect(bars[6].label).toBe("Tue");
  });
});

describe("daysKnown", () => {
  it("counts from the first hour kept", () => {
    expect(daysKnown([], NOW)).toBe(0);
    expect(daysKnown([{ h: Math.floor(NOW / HOUR_MS) - 2, five: 1, week: null }], NOW)).toBe(1);
    expect(daysKnown([{ h: Math.floor(NOW / HOUR_MS) - 24 * 3 - 2, five: 1, week: null }], NOW)).toBe(4);
  });
});

describe("what is kept", () => {
  it("round-trips, and drops what is not an hour", () => {
    const b = [{ h: 5, five: 10, week: null }, { h: 6, five: 20, week: 30 }];
    expect(parseBuckets(toRaw(b))).toEqual(b);
    expect(parseBuckets("nope")).toEqual([]);
    expect(parseBuckets([[1], "x", null, [2, 500, -4]])).toEqual([{ h: 2, five: 100, week: 0 }]);
  });
});
