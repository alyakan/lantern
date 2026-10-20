/**
 * The Mac this phone is paired with, kept in the phone's Keychain (iOS) or Keystore (Android): this phone's own key is
 * in it, and it never leaves the device (no iCloud or backup copy).
 */
import * as SecureStore from "expo-secure-store";
import type { MacStore, PairedMac } from "./net/connection";

const KEY = "lantern.paired-mac";
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

const isPaired = (v: unknown): v is PairedMac => {
  const m = v as PairedMac;
  return !!m && typeof m.macKey === "string" && typeof m.deviceKey === "string" && Array.isArray(m.hosts) && typeof m.port === "number" && typeof m.macName === "string";
};

export const secureMacStore: MacStore = {
  async load() {
    const raw = await SecureStore.getItemAsync(KEY, OPTIONS);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isPaired(parsed) ? parsed : null;
    } catch {
      return null;
    }
  },
  save: (mac) => SecureStore.setItemAsync(KEY, JSON.stringify(mac), OPTIONS),
  forget: () => SecureStore.deleteItemAsync(KEY, OPTIONS),
};
