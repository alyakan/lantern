import { useEffect, useState } from "react";

/** How long an agent at work can go without a word before its card says how long it has been. */
export const QUIET_AFTER_MS = 15_000;

/** "45s", "3m", "2h": how long, short. */
export function shortSpan(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/**
 * While `working`, how long since its last event (`since`), once that's at least QUIET_AFTER_MS: a card's "45s ago",
 * so one that's thinking for a long time can be told from one that's stuck. Null otherwise. Ticks every 5 seconds, only
 * while working.
 */
export function useQuiet(since: number | null, working: boolean): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!working) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [working]);
  if (!working || since === null) return null;
  const quiet = now - since;
  return quiet >= QUIET_AFTER_MS ? shortSpan(quiet) : null;
}
