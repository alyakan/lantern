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
