/** How Insights' figures are said (pure, so they are tested without a screen), and the last ones shown. */
import type { Insights } from "../protocol/generated/Insights";
import type { InsightsCompare } from "../protocol/generated/InsightsCompare";
import type { InsightsRange } from "../protocol/generated/InsightsRange";

/** What was shown last, per stretch: the tab opens on it while the Mac works out a fresh one. */
export const kept = new Map<InsightsRange, Insights>();

/** The phone was unpaired: another Mac's figures mustn't show first. */
export function forgetInsights() {
  kept.clear();
}

/** A count of tokens, short: "820", "54k", "9.1M", "1.1B". */
export function tokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${Math.round(n)}`;
}

/** A share, 0 to 1, as a whole percent. */
export const percent = (share: number) => `${Math.round(share * 100)}%`;

/** How a figure moved since the stretch before, and whether that is good (less sent, more from the cache): null when there is nothing to compare with, or it barely moved. */
export function change(c: InsightsCompare, lowerIsBetter: boolean, asPoints = false): { text: string; good: boolean } | null {
  if (c.before === null || c.before === 0 || c.now === 0) return null;
  const diff = asPoints ? Math.round((c.now - c.before) * 100) : Math.round(((c.now - c.before) / c.before) * 100);
  if (Math.abs(diff) < (asPoints ? 1 : 3)) return { text: "same", good: true };
  const up = diff > 0;
  return { text: `${up ? "▲" : "▼"} ${Math.abs(diff)}${asPoints ? (Math.abs(diff) === 1 ? " pt" : " pts") : "%"}`, good: up !== lowerIsBetter };
}

/** A wait, in its largest unit: "40 s", "6 min", "2 h". */
export function wait(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}
