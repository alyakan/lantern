import { useCallback, useEffect, useRef, useState } from "react";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { beginDictation, dictate, dictationProblem, needsSettings, pickLanguage, type Dictated } from "../view/dictation";

/** How long it listens to nothing before it stops by itself. */
export const SILENCE_MS = 8000;

/** What went wrong, for the line under the message box; `settings` says that Settings is where it is fixed. */
export type DictationProblem = { words: string; settings: boolean };

/** The phone's own language, as the recognizer wants it ("en-US"); it chooses for itself when the phone doesn't say. */
function phoneLanguage(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

/** The languages the recognizer can listen in (what is installed, when it says); none when it won't say. */
async function languagesThere(): Promise<string[]> {
  try {
    const there = await ExpoSpeechRecognitionModule.getSupportedLocales({});
    return there.installedLocales?.length ? there.installedLocales : (there.locales ?? []);
  } catch {
    return [];
  }
}

/** Whether this phone has a speech recognizer to ask; no, rather than a crash, when the native side is missing. */
function recognizerThere(): boolean {
  try {
    return ExpoSpeechRecognitionModule.isRecognitionAvailable();
  } catch {
    return false;
  }
}

/**
 * Dictation into a text box: `start` turns the microphone on and what is said is written into the box (after what is
 * already there) as it is heard; `stop` ends it, keeping the words. It is the recognizer on the phone, asked to listen
 * on-device; where the phone can't do that for the language, the recognizer uses Apple's speech service instead (it says
 * nothing about it, and the module can't be made to refuse). Nothing is sent to the Mac. It ends by itself after a stretch
 * of silence, when the person edits the box by hand (`edited`), and when the box goes away.
 */
export function useDictation(text: string, setText: (text: string) => void) {
  const available = useRef(recognizerThere()).current;
  const [listening, setListening] = useState(false);
  const [problem, setProblem] = useState<DictationProblem | null>(null);
  const state = useRef<Dictated | null>(null);
  const asking = useRef(false);
  const silence = useRef<ReturnType<typeof setTimeout> | null>(null);

  const quiet = () => {
    if (silence.current) clearTimeout(silence.current);
    silence.current = null;
  };
  /** It is over: nothing more is written into the box. */
  const finish = useCallback(() => {
    quiet();
    state.current = null;
    setListening(false);
  }, []);
  /** Drops it at once, without waiting for the recognizer's last words. */
  const cancel = useCallback(() => {
    if (!state.current) return;
    finish();
    ExpoSpeechRecognitionModule.abort();
  }, [finish]);
  const arm = () => {
    quiet();
    silence.current = setTimeout(() => ExpoSpeechRecognitionModule.stop(), SILENCE_MS);
  };

  useSpeechRecognitionEvent("result", (e) => {
    if (!state.current) return;
    const best = e.results[0];
    if (!best) return;
    state.current = dictate(state.current, best.transcript, e.isFinal);
    setText(state.current.shown);
    arm();
  });
  useSpeechRecognitionEvent("end", finish);
  useSpeechRecognitionEvent("error", (e) => {
    finish();
    const words = dictationProblem(e.error);
    if (words) setProblem({ words, settings: needsSettings(e.error) });
  });
  // Leaving the chat turns the microphone off.
  useEffect(
    () => () => {
      quiet();
      if (state.current) ExpoSpeechRecognitionModule.abort();
      state.current = null;
    },
    [],
  );

  const start = async () => {
    if (!available || state.current || asking.current) return;
    setProblem(null);
    asking.current = true;
    try {
      const allowed = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!allowed.granted) {
        const words = dictationProblem("not-allowed");
        if (words) setProblem({ words, settings: true });
        return;
      }
      const lang = pickLanguage(phoneLanguage(), await languagesThere());
      if (lang === null) {
        const words = dictationProblem("language-not-supported");
        if (words) setProblem({ words, settings: false });
        return;
      }
      state.current = beginDictation(text);
      setListening(true);
      arm();
      ExpoSpeechRecognitionModule.start({ lang, interimResults: true, continuous: true, requiresOnDeviceRecognition: true, addsPunctuation: true });
    } catch {
      finish();
      setProblem({ words: "Dictation didn't start. Try again in a moment.", settings: false });
    } finally {
      asking.current = false;
    }
  };
  /** Ends it and keeps what was heard; the recognizer's last words still arrive. */
  const stop = () => {
    if (!state.current) return;
    quiet();
    ExpoSpeechRecognitionModule.stop();
  };

  return { available, listening, problem, dismiss: () => setProblem(null), start, stop, cancel, /** The person typed in the box: dictation steps aside. */ edited: cancel };
}
