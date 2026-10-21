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

export async function saveGrouping(g: Grouping): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, g, OPTIONS);
  } catch {
    // Not remembered: Home is as it was chosen until the app closes.
  }
}
