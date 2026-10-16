import { useEffect, useState } from "react";
import type { State } from "../store";
import { nodeStatus } from "./orchestraView";

/** How long an agent at work can go without a word before its card says how long it has been. */
export const QUIET_AFTER_MS = 15_000;
/** How long before a quiet agent counts as possibly stuck, and its card says so in amber, until the user sets another (Settings > General). */
export const STUCK_AFTER_MS = 3 * 60_000;

/** "45s", "3m", "2h": how long, short. */
export function shortSpan(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** "45 seconds", "4 min", "1 h 5 min": how long, for a sentence. */
export function longSpan(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/**
 * How long a chat of a team has been working without a word from it, once that's at least `after`; null otherwise (not
 * working, waiting on the user, no event heard yet, or heard from recently).
 */
export function quietFor(s: State, now: number, after: number): number | null {
  if (s.activityAt === null || nodeStatus(s) !== "working") return null;
  const quiet = now - s.activityAt;
  return quiet >= after ? quiet : null;
}

export interface Quiet {
  /** How long since its last event, in ms. */
  ms: number;
  /** How long since its last event: "45s", "3m". */
  span: string;
  /** Quiet for the stuck-after time or more: worth a look. */
  stuck: boolean;
}

/**
 * While `working`, how long since its last event (`since`), once that's at least QUIET_AFTER_MS: a card's "45s ago",
 * so one that's thinking for a long time can be told from one that's stuck (`stuck`, from STUCK_AFTER_MS on). Null
 * otherwise. Ticks every 5 seconds, only while working. `stuckAfter`: the user's setting (see quietSetting).
 */
export function useQuiet(since: number | null, working: boolean, stuckAfter = STUCK_AFTER_MS): Quiet | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!working) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [working]);
  if (!working || since === null) return null;
  const quiet = now - since;
  return quiet >= QUIET_AFTER_MS ? { ms: quiet, span: shortSpan(quiet), stuck: quiet >= stuckAfter } : null;
}
