import type { UpdateInfo } from "../types";

/** Lantern's releases on GitHub: where a version's full notes are, when they can't be shown here. */
export const releasePage = (version: string) => `https://github.com/alyakan/lantern/releases/tag/v${version}`;

/** The version this window last opened as. Different from the running one: Lantern has been updated. */
const SEEN_KEY = "lastSeenVersion";
/** Each waiting update's notes, by version, so the version that installs it can show them on its first launch. */
const NOTES_KEY = "whatsNew.notes";
/** How many versions' notes are kept: the running one, and the one waiting after it, with room to spare. */
const KEEP = 5;

/**
 * The release's body as the panel shows it: without the "## What's new" heading (the panel has its own) and without
 * the install line release.yml adds under it. Null when nothing is left, e.g. a release with no changes listed.
 */
export function whatsNewBody(notes: string): string | null {
  const paragraphs = notes
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^##\s+What's new$/i.test(p) && !/^Download the dmg\b/i.test(p));
  return paragraphs.join("\n\n") || null;
}

function readNotes(storage: Storage): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(NOTES_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Keeps the notes of a downloaded update, so the window of that version can show them after the restart. */
export function rememberNotes(storage: Storage, update: UpdateInfo): void {
  if (!update.notes) return;
  const kept = Object.entries({ ...readNotes(storage), [update.version]: update.notes }).slice(-KEEP);
  storage.setItem(NOTES_KEY, JSON.stringify(Object.fromEntries(kept)));
}

/** The notes kept for `version`, as the panel shows them. Null: none were kept, or there's nothing to show. */
export function notesFor(storage: Storage, version: string): string | null {
  const raw = readNotes(storage)[version];
  return raw ? whatsNewBody(raw) : null;
}

/**
 * Called as the window opens. Returns the running version when it isn't the one the window last saw (Lantern was
 * updated, so there's something new to show), and records it as seen. The very first launch sets it and shows nothing.
 */
export function newVersionToShow(storage: Storage, running: string): string | null {
  const seen = storage.getItem(SEEN_KEY);
  storage.setItem(SEEN_KEY, running);
  return seen !== null && seen !== running ? running : null;
}

/** The versions, of those given, that have notes to show (each once): for the Updates page's "What's new" entries. */
export function versionsWithNotes(storage: Storage, versions: (string | null | undefined)[]): string[] {
  const named = [...new Set(versions.filter((v): v is string => !!v))];
  return named.filter((v) => notesFor(storage, v) !== null);
}
