import { requireOptionalNativeModule } from "expo-modules-core";

/** The app's shortcuts on a hardware keyboard: Command-N, Command-F, Command-\ and Escape. */
export type Shortcut = "newChat" | "find" | "toggleChats" | "escape";

/** What the native module (iOS only) offers, see ios/ComposerKeysModule.swift. */
export interface ComposerKeysNative {
  /** The message box has the keyboard (true) or no longer does (false). */
  setEnabled(enabled: boolean): void;
  /** The app's shortcuts on a hardware keyboard are on (true) or off (an older build has no such function). */
  setShortcuts?(enabled: boolean): void;
  /** A plain Return on a hardware keyboard (Shift+Return isn't reported: it stays a new line). */
  addListener(event: "onReturn", listener: () => void): { remove(): void };
  /** One of the app's shortcuts was pressed (an older build has none, and never says so). */
  addListener(event: "onShortcut", listener: (e: { name: Shortcut }) => void): { remove(): void };
}

/** Null where there is no such module: Android, tests, and a build made before it was added (then Return stays a new line). */
export const ComposerKeys = requireOptionalNativeModule<ComposerKeysNative>("ComposerKeys");
