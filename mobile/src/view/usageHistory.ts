/**
 * How much of the plan was used, over the last two weeks, as this phone saw it: one number per hour (the highest the five-hour
 * window reached in that hour, and the weekly window as it stood), kept small enough for the Keychain. It starts from the day
 * the phone first heard the numbers, and has gaps for any hour the phone was not connected: it says so rather than guess.
 */
import type { PlanUsage } from "../sync/reducer";

export interface Bucket {
  /** The hour, as whole hours since 1970 (UTC). */
  h: number;
  /** The five-hour window's highest use in the hour, 0 to 100. */
  five: number;
  /** The weekly window's use at the end of the hour, 0 to 100; null when the Mac did not say. */
  week: number | null;
}

export const HOUR_MS = 3_600_000;
/** How many hours are kept (two weeks). */
export const KEEP_HOURS = 24 * 14;

const pct = (used: number) => Math.max(0, Math.min(100, Math.round(used * 100)));

/** `buckets` with this reading in it (the hour's highest five-hour use, the latest weekly one); the oldest hours past the limit leave. */
export function record(buckets: Bucket[], plan: PlanUsage, now: number): Bucket[] {
  const h = Math.floor(now / HOUR_MS);
  const five = pct(plan.used);
  const week = plan.week ? pct(plan.week.used) : null;
  const next = [...buckets];
  const i = next.findIndex((b) => b.h === h);
  if (i >= 0) next[i] = { h, five: Math.max(next[i].five, five), week: week ?? next[i].week };
  else next.push({ h, five, week });
  return next
    .filter((b) => b.h > h - KEEP_HOURS)
    .sort((a, b) => a.h - b.h);
}

export interface DayBar {
  /** "Mon", "Tue", … */
  label: string;
  /** The highest five-hour use that day; null when the phone saw nothing that day. */
  peak: number | null;
  today: boolean;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The last `days` days, oldest first, each with the highest five-hour use the phone saw in it (days are the phone's own). */
export function dailyBars(buckets: Bucket[], now: number, days = 7): DayBar[] {
  const startOfDay = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const today = startOfDay(now);
  const bars: DayBar[] = [];
  for (let back = days - 1; back >= 0; back--) {
    const from = new Date(today);
    from.setDate(from.getDate() - back);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    const inDay = buckets.filter((b) => b.h * HOUR_MS >= from.getTime() && b.h * HOUR_MS < to.getTime());
    bars.push({ label: DAYS[from.getDay()], peak: inDay.length ? Math.max(...inDay.map((b) => b.five)) : null, today: back === 0 });
  }
  return bars;
}

/** How many days of history there are, from the first hour kept to now (0 when none). */
export function daysKnown(buckets: Bucket[], now: number): number {
  if (buckets.length === 0) return 0;
  return Math.max(1, Math.ceil((now - buckets[0].h * HOUR_MS) / (24 * HOUR_MS)));
}

/** Reads what was kept: anything that is not a list of well-formed hours is dropped. */
export function parseBuckets(raw: unknown): Bucket[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((r): Bucket[] => {
      if (!Array.isArray(r) || typeof r[0] !== "number" || typeof r[1] !== "number") return [];
      return [{ h: Math.trunc(r[0]), five: Math.max(0, Math.min(100, Math.trunc(r[1]))), week: typeof r[2] === "number" ? Math.max(0, Math.min(100, Math.trunc(r[2]))) : null }];
    })
    .slice(-KEEP_HOURS);
}

/** What is kept for each hour: `[hour, five, week]`, small. */
export const toRaw = (buckets: Bucket[]) => buckets.map((b) => (b.week === null ? [b.h, b.five] : [b.h, b.five, b.week]));
