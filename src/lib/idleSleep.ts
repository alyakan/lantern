import { useEffect, useState } from "react";
import { hasPendingPrompt, type State } from "../store";

/**
 * How many minutes a chat you aren't looking at may sit idle before it goes to sleep (Settings > General): its claude
 * process is stopped and its messages are dropped from memory, and it wakes, resumed, when you open it. 0 is never.
 * App-wide, like the agent limit.
 */
const KEY = "lantern.sleepMinutes";
const CHANGED = "lantern-sleep-minutes";
export const SLEEP_MINUTES_DEFAULT = 10;
export const SLEEP_MINUTES = [0, 5, 10, 20, 30, 60] as const;

export function sleepMinutes(): number {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === null) return SLEEP_MINUTES_DEFAULT;
    const n = Number(stored);
    return (SLEEP_MINUTES as readonly number[]).includes(n) ? n : SLEEP_MINUTES_DEFAULT;
  } catch {
    return SLEEP_MINUTES_DEFAULT;
  }
}

export function setSleepMinutes(n: number): void {
  if (!(SLEEP_MINUTES as readonly number[]).includes(n)) return;
  try {
    localStorage.setItem(KEY, String(n));
  } catch {
    // storage unavailable: it lasts until Lantern quits
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** The setting in minutes, kept in step with every place that changes it. */
export function useSleepMinutes(): number {
  const [n, setN] = useState(sleepMinutes);
  useEffect(() => {
    const sync = () => setN(sleepMinutes());
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, []);
  return n;
}

/**
 * Whether a chat may go to sleep now: it is resting (nothing running, queued, waiting on the user or running in the
 * background), has a conversation to come back to, and isn't one of the chats that stay awake: the one on screen, a team's
 * Lead or agent, a routine's.
 */
export function canSleep(s: State, own: { active: boolean; agent: boolean; routine: boolean }): boolean {
  if (own.active || own.agent || own.routine || s.orchestrator) return false;
  if (s.status !== "idle" || s.thinking || !s.folder || !s.sessionId || s.items.length === 0) return false;
  if (s.queued.length > 0 || s.wakes.length > 0 || s.backgroundTasks.length > 0 || s.setup || hasPendingPrompt(s.items)) return false;
  // A command the user started from the box, or the project's Run command: asleep, its process would be stopped.
  if (s.run?.status === "running" || s.items.some((it) => it.type === "shell" && it.status === "running")) return false;
  // What waits to go with the next message (output of commands, files put back, a flavour picked), or to be undone: sleeping loses it.
  if (s.revertNotes.length > 0 || s.revertUndo || s.restoreUndo || s.flavourPick || s.items.some((it) => it.type === "shell" && !it.shared)) return false;
  return true;
}

/**
 * Starts the idle clock of the chats that may sleep now, forgets the clock of those that may not, and says which chats
 * have been idle for `afterMs`. `clock` is when each chat started to be idle (ms since the epoch); the new one is returned.
 */
export function sweep(clock: Record<string, number>, eligible: ReadonlySet<string>, now: number, afterMs: number): { clock: Record<string, number>; due: string[] } {
  const next: Record<string, number> = {};
  for (const slot of eligible) next[slot] = clock[slot] ?? now;
  return { clock: next, due: afterMs > 0 ? Object.keys(next).filter((slot) => now - next[slot] >= afterMs) : [] };
}
