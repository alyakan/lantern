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

export function usageOf(plan: PlanUsage, now = Date.now()): Usage {
  const percent = Math.max(0, Math.min(100, Math.round(plan.used * 100)));
  const stopped = plan.status === "rejected" || percent >= 100;
  return {
    percent,
    resets: plan.resetsAt ? `Resets in ${untilText(plan.resetsAt, now)}` : "",
    tone: stopped ? "stop" : plan.status === "allowed_warning" || percent >= 80 ? "warn" : "ok",
  };
}
