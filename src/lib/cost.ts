/**
 * What a turn cost and used, as the chat shows it. Each figure is shown only when it's known: a cost is null on a
 * login that isn't billed per use, and the first turn of a claude process has no share to give (see stream_parser.rs).
 */

/** "$0.04", or "<$0.01" below a cent. Null when there's nothing to show: unknown, or none spent. */
export function formatCost(usd: number | null): string | null {
  if (usd === null || usd <= 0) return null;
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

/** "950 tokens", "12k tokens", "1.4M tokens". Null when there are none (or none are known). */
export function formatTokens(n: number | null): string | null {
  if (n === null || n <= 0) return null;
  const text = n < 1_000 ? `${n}` : n < 10_000 ? `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k` : n < 1_000_000 ? `${Math.round(n / 1_000)}k` : `${(n / 1_000_000).toFixed(1)}M`;
  return `${text} tokens`;
}

/** "$0.04 · 12k tokens", with whichever is known; null if neither is. */
export function usageLine(usd: number | null, tokens: number | null): string | null {
  const parts = [formatCost(usd), formatTokens(tokens)].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}
