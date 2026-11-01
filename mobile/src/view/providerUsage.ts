import type { ProviderUsage } from "../protocol/generated/ProviderUsage";
import type { PlanUsage } from "../sync/reducer";

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
