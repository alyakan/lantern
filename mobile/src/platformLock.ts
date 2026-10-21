/** The real lock: the phone's own biometrics and passcode (expo-local-authentication), and a flag in the Keychain or Keystore. */
import { Platform } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";
import type { AuthResult, LockMemory, LockPlatform, Strength } from "./lock";

const KEY = "lantern.app-lock";
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

/** What the phone can check someone with, from the level it reports (a passcode, or a fingerprint or face). */
export function strengthOf(level: LocalAuthentication.SecurityLevel): Strength {
  if (level === LocalAuthentication.SecurityLevel.NONE) return "none";
  return level === LocalAuthentication.SecurityLevel.SECRET ? "passcode" : "biometric";
}

/** What a failed check means: the person backed out, the phone has nothing to check with, or it just didn't match. */
export function resultOf(error: string | undefined): AuthResult {
  switch (error) {
    case "user_cancel":
    case "system_cancel":
    case "app_cancel":
      return "cancelled";
    case "not_enrolled":
    case "passcode_not_set":
    case "not_available":
      return "unavailable";
    default:
      return "failed";
  }
}

export const lockPlatform: LockPlatform = {
  async strength() {
    return strengthOf(await LocalAuthentication.getEnrolledLevelAsync());
  },
  async method() {
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    const face = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);
    const finger = types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT);
    if (Platform.OS === "ios") return face ? "Face ID" : finger ? "Touch ID" : "your passcode";
    return face || finger ? "your fingerprint or face" : "your passcode";
  },
  async authenticate(reason) {
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: reason, cancelLabel: "Cancel", disableDeviceFallback: false });
    return result.success ? "ok" : resultOf(result.error);
  },
};

export const secureLockMemory: LockMemory = {
  async load() {
    return (await SecureStore.getItemAsync(KEY, OPTIONS)) === "1";
  },
  save: (on) => (on ? SecureStore.setItemAsync(KEY, "1", OPTIONS) : SecureStore.deleteItemAsync(KEY, OPTIONS)),
};
