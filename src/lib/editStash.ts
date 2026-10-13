import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";

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
/** Open editors with edits not yet saved (FilePreview says so as they change). */
const dirty = new Set<string>();

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

/** An open editor's edits are unsaved, or no longer are. */
export function setDirty(key: string, on: boolean) {
  if (on) dirty.add(key);
  else dirty.delete(key);
}

/** How many files have unsaved edits: open editors, and edits kept from closed ones (lost when Lantern quits). */
export function unsavedCount(): number {
  return new Set([...dirty, ...kept.keys()]).size;
}

/**
 * Closing the window with unsaved edits asks first. Only the window's close (its button, ⌘W) comes here: the app menu's
 * Quit ends the app without asking the window to close.
 */
export function guardWindowClose() {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  try {
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        const n = unsavedCount();
        if (n === 0) return;
        // Not preventing the close lets it go ahead. A dialog that fails keeps the window open, not the edits lost.
        const sure = await ask(`${n === 1 ? "One file has" : `${n} files have`} unsaved changes that are lost when Lantern closes.`, {
          title: "Unsaved changes",
          kind: "warning",
          okLabel: "Close anyway",
          cancelLabel: "Keep editing",
        }).catch(() => false);
        if (!sure) event.preventDefault();
      })
      .catch(() => {});
  } catch {
    // No native window to ask (a plain browser): nothing to guard.
  }
}

/** Forget everything (tests). */
export function clearStash() {
  kept.clear();
  discarded.clear();
  dirty.clear();
}
