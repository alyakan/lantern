/**
 * Which chats finished with nothing looked at since, kept across launches. Slot ids are a counter that a later launch hands out
 * again, so what is kept is keyed by the chat's session; a chat with no session yet is kept for this launch only.
 */
import type { State } from "../store";

/** Unread chats by key (the session, or `slot:<slot>` before there is one), with when each went unread. */
export type Unread = Record<string, number>;

export const UNREAD_KEY = "chat.unreadBySession";
/** The most kept, newest first: a chat closed while unread is dropped once this many newer ones went unread. */
const KEPT_MAX = 200;

export function unreadKey(slot: string, s: State | undefined): string {
  return s?.sessionId ?? `slot:${slot}`;
}

/** The unread chats among those open, by slot. */
export function unreadBySlot(unread: Unread, slots: Record<string, State>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [slot, s] of Object.entries(slots)) {
    const at = unread[unreadKey(slot, s)];
    if (at !== undefined) out[slot] = at;
  }
  return out;
}

export function markUnread(unread: Unread, slot: string, s: State | undefined, at: number): Unread {
  return { ...unread, [unreadKey(slot, s)]: at };
}

export function markRead(unread: Unread, slot: string, s: State | undefined): Unread {
  const key = unreadKey(slot, s);
  if (!(key in unread)) return unread;
  const { [key]: _read, ...rest } = unread;
  return rest;
}

/** What is written down: sessions only (a slot means nothing to the next launch), the newest KEPT_MAX. */
export function toKeep(unread: Unread): Unread {
  const kept = Object.entries(unread).filter(([key]) => !key.startsWith("slot:"));
  kept.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(kept.slice(0, KEPT_MAX));
}

/** What was written down, read back: anything that isn't a session's time is dropped. */
export function fromKept(raw: unknown): Unread {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Unread = {};
  for (const [key, at] of Object.entries(raw)) if (!key.startsWith("slot:") && typeof at === "number" && Number.isFinite(at)) out[key] = at;
  return out;
}
