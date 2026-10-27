/**
 * Which chats have something new in them: where each chat stood (the Mac's `active_at`) when this phone last showed it. A chat
 * that has moved on since, and is waiting for you, is unread. Kept on this phone only (prefs.ts), outside React so the home
 * screen and an open chat share it; the screens read it with `useSeen`.
 */
import { useSyncExternalStore } from "react";
import { loadSeen, saveSeen } from "./prefs";

type Marks = Record<string, number>;

/** How long a burst of marks (a chat streaming while it is open) waits before it is written down once. */
const SAVE_AFTER_MS = 1000;

let marks: Marks = {};
/** Whether what was kept has been read. */
let loaded = false;
/** The first launch (nothing kept yet): what is there now counts as seen, so the whole list doesn't start out unread. */
let first = false;
let loading: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let snapshot: Marks | null = null;
const listeners = new Set<() => void>();

function emit() {
  snapshot = loaded && !first ? { ...marks } : null;
  listeners.forEach((l) => l());
}

function ensureLoaded(): Promise<void> {
  loading ??= loadSeen().then((kept) => {
    // A mark made while this was reading (the chat was opened first) stays.
    marks = { ...(kept ?? {}), ...marks };
    first = kept === null && Object.keys(marks).length === 0;
    loaded = true;
    emit();
  });
  return loading;
}

function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void saveSeen(marks);
  }, SAVE_AFTER_MS);
}

/** What is known of where each chat was last shown; null until it is (so nothing is called unread before that). */
export function useSeen(): Marks | null {
  void ensureLoaded();
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => snapshot,
  );
}

/** The chat is on screen, at `at` (its `active_at`): nothing in it is new any more. */
export function markSeen(slot: string, at: number) {
  void ensureLoaded().then(() => {
    if ((marks[slot] ?? -1) >= at) return;
    marks[slot] = at;
    emit();
    save();
  });
}

/** Marks a chat unread again, as a mail app does: its mark goes back to before everything in it (it shows unread while it is waiting). */
export function markUnread(slot: string) {
  void ensureLoaded().then(() => {
    marks[slot] = 0;
    emit();
    save();
  });
}

/** The chats the Mac lists now: the first time ever they count as seen, and a chat no longer listed has its mark dropped. */
export function settleSeen(chats: { slot: string; active_at: number }[]) {
  if (chats.length === 0) return;
  void ensureLoaded().then(() => {
    let changed = false;
    if (first) {
      for (const c of chats) marks[c.slot] = c.active_at;
      first = false;
      changed = true;
    }
    const listed = new Set(chats.map((c) => c.slot));
    for (const slot of Object.keys(marks)) {
      if (listed.has(slot)) continue;
      delete marks[slot];
      changed = true;
    }
    if (!changed) return;
    emit();
    save();
  });
}

/** Back to nothing known (the tests' fresh start). */
export function resetSeen() {
  marks = {};
  loaded = false;
  first = false;
  loading = null;
  snapshot = null;
  if (timer) clearTimeout(timer);
  timer = null;
}
