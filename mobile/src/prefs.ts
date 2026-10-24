/** What the phone remembers about how Home looks, on this phone only (the Keychain or Keystore, like everything else it keeps). */
import * as SecureStore from "expo-secure-store";
import type { Grouping } from "./view/home";

const KEY = "lantern.home-grouping";
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

/** How Home lists the chats; the recent-first list when nothing was chosen or it can't be read. */
export async function loadGrouping(): Promise<Grouping> {
  try {
    return (await SecureStore.getItemAsync(KEY, OPTIONS)) === "project" ? "project" : "recent";
  } catch {
    return "recent";
  }
}

const SUGGESTIONS_KEY = "lantern.suggestions";
/** How many dismissed suggestions are remembered (the newest). */
export const DISMISSED_KEPT = 40;

export interface SuggestionPrefs {
  /** Folded away: not even asked for (each ask costs usage). */
  collapsed: boolean;
  /** The suggestions dismissed, by what they say (`suggestionKey`), newest last. */
  dismissed: string[];
}

export async function loadSuggestionPrefs(): Promise<SuggestionPrefs> {
  try {
    const raw: unknown = JSON.parse((await SecureStore.getItemAsync(SUGGESTIONS_KEY, OPTIONS)) ?? "{}");
    const o = raw as Partial<SuggestionPrefs>;
    return { collapsed: o.collapsed === true, dismissed: Array.isArray(o.dismissed) ? o.dismissed.filter((k): k is string => typeof k === "string").slice(-DISMISSED_KEPT) : [] };
  } catch {
    return { collapsed: false, dismissed: [] };
  }
}

export async function saveSuggestionPrefs(p: SuggestionPrefs): Promise<void> {
  try {
    await SecureStore.setItemAsync(SUGGESTIONS_KEY, JSON.stringify({ collapsed: p.collapsed, dismissed: p.dismissed.slice(-DISMISSED_KEPT) }), OPTIONS);
  } catch {
    // Not remembered: it holds until the app closes.
  }
}

export async function saveGrouping(g: Grouping): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, g, OPTIONS);
  } catch {
    // Not remembered: Home is as it was chosen until the app closes.
  }
}

const FOLDED_KEY = "lantern.home-folded";
/** How many folded projects are remembered (the newest folded): the stored value stays small. */
export const FOLDED_KEPT = 40;

/** The projects folded away in Home's project cards, by name; none when nothing was folded or it can't be read. */
export async function loadFolded(): Promise<string[]> {
  try {
    const raw: unknown = JSON.parse((await SecureStore.getItemAsync(FOLDED_KEY, OPTIONS)) ?? "[]");
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string").slice(-FOLDED_KEPT) : [];
  } catch {
    return [];
  }
}

export async function saveFolded(projects: string[]): Promise<void> {
  try {
    await SecureStore.setItemAsync(FOLDED_KEY, JSON.stringify(projects.slice(-FOLDED_KEPT)), OPTIONS);
  } catch {
    // Not remembered: the cards are as they were left until the app closes.
  }
}

const NOTES_KEY = "lantern.notes-seen";

/**
 * The newest build whose "What's new" was shown on this phone; null when none was (nothing kept yet). A value that can't be
 * read counts as already shown, so a broken store never makes the notes come back at every launch.
 */
export async function loadNotesSeen(): Promise<number | null> {
  try {
    const raw = await SecureStore.getItemAsync(NOTES_KEY, OPTIONS);
    if (raw === null) return null;
    const build = Number(raw);
    return Number.isInteger(build) && build >= 0 ? build : Number.MAX_SAFE_INTEGER;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export async function saveNotesSeen(build: number): Promise<void> {
  try {
    await SecureStore.setItemAsync(NOTES_KEY, String(build), OPTIONS);
  } catch {
    // Not remembered: they may show once more at the next launch.
  }
}

const SEEN_KEY = "lantern.chats-seen";
/** How many chats' last-seen marks are kept: the stored value stays small (a chat that is closed has its mark dropped too). */
export const SEEN_KEPT = 60;

/** Where each chat stood (the Mac's `active_at`) when this phone last showed it; null when nothing was kept yet (the first launch). */
export async function loadSeen(): Promise<Record<string, number> | null> {
  try {
    const raw = await SecureStore.getItemAsync(SEEN_KEY, OPTIONS);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, number] => typeof e[1] === "number"));
  } catch {
    return null;
  }
}

export async function saveSeen(seen: Record<string, number>): Promise<void> {
  try {
    const newest = Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, SEEN_KEPT);
    await SecureStore.setItemAsync(SEEN_KEY, JSON.stringify(Object.fromEntries(newest)), OPTIONS);
  } catch {
    // Not remembered: they hold until the app closes.
  }
}
