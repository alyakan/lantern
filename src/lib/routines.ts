import { MODEL_CHOICES } from "./models";
import { PLAN_STOP, type PlanUsage } from "./planUsage";
import type { Permissions } from "./workflow";

/**
 * Routines: a prompt Lantern sends by itself, at set times, in a new chat of a project. They run only while Lantern is
 * open and the Mac is awake; a run that was due when it wasn't is not made up (it shows as missed).
 */

export const ROUTINES_KEY = "settings.routines";
export const MAX_ROUTINES = 20;
/** How many past runs a routine keeps. */
export const MAX_RUNS = 10;
/** Routine chats working at once, over all routines. */
export const MAX_AT_ONCE = 2;
/** A run due this long ago or more is missed, not started: the app was closed or asleep, and a stale run isn't made up. */
export const MISSED_AFTER_MS = 2 * 60_000;
/** How often the scheduler looks (it also looks when the window wakes). */
export const TICK_MS = 30_000;
export const ROUTINE_PAUSE_MS = 60 * 60_000;
/** The shortest gap between runs of a routine that runs every so often: every run is a whole chat on the plan. */
export const MIN_EVERY_MINUTES = 5;
export const MAX_EVERY_MINUTES = 7 * 24 * 60;
export const MAX_NAME = 60;
export const MAX_PROMPT = 20_000;

export type Schedule =
  | { kind: "every"; every: number; unit: "minutes" | "hours" }
  | { kind: "daily"; at: string }
  | { kind: "weekdays"; at: string }
  | { kind: "weekly"; day: number; at: string };

export type RunOutcome = "running" | "waiting" | "done" | "failed" | "stopped" | "skipped" | "missed";

export interface Run {
  /** When it started (for a skipped or missed run, when it was due). */
  at: number;
  outcome: RunOutcome;
  /** Why it was skipped, or how it failed. */
  note?: string;
  /** The chat it ran in, once there is one: the link to open it. */
  sessionId?: string | null;
  /** Started with Run now. */
  manual?: boolean;
}

export interface Routine {
  id: string;
  name: string;
  folder: string;
  prompt: string;
  schedule: Schedule;
  permissions: Permissions;
  /** The model alias the chat runs on; null is Claude Code's own default. */
  model: string | null;
  enabled: boolean;
  /** When it is next due (ms); null while it is off. */
  nextAt: number | null;
  /** Paused until this time (ms). */
  pausedUntil: number | null;
  /** Newest first. */
  runs: Run[];
}

/** What a new routine starts with. */
export const DEFAULT_SCHEDULE: Schedule = { kind: "weekdays", at: "09:00" };
export const DEFAULT_MODEL = "sonnet";

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** A folder as a path on this Mac: absolute, and nothing a path can't hold. */
export const absolute = (path: unknown): path is string => typeof path === "string" && path.startsWith("/") && !path.includes("\0");
export const validTime = (at: unknown): at is string => typeof at === "string" && TIME.test(at);

/** The gap of an "every" schedule, in minutes. */
export const everyMinutes = (s: Extract<Schedule, { kind: "every" }>): number => s.every * (s.unit === "hours" ? 60 : 1);

/** Whether a schedule can run: a time that reads, a day of the week, and a gap that isn't too short or long. */
export function validSchedule(s: Schedule): boolean {
  if (s.kind === "every") {
    const m = Number.isInteger(s.every) ? everyMinutes(s) : 0;
    return (s.unit === "minutes" || s.unit === "hours") && m >= MIN_EVERY_MINUTES && m <= MAX_EVERY_MINUTES;
  }
  if (s.kind === "weekly" && !(Number.isInteger(s.day) && s.day >= 0 && s.day <= 6)) return false;
  return validTime(s.at);
}

/**
 * The next time `s` is due after `after` (ms), in this Mac's own time. A daily time that doesn't exist on the day the
 * clocks go forward runs when the clocks say it is that hour next; one that happens twice on the day they go back
 * runs the first time only. Never the same moment as `after`, so a run just made isn't made twice.
 */
export function nextRun(s: Schedule, after: number): number {
  if (s.kind === "every") return after + everyMinutes(s) * 60_000;
  const [h, m] = s.at.split(":").map(Number);
  const from = new Date(after);
  for (let offset = 0; offset <= 8; offset++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset, h, m, 0, 0);
    const dow = day.getDay();
    const fits = s.kind === "daily" || (s.kind === "weekdays" ? dow >= 1 && dow <= 5 : dow === s.day);
    if (fits && day.getTime() > after) return day.getTime();
  }
  // Not reachable for a valid schedule (some day in the next eight fits); an invalid one waits a day.
  return after + 24 * 60 * 60_000;
}

/** A clock time as the Mac shows it ("9:00 AM"). */
export const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const timeOfDay = (at: string): string => {
  const [h, m] = at.split(":").map(Number);
  return clock(new Date(2000, 0, 1, h, m).getTime());
};

/** "Every 30 minutes", "Every hour", "Every weekday at 9:00 AM", "Every Monday at 9:00 AM". */
export function describeSchedule(s: Schedule): string {
  switch (s.kind) {
    case "every":
      return s.every === 1 ? `Every ${s.unit === "hours" ? "hour" : "minute"}` : `Every ${s.every} ${s.unit}`;
    case "daily":
      return `Every day at ${timeOfDay(s.at)}`;
    case "weekdays":
      return `Every weekday at ${timeOfDay(s.at)}`;
    case "weekly":
      return `Every ${DAY_NAMES[s.day]} at ${timeOfDay(s.at)}`;
  }
}

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** "9:00 AM" for today, "Tomorrow 9:00 AM", "Yesterday 9:00 AM", "Mon 9:00 AM" within a week, else "Oct 20, 9:00 AM". */
export function when(ms: number, now: number): string {
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / 86_400_000);
  if (days === 0) return clock(ms);
  if (days === 1) return `Tomorrow ${clock(ms)}`;
  if (days === -1) return `Yesterday ${clock(ms)}`;
  if (Math.abs(days) < 7) return `${new Date(ms).toLocaleDateString([], { weekday: "short" })} ${clock(ms)}`;
  return `${new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" })}, ${clock(ms)}`;
}

/** The words for a run's outcome in the history. */
export function outcomeText(run: Run, now: number): string {
  switch (run.outcome) {
    case "running":
      return "Working";
    case "waiting":
      return "Waiting for you";
    case "done":
      return "Finished";
    case "failed":
      return run.note ? `Failed: ${run.note}` : "Failed";
    case "stopped":
      return run.note ?? "Stopped";
    case "skipped":
      return run.note ? `Skipped: ${run.note}` : "Skipped";
    case "missed":
      return `Missed ${when(run.at, now)}`;
  }
}

export const inProgress = (r: Run): boolean => r.outcome === "running" || r.outcome === "waiting";

/** What the scheduler knows when it decides. */
export interface Context {
  now: number;
  /** The plan's five-hour window, 0 to 1 (null: not said yet). */
  planUsed: number | null;
  /** claude was found, so a chat can start. */
  ready: boolean;
}

/** Routine chats at work now, over all routines. */
export const workingNow = (routines: Routine[]): number => routines.reduce((n, r) => n + r.runs.filter(inProgress).length, 0);

/**
 * Why a run can't start now, in plain words, or null. Used by the scheduler (the run is skipped and the history says why)
 * and by Run now (which just says no). `atOnce`: routine chats already at work, including ones this tick has started.
 */
export function skipReason(r: Routine, ctx: Pick<Context, "planUsed">, atOnce: number): string | null {
  if (r.runs.some(inProgress)) return "the last run is still going";
  if (ctx.planUsed !== null && ctx.planUsed >= PLAN_STOP) return `the plan is at ${Math.round(ctx.planUsed * 100)}%`;
  if (atOnce >= MAX_AT_ONCE) return `${MAX_AT_ONCE} routines were already running`;
  return null;
}

/** How full the plan is now, or null when it hasn't been said or its window is over (a new one starts empty). */
export function planUsedNow(p: PlanUsage | null, now: number): number | null {
  if (!p || (p.resetsAt !== null && p.resetsAt * 1000 <= now)) return null;
  return p.used;
}

/** The run at the top of the history, which keeps the latest MAX_RUNS, and any run still going however old: dropping it would let a second one start. */
const withRun = (r: Routine, run: Run): Routine => ({ ...r, runs: [run, ...r.runs].filter((x, i) => i < MAX_RUNS || inProgress(x)) });

/**
 * One look of the scheduler. Each enabled routine that is due: starts (a new run, "working", is put at the top of its
 * history and `start` names it), or is skipped for a reason, or, when it was due too long ago to be on time (the app
 * was closed or the Mac asleep), is recorded as missed once. Either way its next time is worked out from now, so a
 * stale run is never replayed. A paused routine just moves on without a word.
 */
export function tick(routines: Routine[], ctx: Context): { routines: Routine[]; start: string[] } {
  const start: string[] = [];
  let atOnce = workingNow(routines);
  const next = routines.map((r) => {
    if (!r.enabled) return r;
    // Switched on with no time saved (storage was edited): it waits for its next one.
    if (r.nextAt === null) return { ...r, nextAt: nextRun(r.schedule, ctx.now) };
    if (ctx.now < r.nextAt) return r;
    const later = nextRun(r.schedule, ctx.now);
    if (r.pausedUntil !== null && r.pausedUntil > ctx.now) return { ...r, nextAt: later };
    if (ctx.now - r.nextAt > MISSED_AFTER_MS) return withRun({ ...r, nextAt: later }, { at: r.nextAt, outcome: "missed" });
    // Nothing can start before claude is found: it stays due, and is missed if that takes too long.
    if (!ctx.ready) return r;
    const reason = skipReason(r, ctx, atOnce);
    if (reason) return withRun({ ...r, nextAt: later }, { at: ctx.now, outcome: "skipped", note: reason });
    atOnce++;
    start.push(r.id);
    return withRun({ ...r, nextAt: later }, { at: ctx.now, outcome: "running" });
  });
  return { routines: next, start };
}

/** Run now: the routine with a new run at the top, or why it can't (the history isn't touched then). Its schedule is unchanged. */
export function runNow(routines: Routine[], id: string, ctx: Context): { routines: Routine[]; error: string | null } {
  const r = routines.find((x) => x.id === id);
  if (!r) return { routines, error: "That routine is gone." };
  if (!ctx.ready) return { routines, error: "Claude isn't ready yet." };
  const reason = skipReason(r, ctx, workingNow(routines));
  if (reason) return { routines, error: `Not started: ${reason}.` };
  return { routines: routines.map((x) => (x.id === id ? withRun(x, { at: ctx.now, outcome: "running", manual: true }) : x)), error: null };
}

/** After Lantern was closed, a run that was working isn't any more: nothing is left to follow. */
export function settleStale(routines: Routine[]): Routine[] {
  return routines.map((r) => (r.runs.some(inProgress) ? { ...r, runs: r.runs.map((run) => (inProgress(run) ? { ...run, outcome: "stopped" as const, note: "Lantern was closed" } : run)) } : r));
}

/** A routine's `runs` with the one that started at `at` changed (when it is still there). */
export function updateRun(r: Routine, at: number, change: Partial<Run>): Routine {
  return { ...r, runs: r.runs.map((run) => (run.at === at && inProgress(run) ? { ...run, ...change } : run)) };
}

/** A routine made from what the form holds: switched on, due at its next time. */
export function newRoutine(draft: Pick<Routine, "name" | "folder" | "prompt" | "schedule" | "permissions" | "model">, id: string, now: number): Routine {
  return { ...draft, id, enabled: true, nextAt: nextRun(draft.schedule, now), pausedUntil: null, runs: [] };
}

/** Why a draft can't be saved, or null. */
export function draftProblem(d: Pick<Routine, "name" | "folder" | "prompt" | "schedule">): string | null {
  if (!d.name.trim()) return "Give the routine a name.";
  if (!absolute(d.folder)) return "Pick the project it runs in.";
  if (!d.prompt.trim()) return "Write what Claude should do.";
  if (d.prompt.length > MAX_PROMPT) return `The prompt is too long (the most is ${MAX_PROMPT.toLocaleString()} characters).`;
  if (!validSchedule(d.schedule)) {
    if (d.schedule.kind !== "every") return "Pick a time.";
    if (!Number.isInteger(d.schedule.every)) return "Pick a gap that is a whole number.";
    return everyMinutes(d.schedule) > MAX_EVERY_MINUTES ? "Pick a gap of at most 7 days." : `Pick a gap of at least ${MIN_EVERY_MINUTES} minutes.`;
  }
  return null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const OUTCOMES: RunOutcome[] = ["running", "waiting", "done", "failed", "stopped", "skipped", "missed"];
const MODELS = MODEL_CHOICES.map((m) => m.value);

function readSchedule(v: unknown): Schedule | null {
  if (!isRecord(v)) return null;
  const s = v as Record<string, unknown>;
  const candidate: Schedule | null =
    s.kind === "every" ? { kind: "every", every: s.every as number, unit: s.unit as "minutes" | "hours" } : s.kind === "daily" || s.kind === "weekdays" ? { kind: s.kind, at: s.at as string } : s.kind === "weekly" ? { kind: "weekly", day: s.day as number, at: s.at as string } : null;
  return candidate && validSchedule(candidate) ? candidate : null;
}

function readRun(v: unknown): Run | null {
  if (!isRecord(v)) return null;
  const at = num(v.at);
  if (at === null || !OUTCOMES.includes(v.outcome as RunOutcome)) return null;
  return {
    at,
    outcome: v.outcome as RunOutcome,
    ...(typeof v.note === "string" ? { note: v.note.slice(0, 300) } : {}),
    ...(typeof v.sessionId === "string" ? { sessionId: v.sessionId } : {}),
    ...(v.manual === true ? { manual: true } : {}),
  };
}

/**
 * The routines as saved. What was saved may be anything (storage is editable): a routine that doesn't read is dropped,
 * a value that isn't allowed is replaced by the safe one (Permissions Ask, a model from the list), and the list is
 * cut to the most there can be.
 */
export function readRoutines(saved: unknown): Routine[] {
  if (!Array.isArray(saved)) return [];
  const seen = new Set<string>();
  const out: Routine[] = [];
  for (const v of saved) {
    if (!isRecord(v) || out.length >= MAX_ROUTINES) continue;
    const schedule = readSchedule(v.schedule);
    if (typeof v.id !== "string" || !v.id || seen.has(v.id) || typeof v.name !== "string" || !absolute(v.folder) || typeof v.prompt !== "string" || !schedule) continue;
    seen.add(v.id);
    out.push({
      id: v.id,
      name: v.name.slice(0, MAX_NAME),
      folder: v.folder,
      prompt: v.prompt.slice(0, MAX_PROMPT),
      schedule,
      permissions: v.permissions === "auto" ? "auto" : "ask",
      model: v.model === null ? null : typeof v.model === "string" && MODELS.includes(v.model) ? v.model : DEFAULT_MODEL,
      enabled: v.enabled === true,
      nextAt: num(v.nextAt),
      pausedUntil: num(v.pausedUntil),
      runs: (Array.isArray(v.runs) ? v.runs : []).flatMap((run) => readRun(run) ?? []).slice(0, MAX_RUNS),
    });
  }
  return out;
}

/** The title of a routine's chats ("Routine: Morning TODOs"). */
export const routineTitle = (name: string): string => `Routine: ${name}`;

/** Each chat a routine started, by session id: for the titles of chats that come back after a restart. */
export function routineTitles(routines: Routine[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of routines) for (const run of r.runs) if (run.sessionId) out[run.sessionId] = routineTitle(r.name);
  return out;
}

/** On or off. Switched on, it is next due at its next time (not at once, and not for what it missed while it was off). */
export const withEnabled = (r: Routine, on: boolean, now: number): Routine => ({ ...r, enabled: on, nextAt: on ? nextRun(r.schedule, now) : null, pausedUntil: on ? r.pausedUntil : null });

/** Paused for an hour from `now`, or (`pause` false) taken off pause. */
export const withPause = (r: Routine, pause: boolean, now: number): Routine => ({ ...r, pausedUntil: pause ? now + ROUTINE_PAUSE_MS : null });
