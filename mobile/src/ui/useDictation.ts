import { useCallback, useEffect, useRef, useState } from "react";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { LanternSpeech } from "../../modules/lantern-speech";
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

/** A recognizer that can be stopped, either way. */
type Engine = { stop(): void; abort(): void };
const older: Engine = { stop: () => ExpoSpeechRecognitionModule.stop(), abort: () => ExpoSpeechRecognitionModule.abort() };
const newer: Engine = { stop: () => LanternSpeech?.stop(), abort: () => LanternSpeech?.abort() };

/** iOS 26's own name for the language, when its newer model can listen in it; null means the older recognizer it is. */
async function newerLanguage(lang: string | undefined): Promise<string | null> {
  if (!LanternSpeech || !lang) return null;
  try {
    return await LanternSpeech.supportedLanguage(lang);
  } catch {
    return null;
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
 * already there) as it is heard; `stop` ends it, keeping the words. On iOS 26 it is SpeechAnalyzer's newer on-device
 * model (modules/lantern-speech), for the languages it has; otherwise the older recognizer, asked to listen on-device;
 * where the phone can't do that for the language, that one uses Apple's speech service instead (it says nothing about
 * it, and the module can't be made to refuse). Nothing is sent to the Mac. It ends by itself after a stretch
 * of silence, when the person edits the box by hand (`edited`), and when the box goes away.
 */
export function useDictation(text: string, setText: (text: string) => void) {
  const available = useRef(recognizerThere()).current;
  const [listening, setListening] = useState(false);
  const [problem, setProblem] = useState<DictationProblem | null>(null);
  const state = useRef<Dictated | null>(null);
  const asking = useRef(false);
  const engine = useRef<Engine>(older);
  /** The newer model is still starting (its first time, downloading the language): whether stop was asked meanwhile. */
  const starting = useRef<"go" | "stop" | null>(null);
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
    engine.current.abort();
  }, [finish]);
  const arm = () => {
    quiet();
    silence.current = setTimeout(() => engine.current.stop(), SILENCE_MS);
  };

  const heard = (transcript: string, isFinal: boolean) => {
    if (!state.current) return;
    state.current = dictate(state.current, transcript, isFinal);
    setText(state.current.shown);
    arm();
  };
  const failed = (code: string) => {
    finish();
    const words = dictationProblem(code);
    if (words) setProblem({ words, settings: needsSettings(code) });
  };
  useSpeechRecognitionEvent("result", (e) => {
    const best = e.results[0];
    if (best && engine.current === older) heard(best.transcript, e.isFinal);
  });
  useSpeechRecognitionEvent("end", () => engine.current === older && finish());
  useSpeechRecognitionEvent("error", (e) => engine.current === older && failed(e.error));
  // The newer model's events, while it is the one listening.
  const latest = useRef({ heard, finish, failed });
  latest.current = { heard, finish, failed };
  useEffect(() => {
    if (!LanternSpeech) return;
    const subs = [
      LanternSpeech.addListener("result", (e) => engine.current === newer && latest.current.heard(e.transcript, e.isFinal)),
      LanternSpeech.addListener("end", () => engine.current === newer && latest.current.finish()),
      LanternSpeech.addListener("error", (e) => engine.current === newer && latest.current.failed(e.error)),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);
  // Leaving the chat turns the microphone off.
  useEffect(
    () => () => {
      quiet();
      if (state.current) engine.current.abort();
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
      const better = await newerLanguage(lang);
      state.current = beginDictation(text);
      setListening(true);
      if (better && LanternSpeech) {
        engine.current = newer;
        starting.current = "go";
        // The first time, this waits for the language's model to download.
        await LanternSpeech.start(better);
        const asked = starting.current as string | null;
        starting.current = null;
        // Dropped while it was starting (or it failed to): the microphone goes off. Stopped: it finishes now.
        if (!state.current) return LanternSpeech.abort();
        if (asked === "stop") return LanternSpeech.stop();
      } else {
        engine.current = older;
        ExpoSpeechRecognitionModule.start({ lang, interimResults: true, continuous: true, requiresOnDeviceRecognition: true, addsPunctuation: true });
      }
      arm();
    } catch {
      starting.current = null;
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
    if (starting.current) starting.current = "stop";
    else engine.current.stop();
  };

  return { available, listening, problem, dismiss: () => setProblem(null), start, stop, cancel, /** The person typed in the box: dictation steps aside. */ edited: cancel };
}
