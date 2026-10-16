import { useEffect, useState } from "react";

/** How many minutes an agent at work may go without a word before it counts as quiet (Settings > General). App-wide, like the agent limit. */
const KEY = "lantern.quietMinutes";
const CHANGED = "lantern-quiet-minutes";
export const QUIET_MINUTES_DEFAULT = 3;
export const QUIET_MINUTES = [1, 2, 3, 5, 10, 15, 30] as const;

export function quietMinutes(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return (QUIET_MINUTES as readonly number[]).includes(n) ? n : QUIET_MINUTES_DEFAULT;
  } catch {
    return QUIET_MINUTES_DEFAULT;
  }
}

export function setQuietMinutes(n: number): void {
  if (!(QUIET_MINUTES as readonly number[]).includes(n)) return;
  try {
    localStorage.setItem(KEY, String(n));
  } catch {
    // storage unavailable: it lasts until Lantern quits
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** The setting in minutes, kept in step with every place that changes it. */
export function useQuietMinutes(): number {
  const [n, setN] = useState(quietMinutes);
  useEffect(() => {
    const sync = () => setN(quietMinutes());
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, []);
  return n;
}

/** The setting in milliseconds: how long without a word before an agent at work counts as quiet. */
export function useQuietAfter(): number {
  return useQuietMinutes() * 60_000;
}
