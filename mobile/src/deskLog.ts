/**
 * What was typed on the phone's Desk and where it went, kept on this phone only (the Keychain, like everything else it keeps): the
 * newest few, small enough for one item. Forgotten with the Mac when the phone is unpaired.
 */
import * as SecureStore from "expo-secure-store";
import { LOG_MAX, readEntries, toKeep, type DeskEntry } from "./view/desk";

const KEY = "lantern.desk-log";
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
/** The most the kept log may take, in characters: the oldest go first. */
const KEPT_CHARS = 24_000;

export async function loadDeskLog(): Promise<DeskEntry[]> {
  try {
    return readEntries(JSON.parse((await SecureStore.getItemAsync(KEY, OPTIONS)) ?? "[]"));
  } catch {
    return [];
  }
}

export async function saveDeskLog(entries: DeskEntry[]): Promise<void> {
  let kept = entries.slice(-LOG_MAX).map(toKeep);
  let json = JSON.stringify(kept);
  while (json.length > KEPT_CHARS && kept.length > 1) {
    kept = kept.slice(1);
    json = JSON.stringify(kept);
  }
  try {
    await SecureStore.setItemAsync(KEY, json, OPTIONS);
  } catch {
    // Not kept: it holds until the app closes.
  }
}

export async function forgetDeskLog(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY, OPTIONS);
  } catch {
    // Nothing more to do.
  }
}
