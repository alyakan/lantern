/** The real Keychain behind the push key's seam: expo-secure-store, in the group the notification extension shares. Not run in tests. */
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { PushKeyStore } from "./pushKey";

const NAME = "push-key";
// The extension reads this item by these (see targets/): the group is the team's id and the app's, which the entitlement names
// as $(AppIdentifierPrefix)com.alyakan.lantern.push in app.json. A team id is on every app in the store: it is not a secret.
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: "lantern.push",
  accessGroup: "2NT5QR24SX.com.alyakan.lantern.push",
  // The extension runs while the phone is locked, so "when unlocked" would hide the key from it; and it never leaves this phone.
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/** The phone's Keychain store for the key; null where there is no extension to read it (Android). */
export const pushKeyStore: PushKeyStore | null =
  Platform.OS === "ios"
    ? {
        read: () => SecureStore.getItemAsync(NAME, OPTIONS),
        write: (key) => SecureStore.setItemAsync(NAME, key, OPTIONS),
        forget: () => SecureStore.deleteItemAsync(NAME, OPTIONS),
      }
    : null;
