import { useEffect, useState } from "react";

/**
 * How full the subscription's five-hour window is, as the latest chat to hear it from claude said (`rate_limit_event`).
 * It is the account's, not a chat's, so it is kept once for the whole window.
 */
export interface PlanUsage {
  /** 0 to 1. */
  used: number;
  /** When the window resets, in unix seconds (null: not said). */
  resetsAt: number | null;
}

/** Past this the meter warns; past PLAN_STOP spawn_agent refuses new workers (orchestra.rs). */
export const PLAN_WARN = 0.8;
export const PLAN_STOP = 0.95;

const CHANGED = "lantern-plan-usage";
let latest: PlanUsage | null = null;

export function setPlanUsage(p: PlanUsage): void {
  latest = p;
  window.dispatchEvent(new Event(CHANGED));
}

export function usePlanUsage(): PlanUsage | null {
  const [p, setP] = useState(latest);
  useEffect(() => {
    const sync = () => setP(latest);
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, []);
  return p;
}

/** "Plan usage: 42% · resets 14:30". */
export function planLine(p: PlanUsage): string {
  const pct = `Plan usage: ${Math.round(p.used * 100)}%`;
  if (p.resetsAt === null) return pct;
  const at = new Date(p.resetsAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${pct} · resets ${at}`;
}

/** "warn" from PLAN_WARN, "stop" from PLAN_STOP, else "ok". */
export function planLevel(p: PlanUsage): "ok" | "warn" | "stop" {
  return p.used >= PLAN_STOP ? "stop" : p.used >= PLAN_WARN ? "warn" : "ok";
}
