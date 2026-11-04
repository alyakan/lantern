import type { ProviderUsage } from "../protocol/generated/ProviderUsage";
import type { UsageWindow } from "../protocol/generated/UsageWindow";
import type { PlanUsage } from "../sync/reducer";
import { windowOf, type WindowView } from "./plan";

/** Older Macs send Claude's two windows separately from provider snapshots. */
export function claudeUsage(plan: PlanUsage | null): ProviderUsage | undefined {
  return plan ? { provider: "claude", updated_at: plan.updatedAt ?? 0, windows: [
    { label: "Session", used: plan.used, resets_at: plan.resetsAt, minutes: 300 },
    ...(plan.week ? [{ label: "Week", used: plan.week.used, resets_at: plan.week.resetsAt, minutes: 10080 }] : []),
  ] } : undefined;
}

/** An expired window is unknown until the provider reports again; another window can still be current. */
export function currentUsageWindows(reading: ProviderUsage | undefined, now = Date.now()) {
  return reading?.windows.filter(w => w.resets_at === null || w.resets_at * 1000 > now) ?? [];
}

/** The providers Home speaks of, in order, by name. */
export const USAGE_PROVIDERS: { id: string; name: string }[] = [
  { id: "claude", name: "Claude" },
  { id: "codex", name: "Codex" },
];

/** One provider's reading, Claude's from the plan an older Mac sends. */
export function readingOf(id: string, plan: PlanUsage | null, providers: Record<string, ProviderUsage> | null | undefined): ProviderUsage | undefined {
  return id === "claude" ? claudeUsage(plan) : providers?.[id];
}

export interface Tightest {
  /** "Claude", "Codex". */
  provider: string;
  window: UsageWindow;
  view: WindowView;
}

const RANK = { stop: 2, warn: 1, ok: 0 } as const;

/** Which of one provider's limits is nearest its end: the worst off (at it, then running out before it resets or nearly full), then the fullest. */
export function tightestOf(windows: UsageWindow[], now = Date.now()): UsageWindow | null {
  let best: { w: UsageWindow; rank: number } | null = null;
  for (const w of windows) {
    const rank = RANK[windowOf(w, now).tone];
    if (!best || rank > best.rank || (rank === best.rank && w.used > best.w.used)) best = { w, rank };
  }
  return best?.w ?? null;
}

/**
 * The one limit Home's ring shows, across the providers: the worst off first (at the limit, then running out before it resets
 * or nearly full), then the fullest. A week at 70% that runs out on pace comes before a session at 78% that won't. Null when no
 * provider has said.
 */
export function tightest(plan: PlanUsage | null, providers: Record<string, ProviderUsage> | null | undefined, now = Date.now()): Tightest | null {
  let best: Tightest | null = null;
  for (const p of USAGE_PROVIDERS) {
    const w = tightestOf(currentUsageWindows(readingOf(p.id, plan, providers), now), now);
    if (!w) continue;
    const view = windowOf(w, now);
    if (!best || RANK[view.tone] > RANK[best.view.tone] || (RANK[view.tone] === RANK[best.view.tone] && w.used > best.window.used)) best = { provider: p.name, window: w, view };
  }
  return best;
}

/** The ring's words, for the screen reader: "Claude weekly limit 81% used, out Thu 18:20". */
export function tightestText(t: Tightest): string {
  const said = t.view.tone === "stop" ? `${t.view.title}${/limit$/i.test(t.view.title) ? "" : " limit"} reached` : `${t.view.title} ${t.view.percent}% used`;
  return `${t.provider} ${said.charAt(0).toLowerCase()}${said.slice(1)}${t.view.short ? `, ${t.view.short.charAt(0).toLowerCase()}${t.view.short.slice(1)}` : ""}`;
}
