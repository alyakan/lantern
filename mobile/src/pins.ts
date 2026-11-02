/**
 * The chats pinned to the top of Home, on this phone only (the Keychain). Like where each chat was last seen (seen.ts) it is
 * kept outside React and read with a hook; a chat the Mac no longer lists is unpinned, so the list stays as short as the chats.
 */
import { useSyncExternalStore } from "react";
import * as SecureStore from "expo-secure-store";

const KEY = "lantern.pinned-chats";
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

/** How many chats can be pinned. */
export const PINS_KEPT = 12;

let pins: string[] = [];
let loaded = false;
let loading: Promise<void> | null = null;
let snapshot: string[] = [];
const listeners = new Set<() => void>();

function emit() {
  snapshot = [...pins];
  listeners.forEach((l) => l());
}

async function readKept(): Promise<string[]> {
  try {
    const raw: unknown = JSON.parse((await SecureStore.getItemAsync(KEY, OPTIONS)) ?? "[]");
    return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string").slice(0, PINS_KEPT) : [];
  } catch {
    return [];
  }
}

function ensureLoaded(): Promise<void> {
  loading ??= readKept().then((kept) => {
    // A pin made while this was reading stays.
    pins = [...pins, ...kept.filter((s) => !pins.includes(s))].slice(0, PINS_KEPT);
    loaded = true;
    emit();
  });
  return loading;
}

async function save() {
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(pins), OPTIONS);
  } catch {
    // Not remembered: they hold until the app closes.
  }
}

/** The pinned chats' slots, newest pin first. */
export function usePins(): string[] {
  void ensureLoaded();
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => snapshot,
  );
}

/** Pins a chat at the top of the pins (the oldest pin past the limit drops off), or unpins it. */
export function setPinned(slot: string, on: boolean) {
  void ensureLoaded().then(() => {
    const has = pins.includes(slot);
    if (on === has) return;
    pins = on ? [slot, ...pins].slice(0, PINS_KEPT) : pins.filter((s) => s !== slot);
    emit();
    void save();
  });
}

/** The chats the Mac lists now: a pin on one that is gone is dropped. */
export function settlePins(listed: string[]) {
  if (listed.length === 0) return;
  void ensureLoaded().then(() => {
    const keep = pins.filter((s) => listed.includes(s));
    if (keep.length === pins.length) return;
    pins = keep;
    emit();
    void save();
  });
}

/** Forgets every pin, on the phone too (this phone was unpaired from the Mac). */
export async function forgetPins() {
  resetPins();
  emit();
  try {
    await SecureStore.deleteItemAsync(KEY, OPTIONS);
  } catch {
    // Nothing more to do.
  }
}

/** Back to nothing known (the tests' fresh start). */
export function resetPins() {
  pins = [];
  loaded = false;
  loading = null;
  snapshot = [];
}

/** Whether what was kept has been read (for tests). */
export const pinsLoaded = () => loaded;
