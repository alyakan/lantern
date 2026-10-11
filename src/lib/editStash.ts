/**
 * Unsaved edits kept in memory when the editor goes away without a decision (switching chats): reopen the file in that
 * chat and they're back. Deciding to discard them clears them. Not kept across quitting Lantern.
 */
interface Kept {
  /** The file as it was on disk when the edits began. */
  saved: string;
  draft: string;
}

const kept = new Map<string, Kept>();
const discarded = new Set<string>();

export const stashKey = (slot: string, path: string) => `${slot}:${path}`;

/** The editor is closing: keep its edits unless the user discarded them. */
export function stash(key: string, saved: string, draft: string) {
  if (discarded.delete(key)) return kept.delete(key);
  if (saved === draft) kept.delete(key);
  else kept.set(key, { saved, draft });
}

/** The editor opened: the edits kept for this file, once. */
export function unstash(key: string): Kept | undefined {
  const k = kept.get(key);
  kept.delete(key);
  return k;
}

/** The user chose to throw the edits away: the editor closing next must not keep them. */
export function discard(key: string) {
  kept.delete(key);
  discarded.add(key);
}

/** Forget everything (tests). */
export function clearStash() {
  kept.clear();
  discarded.clear();
}

