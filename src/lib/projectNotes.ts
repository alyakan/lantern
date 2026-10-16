/** The most characters a project's notes hold: what the dialog allows, and what the app side cuts to as well (args::PROJECT_NOTES_MAX_CHARS). */
export const PROJECT_NOTES_MAX = 4000;

/** What the project's notes say ("" when it has none). */
export const notesOf = (by: Record<string, string>, folder: string | null): string => (folder ? (by[folder] ?? "") : "");

/** The notes with `text` as the project's: trimmed and cut to the limit, and an empty one takes the project out. */
export function withNotes(by: Record<string, string>, folder: string, text: string): Record<string, string> {
  const { [folder]: _old, ...rest } = by;
  const kept = text.trim().slice(0, PROJECT_NOTES_MAX);
  return kept ? { ...rest, [folder]: kept } : rest;
}

/** The folders that have notes. */
export const notedFolders = (by: Record<string, string>): string[] => Object.keys(by).filter((f) => by[f].trim() !== "");
