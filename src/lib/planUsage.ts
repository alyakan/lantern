import type { ProviderUsage } from "../../mobile/src/protocol/generated/ProviderUsage";
import { useEffect, useState } from "react";
import { elapsed } from "./time";

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
  setProviderUsage({ provider: "claude", windows: [{ label: "Session", used: p.used, resets_at: p.resetsAt, minutes: 300 }], updated_at: Math.floor(Date.now() / 1000) });
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

/** "Session 42% · resets 14:30". */
export function planLine(p: PlanUsage): string {
  const pct = `Session ${Math.round(p.used * 100)}%`;
  if (p.resetsAt === null) return pct;
  const at = new Date(p.resetsAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${pct} · resets ${at}`;
}

/** "Session: 62% of the 5-hour window, resets in 1h 40m". */
export function planSentence(p: PlanUsage, now = Date.now()): string {
  const pct = `Session: ${Math.round(p.used * 100)}% of the 5-hour window`;
  if (p.resetsAt === null) return pct;
  const left = p.resetsAt * 1000 - now;
  return left > 0 ? `${pct}, resets in ${elapsed(left)}` : `${pct}, resetting now`;
}

/** "warn" from PLAN_WARN, "stop" from PLAN_STOP, else "ok". */
export function planLevel(p: PlanUsage): "ok" | "warn" | "stop" {
  return p.used >= PLAN_STOP ? "stop" : p.used >= PLAN_WARN ? "warn" : "ok";
}

let providers: Record<string, ProviderUsage> = {};
export function setProviderUsage(usage: ProviderUsage): void {
  const previous = providers[usage.provider];
  // Claude's weekly and session events arrive independently.
  const windows = usage.provider === "claude" ? [...(previous?.windows ?? []).filter(w => !usage.windows.some(n => n.label === w.label)), ...usage.windows] : usage.windows;
  providers = { ...providers, [usage.provider]: { ...usage, windows: [...windows].sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity)) } };
  window.dispatchEvent(new Event("lantern-provider-usage"));
}
export function useProviderUsage(): Record<string, ProviderUsage> {
  const [value, setValue] = useState(providers);
  useEffect(() => {
    const sync = () => setValue(providers);
    window.addEventListener("lantern-provider-usage", sync);
    sync();
    return () => window.removeEventListener("lantern-provider-usage", sync);
  }, []);
  return value;
}
export const currentWindow = (w: { resets_at: number | null }, now = Date.now()) => w.resets_at === null || w.resets_at * 1000 > now;
