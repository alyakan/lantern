import { getCurrentWebview } from "@tauri-apps/api/webview";

/**
 * Files dropped on the window: their paths go into the box, as dropping them into a terminal running Claude Code does,
 * and Claude reads them (its Read tool takes images and PDFs as well as text).
 */

/** A path as the box puts it: as it is, or in single quotes when it has a space or a character a shell would read. */
export function quotePath(path: string): string {
  return /^[\w@%+=:,./~-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * `text` with `paths` put in place of the selection `from`..`to`, separated from each other and from the words around
 * them by a space, and where the caret goes after them.
 */
export function insertPaths(text: string, from: number, to: number, paths: string[]): { text: string; caret: number } {
  const before = text.slice(0, from);
  const after = text.slice(to);
  const lead = before === "" || /\s$/.test(before) ? "" : " ";
  const inserted = lead + paths.map(quotePath).join(" ") + (/^\s/.test(after) ? "" : " ");
  return { text: before + inserted + after, caret: before.length + inserted.length };
}

export interface FileDrop {
  /** Files are being dragged over the window (true), or left it (false). */
  over: (on: boolean) => void;
  drop: (paths: string[]) => void;
}

/**
 * Listens for files dropped on the window. The app's web view hands drops to Tauri, which gives their paths (a page's
 * own drop event has no path); outside the app (the dev mock, tests) there is nothing to listen to. Returns a stop.
 */
export function onFileDrop(handler: FileDrop): () => void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return () => {};
  let stop: (() => void) | null = null;
  let stopped = false;
  getCurrentWebview()
    .onDragDropEvent(({ payload }) => {
      if (payload.type === "enter" || payload.type === "over") handler.over(true);
      else if (payload.type === "leave") handler.over(false);
      else {
        handler.over(false);
        if (payload.paths.length > 0) handler.drop(payload.paths);
      }
    })
    .then(
      (unlisten) => (stopped ? unlisten() : (stop = unlisten)),
      () => {},
    );
  return () => {
    stopped = true;
    stop?.();
  };
}
