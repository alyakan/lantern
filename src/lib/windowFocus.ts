import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Whether the app's window is the one in front. Inside the app, the native window says (Tauri's isFocused and its
 * focus-changed event): the page's own document.hasFocus() can report false in the app's web view while you're using
 * it. In a plain browser (the dev mock, tests) the page's focus and blur events are all there is.
 */

let focused = typeof document === "undefined" || document.hasFocus();
const waiting = new Set<() => void>();

function set(next: boolean) {
  if (next === focused) return;
  focused = next;
  if (focused) for (const run of [...waiting]) run();
}

if (typeof window !== "undefined") {
  window.addEventListener("focus", () => set(true));
  window.addEventListener("blur", () => set(false));
  if ("__TAURI_INTERNALS__" in window) {
    try {
      const win = getCurrentWindow();
      win.isFocused().then((f) => typeof f === "boolean" && set(f), () => {});
      win.onFocusChanged(({ payload }) => typeof payload === "boolean" && set(payload)).catch(() => {});
    } catch {
      // No native window to ask: the page's events decide.
    }
  }
}

export const windowFocused = () => focused;

/** Runs `fn` now if the window is in front, else when it next comes to the front. Returns a cancel. */
export function whenFocused(fn: () => void): () => void {
  if (focused) {
    fn();
    return () => {};
  }
  const run = () => {
    waiting.delete(run);
    fn();
  };
  waiting.add(run);
  return () => waiting.delete(run);
}
