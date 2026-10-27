/** Reading a message aloud with the phone's own voice (expo-speech). Only the text is handed over; nothing leaves the phone but what the system speaks. */
import * as Speech from "expo-speech";
import { spokenText } from "./view/speech";

export interface SpeechPlatform {
  /** Starts reading `markdown` aloud; resolves when it has been read or was stopped. Rejects only when speech could not start. */
  read(markdown: string): Promise<void>;
  stop(): void;
}

export const platformSpeech: SpeechPlatform = {
  read(markdown) {
    const text = spokenText(markdown);
    if (!text) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      try {
        Speech.stop();
        Speech.speak(text, { onDone: () => resolve(), onStopped: () => resolve(), onError: (e) => reject(e instanceof Error ? e : new Error("Speech could not start.")) });
      } catch (e) {
        reject(e instanceof Error ? e : new Error("Speech could not start."));
      }
    });
  },
  stop() {
    try {
      Speech.stop();
    } catch {
      // Nothing is speaking.
    }
  },
};
