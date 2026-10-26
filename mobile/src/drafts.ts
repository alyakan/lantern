/**
 * What was typed in a chat's message box and not sent, kept on this phone only (the Keychain, like everything else it keeps) so
 * leaving the chat, or the app closing, doesn't lose it. One entry per chat, the newest few chats only, and never a terminal
 * command (it may hold a secret, and is never offered back).
 */
import * as SecureStore from "expo-secure-store";
import { isTerminal } from "./view/shell";

const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const INDEX_KEY = "lantern.drafts-index";
const PREFIX = "lantern.draft.";

/** How many chats keep a draft (the newest written), and how much of one is kept. */
export const DRAFTS_KEPT = 12;
export const DRAFT_MAX_CHARS = 4000;

// Held in memory as well, so a chat opened again is filled in at once and a store that can't be read still keeps the draft until the app closes.
const memory = new Map<string, string>();

/** A store key for a chat: the Keychain takes letters, digits, ".", "-" and "_". */
const keyOf = (slot: string) => `${PREFIX}${slot.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80)}`;

async function readIndex(): Promise<string[]> {
  try {
    const raw: unknown = JSON.parse((await SecureStore.getItemAsync(INDEX_KEY, OPTIONS)) ?? "[]");
    return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string").slice(-DRAFTS_KEPT) : [];
  } catch {
    return [];
  }
}

/** The draft kept for a chat; "" when there is none or it can't be read. */
export async function loadDraft(slot: string): Promise<string> {
  const held = memory.get(slot);
  if (held !== undefined) return held;
  try {
    const text = (await SecureStore.getItemAsync(keyOf(slot), OPTIONS)) ?? "";
    return typeof text === "string" ? text.slice(0, DRAFT_MAX_CHARS) : "";
  } catch {
    return "";
  }
}

/** Keeps `text` as a chat's draft; an empty one (a message sent, a box cleared) or a terminal command forgets it. */
export async function saveDraft(slot: string, text: string): Promise<void> {
  const keep = isTerminal(text) || text.trim() === "" ? "" : text.slice(0, DRAFT_MAX_CHARS);
  try {
    const index = (await readIndex()).filter((s) => s !== slot);
    if (keep === "") {
      memory.delete(slot);
      await SecureStore.deleteItemAsync(keyOf(slot), OPTIONS);
      await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(index), OPTIONS);
      return;
    }
    memory.set(slot, keep);
    index.push(slot);
    // The oldest drafts beyond the limit are forgotten, so the Keychain doesn't fill with chats long closed.
    for (const old of index.splice(0, Math.max(0, index.length - DRAFTS_KEPT))) {
      memory.delete(old);
      await SecureStore.deleteItemAsync(keyOf(old), OPTIONS);
    }
    await SecureStore.setItemAsync(keyOf(slot), keep, OPTIONS);
    await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(index), OPTIONS);
  } catch {
    // Not kept on the phone: it holds until the app closes.
  }
}

/** For tests: forget what is held in memory. */
export function resetDrafts() {
  memory.clear();
}
