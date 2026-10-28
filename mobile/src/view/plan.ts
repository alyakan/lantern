/** What the plan Claude keeps and the subscription's usage say in words. */
import type { RemoteTodo } from "../protocol/generated/RemoteTodo";
import type { PlanUsage } from "../sync/reducer";

export interface Progress {
  done: number;
  total: number;
  /** What Claude is doing now (the in-progress line's present form), else the first not done. */
  current: string | null;
  /** Every line done. */
  finished: boolean;
}

export function progressOf(todos: RemoteTodo[]): Progress {
  const done = todos.filter((t) => t.status === "completed").length;
  const now = todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status !== "completed");
  return { done, total: todos.length, current: now ? (now.status === "in_progress" ? now.active_form : now.content) : null, finished: todos.length > 0 && done === todos.length };
}

export interface Usage {
  /** Whole percent, 0 to 100. */
  percent: number;
  /** "Resets in 2 h 10 min", or "" when the Mac didn't say. */
  resets: string;
  tone: "ok" | "warn" | "stop";
}

/** How long until `at` (unix seconds) in the two biggest units that matter: "2 h 10 min", "35 min", "soon". */
export function untilText(at: number, now: number): string {
  const minutes = Math.round((at * 1000 - now) / 60000);
  if (minutes <= 1) return "soon";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** "190k", "1.2M": a token count short enough for a line. */
export function shortTokens(n: number): string {
  if (n < 1_000) return `${n}`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export interface Context {
  /** Of the window, whole percent, never over 100; null while nothing says what the window is. */
  percent: number | null;
  /** "62% of context" with a window, "84k tokens" without. */
  label: string;
  /** Amber and red from the same points the Mac's own meter warns at (75% and 90%). */
  tone: "ok" | "warn" | "stop";
}

/** How full a chat's context is. A window below what the chat already holds is wrong, so it isn't believed (as the Mac's meter does). */
export function contextOf(ctx: { tokens: number; window: number | null }): Context {
  const window = ctx.window && ctx.window >= ctx.tokens ? ctx.window : null;
  if (window === null) return { percent: null, label: `${shortTokens(ctx.tokens)} tokens`, tone: "ok" };
  const percent = Math.round(Math.min(ctx.tokens / window, 1) * 100);
  return { percent, label: `${percent}% of context`, tone: percent >= 90 ? "stop" : percent >= 75 ? "warn" : "ok" };
}

export function usageOf(plan: PlanUsage, now = Date.now()): Usage {
  const percent = Math.max(0, Math.min(100, Math.round(plan.used * 100)));
  const stopped = plan.status === "rejected" || percent >= 100;
  return {
    percent,
    resets: plan.resetsAt ? `Resets in ${untilText(plan.resetsAt, now)}` : "",
    // Yellow from 80% of the window, by the number on the bar: the Mac's own "allowed_warning" says Claude is warning about a
    // limit (it can be another window than the five-hour one this bar shows), and held the bar yellow at any usage.
    tone: stopped ? "stop" : percent >= 80 ? "warn" : "ok",
  };
}

const WEEK_SECS = 7 * 24 * 3600;
/** Less of the window than this has gone and a pace means nothing (the first hours of a week would say it ends in a day). */
const MIN_ELAPSED_SECS = 6 * 3600;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "today 18:20", "tomorrow 09:00", "Thu 18:20" (24-hour). */
export function whenText(unixSecs: number, now = Date.now()): string {
  const at = new Date(unixSecs * 1000);
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(at) - day(new Date(now))) / 86_400_000);
  if (days === 0) return `today ${clock}`;
  if (days === 1) return `tomorrow ${clock}`;
  return `${DAYS[at.getDay()]} ${clock}`;
}

export interface WeekForecast {
  /** Unix seconds the limit is reached at this pace, only when that is before the window resets. */
  runsOutAt: number | null;
  /** Where the pace leads by the reset: 1 is the limit. */
  byReset: number;
}

/** The pace so far (what is used over how long the window has run) carried on to the end of the window. */
export function weekForecast(week: { used: number; resetsAt: number | null }, now = Date.now()): WeekForecast | null {
  if (week.resetsAt === null || week.used <= 0) return null;
  const at = now / 1000;
  const start = week.resetsAt - WEEK_SECS;
  const gone = Math.min(at - start, WEEK_SECS);
  if (week.resetsAt <= at || gone < MIN_ELAPSED_SECS) return null;
  const rate = week.used / gone;
  const byReset = rate * WEEK_SECS;
  if (week.used >= 1) return { runsOutAt: at, byReset };
  return { runsOutAt: byReset >= 1 ? start + 1 / rate : null, byReset };
}

export interface Week {
  /** Whole percent, 0 to 100. */
  percent: number;
  /** Where the pace leads, short: "Out Thu 18:20", "On pace for 60%", "Resets Fri 09:00", or "" when nothing is known. */
  short: string;
  /** The same in a sentence, for the sheet and the screen reader. */
  sentence: string;
  /** Amber when the pace runs it out before the reset or it is past 80%, red at the limit. */
  tone: "ok" | "warn" | "stop";
}

/** The weekly window in words: how much is used and where the pace so far leads. */
export function weekOf(week: { used: number; resetsAt: number | null }, now = Date.now()): Week {
  const percent = Math.max(0, Math.min(100, Math.round(week.used * 100)));
  const reset = week.resetsAt !== null && week.resetsAt * 1000 > now ? whenText(week.resetsAt, now) : null;
  if (week.used >= 1) {
    return { percent, short: reset ? `Resets ${reset}` : "Limit reached", sentence: `Weekly limit reached.${reset ? ` It resets ${reset}.` : ""}`, tone: "stop" };
  }
  const f = weekForecast(week, now);
  const head = `${percent}% of the weekly limit used.`;
  if (f?.runsOutAt != null) {
    const out = whenText(f.runsOutAt, now);
    return { percent, short: `Out ${out}`, sentence: `${head} At this pace it runs out ${out}${reset ? `, before it resets ${reset}` : ""}.`, tone: "warn" };
  }
  const tone = percent >= 80 ? "warn" : "ok";
  if (f) return { percent, short: `On pace for ${Math.round(f.byReset * 100)}%`, sentence: `${head} At this pace about ${Math.round(f.byReset * 100)}% will be used by the reset${reset ? ` (${reset})` : ""}.`, tone };
  return { percent, short: reset ? `Resets ${reset}` : "", sentence: `${head}${reset ? ` It resets ${reset}.` : ""}${week.used > 0 && reset ? " Too early in the week to tell where it is heading." : ""}`, tone };
}
