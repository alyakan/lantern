/**
 * What the Mac last listed, kept on this phone only (the Keychain) so that when the Mac can't be reached, the phone can show
 * what was there and when, greyed, instead of a bare "can't reach". Titles and project names only: no slot, no status (it would be
 * stale and misleading), no message text.
 */
import * as SecureStore from "expo-secure-store";
import type { RemoteChat } from "./protocol/generated/RemoteChat";

const KEY = "lantern.last-known";
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

/** How many chats are kept, and how long a title is. */
export const KNOWN_KEPT = 12;
export const TITLE_MAX = 60;

export interface KnownChat {
  title: string;
  project: string | null;
}

export interface LastKnown {
  /** When it was saved (the phone's clock: it is only for "5 min ago"). */
  at: number;
  mac: string | null;
  chats: KnownChat[];
}

/** The chats with a real title (never the stand-in made from a first message), newest first as listed, as they are kept. */
export function snapshotOf(chats: RemoteChat[], mac: string | null, now: number): LastKnown | null {
  const known = [...chats]
    .sort((a, b) => b.active_at - a.active_at)
    .flatMap((c): KnownChat[] => {
      const title = c.title?.trim();
      return title ? [{ title: title.slice(0, TITLE_MAX), project: c.project?.trim() || null }] : [];
    })
    .slice(0, KNOWN_KEPT);
  return known.length > 0 ? { at: now, mac, chats: known } : null;
}

/** "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago". */
export function ageText(at: number, now: number): string {
  const min = Math.floor(Math.max(0, now - at) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export async function loadLastKnown(): Promise<LastKnown | null> {
  try {
    const raw: unknown = JSON.parse((await SecureStore.getItemAsync(KEY, OPTIONS)) ?? "null");
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Partial<LastKnown>;
    if (typeof o.at !== "number" || !Array.isArray(o.chats)) return null;
    const chats = o.chats.flatMap((c): KnownChat[] => (c && typeof c.title === "string" && c.title ? [{ title: c.title.slice(0, TITLE_MAX), project: typeof c.project === "string" ? c.project : null }] : [])).slice(0, KNOWN_KEPT);
    return chats.length > 0 ? { at: o.at, mac: typeof o.mac === "string" ? o.mac : null, chats } : null;
  } catch {
    return null;
  }
}

export async function saveLastKnown(k: LastKnown): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(k), OPTIONS);
  } catch {
    // Not kept: the offline screen has nothing to show of the last time.
  }
}

/** Forgets it (this phone was unpaired from the Mac). */
export async function forgetLastKnown(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY, OPTIONS);
  } catch {
    // Nothing to do.
  }
}
