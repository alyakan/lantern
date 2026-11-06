/**
 * The Work tab's badge, on this phone only (the Keychain). It counts the next steps waiting: always, only those new since Work
 * was last opened (the default: a count that never went down was a badge always on), or never. Like the pins (pins.ts) it is
 * kept outside React and read with a hook.
 */
import { useSyncExternalStore } from "react";
import * as SecureStore from "expo-secure-store";

export type WorkBadge = "always" | "opened" | "never";

const MODE_KEY = "lantern.work-badge";
const SEEN_KEY = "lantern.work-seen";
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
/** How many seen steps are kept: more than are ever waiting at once. */
const SEEN_KEPT = 200;

let mode: WorkBadge = "opened";
let seen = new Set<string>();
let loaded = false;
let loading: Promise<void> | null = null;
let snapshot: { mode: WorkBadge; seen: Set<string>; loaded: boolean } = { mode, seen, loaded };
const listeners = new Set<() => void>();

function emit() {
  snapshot = { mode, seen, loaded };
  listeners.forEach((l) => l());
}

function ensureLoaded(): Promise<void> {
  loading ??= (async () => {
    try {
      const m = await SecureStore.getItemAsync(MODE_KEY, OPTIONS);
      if (m === "always" || m === "never" || m === "opened") mode = m;
      const raw: unknown = JSON.parse((await SecureStore.getItemAsync(SEEN_KEY, OPTIONS)) ?? "[]");
      if (Array.isArray(raw)) seen = new Set([...raw.filter((s): s is string => typeof s === "string"), ...seen]);
    } catch {
      // Unreadable: the default, with nothing seen.
    }
    loaded = true;
    emit();
  })();
  return loading;
}

/** A step as the badge knows it: the item, and the step it is at (an item that moves on to another step is new again). */
export const stepId = (item: { key: string; next: { what: string } | null }) => `${item.key}:${item.next?.what ?? ""}`;

/** The badge setting, what has been seen, and whether they have been read. */
export function useWorkBadge() {
  void ensureLoaded();
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => snapshot,
  );
}

/** The number the tab shows for the steps waiting now (none until what was seen is read, so it doesn't show a count and drop it). */
export function badgeCount(state: { mode: WorkBadge; seen: Set<string>; loaded: boolean }, steps: string[]): number {
  if (state.mode === "never") return 0;
  if (state.mode === "always") return steps.length;
  return state.loaded ? steps.filter((s) => !state.seen.has(s)).length : 0;
}

export function setWorkBadge(next: WorkBadge) {
  mode = next;
  emit();
  void SecureStore.setItemAsync(MODE_KEY, next, OPTIONS).catch(() => {});
}

/** Work was looked at with these steps waiting: they are not new any more (what is no longer waiting is let go). */
export function markWorkSeen(steps: string[]) {
  void ensureLoaded().then(() => {
    if (steps.length === seen.size && steps.every((s) => seen.has(s))) return;
    seen = new Set(steps.slice(0, SEEN_KEPT));
    emit();
    void SecureStore.setItemAsync(SEEN_KEY, JSON.stringify([...seen]), OPTIONS).catch(() => {});
  });
}

/** Back to nothing known (the tests' fresh start, and an unpaired phone). */
export function resetWorkBadge() {
  mode = "opened";
  seen = new Set();
  loaded = false;
  loading = null;
  snapshot = { mode, seen, loaded };
}
