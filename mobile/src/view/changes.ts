/** The files a chat has changed, for a tablet's Changes pane: what its steps edited, one row per file, as the chat's own steps said. */
import type { RemoteChangedFile } from "../protocol/generated/RemoteChangedFile";
import type { RemoteChangeScope } from "../protocol/generated/RemoteChangeScope";
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
  /** A file a link in the chat named that isn't one of the list's: shown, with no counts. */
  linked?: boolean;
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

/** The Changes pane's views, as the Mac's Changes tab names them. */
export const SCOPES: { value: RemoteChangeScope; label: string }[] = [
  { value: "chat", label: "This chat" },
  { value: "uncommitted", label: "Uncommitted" },
  { value: "branch", label: "This branch" },
];

/** What a view says when it lists nothing. */
export const EMPTY_SCOPE: Record<RemoteChangeScope, string> = {
  chat: "Nothing changed in this chat yet.",
  uncommitted: "Nothing uncommitted.",
  branch: "This branch has no changes of its own yet.",
};

/** The Mac's list of a view, as the pane's rows: by path, as its Changes tab lists them. */
export function fromMac(files: RemoteChangedFile[]): ChangedFile[] {
  return files.map((f) => ({ path: f.path, name: nameOf(f.path), folder: folderOf(f.path), added: f.added, removed: f.removed, created: f.created }));
}

/** The rows, with a file a link named first when it isn't one of them (by the path it names in the list, if it is). */
export function withLinked(files: ChangedFile[], linked: string | null): ChangedFile[] {
  if (!linked || changedFileOf(files, linked)) return files;
  return [{ path: linked, name: nameOf(linked), folder: folderOf(linked), added: 0, removed: 0, created: false, linked: true }, ...files];
}
