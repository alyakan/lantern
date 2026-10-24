/** What changed in this build, and whether it is time to say so. The notes are put into the app when a release is built (fastlane ios beta). */
import bundled from "./releaseNotes.json";

export interface ReleaseNotes {
  /** The app's version, which starts its build numbers over. */
  version: string;
  /** The build the notes are for: 0 when this is no release build (a development run), which has nothing to say. */
  build: number;
  notes: string[];
}

/** Whatever the file holds, made into notes: anything that isn't a build number and some text is left out. */
export function normalize(raw: unknown): ReleaseNotes {
  const o = (raw ?? {}) as { version?: unknown; build?: unknown; notes?: unknown };
  const version = typeof o.version === "string" ? o.version.trim() : "";
  const build = typeof o.build === "number" && Number.isInteger(o.build) && o.build > 0 ? o.build : 0;
  const notes = Array.isArray(o.notes) ? o.notes.filter((n): n is string => typeof n === "string" && n.trim() !== "").map((n) => n.trim()) : [];
  return { version, build, notes };
}

/** This build's notes. */
export const releaseNotes: ReleaseNotes = normalize(bundled);

/** Whether this build has anything to say. */
export const hasNotes = (n: ReleaseNotes) => n.build > 0 && n.notes.length > 0;

/** Which build the notes are for, as it is remembered: the version too, since a new version starts its build numbers over. */
export const notesId = (n: ReleaseNotes) => `${n.version}-${n.build}`;

/** What is remembered when the store can't be read: counts as everything shown, so a broken store never brings the notes back at every launch. */
export const NOTES_UNREADABLE = "unreadable";

/**
 * What to do about the notes when Home is up. `seen` is the `notesId` of the last notes shown:
 * - "show": open them once. A different build from the last shown, or nothing is remembered and the phone was already in use
 *   when the app started, which is an update from a build that didn't remember (so the first build with notes is not skipped).
 * - "mark": remember them as shown and open nothing. Nothing is remembered and the phone was paired just now: a new install has
 *   no "new" to tell.
 * - "skip": nothing to say, or already shown.
 */
export function noteAction(notes: ReleaseNotes, seen: string | null, pairedThisSession: boolean): "show" | "mark" | "skip" {
  if (!hasNotes(notes) || seen === NOTES_UNREADABLE) return "skip";
  if (seen === null) return pairedThisSession ? "mark" : "show";
  return seen !== notesId(notes) ? "show" : "skip";
}
