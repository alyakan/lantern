/** What the phone remembers about how Home looks, on this phone only (the Keychain or Keystore, like everything else it keeps). */
import * as SecureStore from "expo-secure-store";
import type { RemotePermissions } from "./protocol/generated/RemotePermissions";
import type { Grouping } from "./view/home";
import { NOTES_UNREADABLE } from "./whatsNew";

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

const MODE_KEY = "lantern.home-mode";

/** Whether Home is the Desk or the list of chats; the Desk when nothing was chosen or it can't be read. */
export async function loadHomeMode(): Promise<"desk" | "chats"> {
  try {
    return (await SecureStore.getItemAsync(MODE_KEY, OPTIONS)) === "chats" ? "chats" : "desk";
  } catch {
    return "desk";
  }
}

export async function saveHomeMode(mode: "desk" | "chats"): Promise<void> {
  try {
    await SecureStore.setItemAsync(MODE_KEY, mode, OPTIONS);
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

const PINNED_KEY = "lantern.sidebar-pinned";

/** Whether a tablet keeps the chats beside the chat (pinned), or slides them in when asked and away once a chat is chosen. Not pinned until chosen. */
export async function loadSidebarPinned(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(PINNED_KEY, OPTIONS)) === "1";
  } catch {
    return false;
  }
}

export async function saveSidebarPinned(pinned: boolean): Promise<void> {
  try {
    await SecureStore.setItemAsync(PINNED_KEY, pinned ? "1" : "0", OPTIONS);
  } catch {
    // Not remembered: it holds until the app closes.
  }
}

const CHANGES_SHARE_KEY = "lantern.changes-share";

/** The share of a tablet's width the Changes pane was last dragged to beside the chat; null when it never was. */
export async function loadChangesShare(): Promise<number | null> {
  try {
    const n = Number(await SecureStore.getItemAsync(CHANGES_SHARE_KEY, OPTIONS));
    return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
  } catch {
    return null;
  }
}

export async function saveChangesShare(share: number): Promise<void> {
  try {
    await SecureStore.setItemAsync(CHANGES_SHARE_KEY, share.toFixed(3), OPTIONS);
  } catch {
    // Not remembered: it holds until the app closes.
  }
}

const NOTES_KEY = "lantern.notes-seen";

/**
 * The build whose "What's new" was shown last on this phone (its `notesId`: version and build); null when none was (nothing
 * kept yet). A store that can't be read counts as everything shown, so it never makes the notes come back at every launch.
 */
export async function loadNotesSeen(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(NOTES_KEY, OPTIONS);
  } catch {
    return NOTES_UNREADABLE;
  }
}

export async function saveNotesSeen(id: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(NOTES_KEY, id, OPTIONS);
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

const NEW_CHAT_PERMISSIONS_KEY = "lantern.new-chat-permissions";

/** Ask or Auto, as the last chat this phone started was started with (in any project); Ask when none was, or it can't be read. */
export async function loadNewChatPermissions(): Promise<RemotePermissions> {
  try {
    return (await SecureStore.getItemAsync(NEW_CHAT_PERMISSIONS_KEY, OPTIONS)) === "auto" ? "auto" : "ask";
  } catch {
    return "ask";
  }
}

export async function saveNewChatPermissions(p: RemotePermissions): Promise<void> {
  try {
    await SecureStore.setItemAsync(NEW_CHAT_PERMISSIONS_KEY, p, OPTIONS);
  } catch {
    // Not remembered: the next chat starts on Ask.
  }
}
