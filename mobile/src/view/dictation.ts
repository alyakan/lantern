/** Where dictation stands: what was in the box when it began and the words heard since, and what the box shows. */
export type Dictated = {
  /** What was in the box before, plus every stretch the recognizer has finished with. */
  kept: string;
  /** The stretch it is still working on (it changes as more is heard). */
  heard: string;
  /** What the box says as a result: the last thing dictation wrote there. */
  shown: string;
};

/** Two pieces of text with one space between them (none when either is empty or already ends in whitespace). */
function join(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return /\s$/.test(a) ? a + b : `${a} ${b}`;
}

/** Nothing heard yet, over what the box already holds. */
export const beginDictation = (box: string): Dictated => ({ kept: box, heard: "", shown: box });

/**
 * What a result from the recognizer does to the box. A finished stretch is kept and the next one adds to it; one still
 * in progress is shown but replaced by the next. A leading "!" is never written: the box turns into a terminal on one,
 * and what is said is for Claude, not the Mac's shell.
 */
export function dictate(state: Dictated, transcript: string, isFinal: boolean): Dictated {
  const words = transcript.trim().replace(/^!+\s*/, "");
  const kept = isFinal ? join(state.kept, words) : state.kept;
  const heard = isFinal ? "" : words;
  return { kept, heard, shown: join(kept, heard) };
}

/**
 * The language to listen in, out of the ones the recognizer has: the phone's own when it is there, else one in the same
 * language ("en-EG" has none of its own: "en-US"), else null. With none to choose from (Android before 13 doesn't say)
 * the phone's own is tried as it is.
 */
export function pickLanguage(phone: string | undefined, available: string[]): string | undefined | null {
  if (available.length === 0) return phone;
  if (!phone) return undefined;
  const dashed = (l: string) => l.replace(/_/g, "-");
  const want = dashed(phone);
  const exact = available.find((l) => dashed(l) === want);
  if (exact) return exact;
  const language = want.split("-")[0].toLowerCase();
  const same = available.filter((l) => dashed(l).split("-")[0].toLowerCase() === language);
  return same.find((l) => dashed(l).toLowerCase() === `${language}-${language}`) ?? same.find((l) => dashed(l) === `${language}-US`) ?? same[0] ?? null;
}

/** Why dictation could not start or stopped, in words for the person using it; null when nothing is worth saying. */
export function dictationProblem(code: string): string | null {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Lantern can't hear you. Turn on the microphone and speech recognition for it in Settings.";
    case "language-not-supported":
      return "Your phone can't turn this language into text yet.";
    case "audio-capture":
      return "The microphone isn't working right now.";
    case "network":
      return "Dictating needs a connection for this language.";
    case "busy":
      return "Dictation is busy. Try again in a moment.";
    // The person stopped it, said nothing, or something else took the microphone: no scolding.
    default:
      return null;
  }
}

/** The recognizer's code for a refusal that Settings can fix. */
export const needsSettings = (code: string) => code === "not-allowed" || code === "service-not-allowed";
