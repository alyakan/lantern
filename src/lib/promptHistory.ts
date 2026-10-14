/** How many prompts a folder keeps for ↑ in the box. */
export const RECALL_LIMIT = 50;

/**
 * `entries` (encoded drafts, oldest first) with `entry` added as the newest. A copy of it already there moves to the
 * end instead, so a prompt sent again is one entry, not two.
 */
export function withPrompt(entries: string[], entry: string): string[] {
  return [...entries.filter((e) => e !== entry), entry].slice(-RECALL_LIMIT);
}
