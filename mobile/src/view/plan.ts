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
