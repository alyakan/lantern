import { useEffect, useState } from "react";
import type { PlanUsage } from "./planUsage";
import { elapsed } from "./time";

/**
 * "Pause a team's work when my plan reaches ...": at that much of the five-hour window, every working agent of every team is
 * interrupted (not ended), and nothing starts again until the user says Resume. In percent; 0 is off. App-wide, like the
 * agent limit.
 */
const KEY = "lantern.pauseAtPercent";
const CHANGED = "lantern-pause-at";
export const PAUSE_OPTIONS = [0, 90, 95] as const;
/** How many points under the setting the user is warned, once. */
export const PAUSE_WARN_MARGIN = 5;
/** What each paused agent is told when the user presses Resume. */
export const CONTINUE_MESSAGE = "Continue where you stopped.";

export function pauseAtPercent(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return (PAUSE_OPTIONS as readonly number[]).includes(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function setPauseAtPercent(n: number): void {
  if (!(PAUSE_OPTIONS as readonly number[]).includes(n)) return;
  try {
    localStorage.setItem(KEY, String(n));
  } catch {
    // storage unavailable: it lasts until Lantern quits
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** The setting, kept in step with every place that changes it. */
export function usePauseAtPercent(): number {
  const [n, setN] = useState(pauseAtPercent);
  useEffect(() => {
    const sync = () => setN(pauseAtPercent());
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, []);
  return n;
}

const FIVE_HOURS = 5 * 3600_000;

/** A team's work that was paused: when, how full the plan was, when it resets, and the agents that were interrupted. */
export interface PlanPause {
  provider?: string;
  percent: number;
  resetsAt: number | null;
  since: number;
  slots: string[];
}

/** When a pause is over by itself: the plan's window resets (when claude didn't say, at the end of the clock's five-hour block it began in). */
export function pauseEndsAt(p: Pick<PlanPause, "resetsAt" | "since" | "provider">): number | null {
  if (p.provider && p.provider !== "claude" && p.resetsAt === null) return null;
  return p.resetsAt !== null ? p.resetsAt * 1000 : (Math.floor(p.since / FIVE_HOURS) + 1) * FIVE_HOURS;
}

/** The windows already dealt with, so each is paused and warned about once: the window's key (see windowKey). */
export interface PauseMemory {
  paused: string | null;
  warned: string | null;
}

const MEMORY = "lantern.pauseMemory";
/** Which five-hour window a reading belongs to: its reset time (when claude didn't say, the clock's five-hour block). */
export function windowKey(plan: PlanUsage, now = Date.now()): string {
  return plan.resetsAt !== null ? String(plan.resetsAt) : `block-${Math.floor(now / FIVE_HOURS)}`;
}

export function loadPauseMemory(provider = "claude"): PauseMemory {
  try {
    const raw = JSON.parse(localStorage.getItem(provider === "claude" ? MEMORY : `${MEMORY}.${provider}`) ?? "null") as Partial<PauseMemory> | null;
    return { paused: typeof raw?.paused === "string" ? raw.paused : null, warned: typeof raw?.warned === "string" ? raw.warned : null };
  } catch {
    return { paused: null, warned: null };
  }
}

export function savePauseMemory(m: PauseMemory, provider = "claude"): void {
  try {
    localStorage.setItem(provider === "claude" ? MEMORY : `${MEMORY}.${provider}`, JSON.stringify(m));
  } catch {
    // storage unavailable: it lasts until Lantern quits
  }
}

export type PauseStep = "pause" | "warn" | null;

/**
 * What to do about a reading of the plan: "pause" the teams the first time it reaches `atPercent` in a window while
 * something works, "warn" the first time it gets within PAUSE_WARN_MARGIN points of it, else nothing. The percent is the
 * rounded one the meter shows.
 */
export function pauseStep(plan: PlanUsage, atPercent: number, working: boolean, done: PauseMemory, now = Date.now()): PauseStep {
  if (atPercent <= 0 || !working) return null;
  const percent = Math.round(plan.used * 100);
  const key = windowKey(plan, now);
  if (percent >= atPercent) return done.paused === key ? null : "pause";
  if (percent >= atPercent - PAUSE_WARN_MARGIN) return done.warned === key ? null : "warn";
  return null;
}

/** "Paused: your plan is 95% used, it resets in 1h 12m". */
export function pausedLine(p: Pick<PlanPause, "percent" | "resetsAt" | "provider">, now = Date.now()): string {
  const used = `Paused: ${p.provider ? `${p.provider === "claude" ? "Claude" : "Codex"} is` : "your plan is"} ${p.percent}% used`;
  if (p.resetsAt === null) return used;
  const left = p.resetsAt * 1000 - now;
  return left > 0 ? `${used}, it resets in ${elapsed(left)}` : `${used}, it is resetting now`;
}

/** What the heads-up says, a few points before the pause. */
export function pauseWarning(percent: number, atPercent: number): string {
  return `Your plan is ${percent}% used. Lantern will pause the teams' work at ${atPercent}%.`;
}
