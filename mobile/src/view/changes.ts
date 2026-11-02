/** The files a chat has changed, for a tablet's Changes pane: what its steps edited, one row per file, as the chat's own steps said. */
import type { Item } from "../sync/reducer";

export interface ChangedFile {
  path: string;
  /** The last part of the path. */
  name: string;
  /** The folder the file is in, as far as the path says (empty for a bare name). */
  folder: string;
  added: number;
  removed: number;
  created: boolean;
}

const nameOf = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
const folderOf = (path: string) => path.split("/").filter(Boolean).slice(-3, -1).join("/");

/** One row per file the chat's steps edited, the most recently edited first; a file edited twice counts both, and counts as created if it was created. */
export function changedFiles(items: Item[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const it of items) {
    if (it.kind !== "step") continue;
    for (const e of it.edits) {
      const was = byPath.get(e.path);
      // Moved to the end of the map, so the order is the order of the last edit.
      byPath.delete(e.path);
      byPath.set(e.path, { path: e.path, name: nameOf(e.path), folder: folderOf(e.path), added: (was?.added ?? 0) + e.added, removed: (was?.removed ?? 0) + e.removed, created: was?.created || e.created });
    }
  }
  return [...byPath.values()].reverse();
}

/** "3 files · +40 −12", or null when nothing was changed. */
export function changesLine(files: ChangedFile[]): string | null {
  if (files.length === 0) return null;
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return `${files.length === 1 ? "1 file" : `${files.length} files`} · +${added} −${removed}`;
}

/**
 * The changed file a link in the chat names, or null when it names none of them. A link may give the path whole or from the
 * project's folder, so either may end the other (at a "/").
 */
export function changedFileOf(files: ChangedFile[], path: string): string | null {
  const ends = (long: string, short: string) => long === short || long.endsWith("/" + short.replace(/^\.?\//, ""));
  return files.find((f) => ends(f.path, path) || ends(path, f.path))?.path ?? null;
}
