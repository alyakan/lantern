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
/** The key Claude's usage is kept under. A Claude account added in Settings has its own limits: "claude:<account id>". */
export const CLAUDE_KEY = "claude";
export const claudeKey = (account?: string | null): string => (account ? `${CLAUDE_KEY}:${account}` : CLAUDE_KEY);
export const isClaudeKey = (key: string): boolean => key === CLAUDE_KEY || key.startsWith(`${CLAUDE_KEY}:`);

let plans: Record<string, PlanUsage> = {};

/** The five-hour reading of the Claude login `key` (see `claudeKey`): the default login's unless an account is named. */
export function setPlanUsage(p: PlanUsage, key: string = CLAUDE_KEY): void {
  plans = { ...plans, [key]: p };
  setProviderUsage({ provider: key, windows: [{ label: "Session", used: p.used, resets_at: p.resetsAt, minutes: 300 }], updated_at: Math.floor(Date.now() / 1000) });
  window.dispatchEvent(new Event(CHANGED));
}

export function usePlanUsage(key: string = CLAUDE_KEY): PlanUsage | null {
  const [p, setP] = useState(plans[key] ?? null);
  useEffect(() => {
    const sync = () => setP(plans[key] ?? null);
    window.addEventListener(CHANGED, sync);
    sync();
    return () => window.removeEventListener(CHANGED, sync);
  }, [key]);
  return p;
}

// The Claude accounts added in Settings → Accounts, by id: what the meter calls each one's usage.
let accountNames: Record<string, string> = {};

export function setAccountNames(accounts: { id: string; name: string }[]): void {
  accountNames = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
  // A new object, so the meters that read the usage draw again for the new names.
  providers = { ...providers };
  window.dispatchEvent(new Event("lantern-provider-usage"));
}

/** The usage keys of the added accounts, in the order they were added. */
export const accountKeys = (): string[] => Object.keys(accountNames).map((id) => claudeKey(id));

/** What the meter calls the Claude login `key`: null for a key that isn't one (a provider has its own name). With accounts, the default one says so. */
export function accountLabel(key: string): string | null {
  if (!isClaudeKey(key)) return null;
  if (key === CLAUDE_KEY) return Object.keys(accountNames).length > 0 ? "Claude (default)" : "Claude";
  const id = key.slice(CLAUDE_KEY.length + 1);
  return `Claude (${accountNames[id] ?? id})`;
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
/** "Gemini" of "Gemini · Week"; "" for a window that names no group. */
const groupOf = (label: string) => (label.includes(" · ") ? label.slice(0, label.indexOf(" · ")) : "");
export function setProviderUsage(usage: ProviderUsage): void {
  const previous = providers[usage.provider];
  // Claude's weekly and session events arrive independently.
  const windows = isClaudeKey(usage.provider) ? [...(previous?.windows ?? []).filter(w => !usage.windows.some(n => n.label === w.label)), ...usage.windows] : usage.windows;
  // Shortest first, within each group of models that has limits of its own ("Gemini · 5 hours", Antigravity's): a group's
  // session and week stay together, in the order the groups came.
  const groups = [...new Set(windows.map(w => groupOf(w.label)))];
  const sorted = [...windows].sort((a, b) => groups.indexOf(groupOf(a.label)) - groups.indexOf(groupOf(b.label)) || (a.minutes ?? Infinity) - (b.minutes ?? Infinity));
  providers = { ...providers, [usage.provider]: { ...usage, windows: sorted } };
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
