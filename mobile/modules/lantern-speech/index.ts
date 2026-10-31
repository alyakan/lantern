import { requireOptionalNativeModule } from "expo-modules-core";

/** What the native module (iOS 26 and later) offers, see ios/LanternSpeechModule.swift. */
export interface LanternSpeechNative {
  /** The recognizer's own name for the language it would listen in for `lang` ("en-US"), or null when it has none. */
  supportedLanguage(lang: string): Promise<string | null>;
  /** Turns the microphone on (fetching the language's model the first time); results arrive as `result` events. */
  start(lang: string): Promise<void>;
  /** Ends it once the last words are written; `end` follows. */
  stop(): void;
  /** Drops it at once; `end` follows. */
  abort(): void;
  addListener(event: "result", listener: (e: { transcript: string; isFinal: boolean }) => void): { remove(): void };
  addListener(event: "end", listener: () => void): { remove(): void };
  addListener(event: "error", listener: (e: { error: string }) => void): { remove(): void };
}

/** Null where there is no such module: Android, tests, and a build made before it was added (then the older recognizer is used). */
export const LanternSpeech = requireOptionalNativeModule<LanternSpeechNative>("LanternSpeech");
