import { requireOptionalNativeModule } from "expo-modules-core";

/** What the native module (iOS only) offers, see ios/ComposerKeysModule.swift. */
export interface ComposerKeysNative {
  /** The message box has the keyboard (true) or no longer does (false). */
  setEnabled(enabled: boolean): void;
  /** A plain Return on a hardware keyboard (Shift+Return isn't reported: it stays a new line). */
  addListener(event: "onReturn", listener: () => void): { remove(): void };
}

/** Null where there is no such module: Android, tests, and a build made before it was added (then Return stays a new line). */
export const ComposerKeys = requireOptionalNativeModule<ComposerKeysNative>("ComposerKeys");
