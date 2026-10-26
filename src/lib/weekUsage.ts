import { useEffect, useState } from "react";

/**
 * How much of the subscription's weekly (seven-day) window is used, as the latest `rate_limit_event` said, and where the pace
 * so far leads: when the limit would be reached, if it is before the window resets. The account's, not a chat's.
 */
export interface WeekUsage {
  /** 0 to 1. */
  used: number;
  /** When the window resets, in unix seconds (null: not said). */
  resetsAt: number | null;
}

export const WEEK_SECS = 7 * 24 * 3600;
/** Less of the window than this has gone and a pace means nothing (the first hours of a week would say it ends in a day). */
export const MIN_ELAPSED_SECS = 6 * 3600;

const CHANGED = "lantern-week-usage";
let latest: WeekUsage | null = null;

export function setWeekUsage(w: WeekUsage): void {
  latest = w;
  window.dispatchEvent(new Event(CHANGED));
}

export function useWeekUsage(): WeekUsage | null {
  const [w, setW] = useState(latest);
  useEffect(() => {
    const sync = () => setW(latest);
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, []);
  return w;
}

export interface WeekForecast {
  /** Unix seconds the limit is reached at this pace, only when that is before the window resets. */
  runsOutAt: number | null;
  /** Where the pace leads by the reset: 1 is the limit, 0.74 is three quarters of it. */
  byReset: number;
}

/** The pace so far (what is used over how long the window has run) carried on to the end of the window. */
export function weekForecast(w: WeekUsage, now = Date.now()): WeekForecast | null {
  if (w.resetsAt === null || w.used <= 0) return null;
  const at = now / 1000;
  const start = w.resetsAt - WEEK_SECS;
  const gone = Math.min(at - start, WEEK_SECS);
  if (w.resetsAt <= at || gone < MIN_ELAPSED_SECS) return null;
  const rate = w.used / gone;
  const byReset = rate * WEEK_SECS;
  if (w.used >= 1) return { runsOutAt: at, byReset };
  return { runsOutAt: byReset >= 1 ? start + 1 / rate : null, byReset };
}

/** "today 18:20", "tomorrow 09:00", "Thu 18:20". */
export function whenText(unixSecs: number, now = Date.now()): string {
  const at = new Date(unixSecs * 1000);
  const clock = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(at) - day(new Date(now))) / 86_400_000);
  if (days === 0) return `today ${clock}`;
  if (days === 1) return `tomorrow ${clock}`;
  return `${at.toLocaleDateString([], { weekday: "short" })} ${clock}`;
}

/** "Week 31%", with " · out Thu 18:20" when the pace runs it out before the reset. */
export function weekLine(w: WeekUsage, now = Date.now()): string {
  const pct = `Week ${Math.round(w.used * 100)}%`;
  const f = weekForecast(w, now);
  return f?.runsOutAt != null && w.used < 1 ? `${pct} · out ${whenText(f.runsOutAt, now)}` : w.used >= 1 ? `${pct} · limit reached` : pct;
}

/** The sentence for the pop-over and the tooltip: where the week stands and where the pace leads. */
export function weekSentence(w: WeekUsage, now = Date.now()): string {
  const pct = Math.round(w.used * 100);
  const reset = w.resetsAt === null ? "" : ` It resets ${whenText(w.resetsAt, now)}.`;
  if (w.used >= 1) return `Weekly limit reached.${reset}`;
  const f = weekForecast(w, now);
  const head = `Week: ${pct}% of the weekly limit used.`;
  if (f === null) return w.resetsAt !== null && w.used > 0 && w.resetsAt * 1000 > now ? `${head}${reset} Too early in the week to tell where it is heading.` : `${head}${reset}`;
  if (f.runsOutAt !== null) return `${head} At this pace it runs out ${whenText(f.runsOutAt, now)}, before it resets ${whenText(w.resetsAt ?? 0, now)}.`;
  return `${head} At this pace about ${Math.round(f.byReset * 100)}% will be used by the reset (${whenText(w.resetsAt ?? 0, now)}).`;
}

/** "warn" when the pace runs it out before the reset or it is past 80%, "stop" at the limit. */
export function weekLevel(w: WeekUsage, now = Date.now()): "ok" | "warn" | "stop" {
  if (w.used >= 1) return "stop";
  return w.used >= 0.8 || weekForecast(w, now)?.runsOutAt != null ? "warn" : "ok";
}
