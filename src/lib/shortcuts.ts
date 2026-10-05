import { useEffect, useRef } from "react";

/**
 * Runs `handler` on ⌘+`key` (with Shift when `shift`; no other modifiers) anywhere in the window, while `enabled`.
 * Components register the shortcuts for the buttons they own, so a shortcut is off exactly when its button is.
 */
export function useShortcut(key: string, handler: () => void, enabled = true, shift = false) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey !== shift || e.key.toLowerCase() !== key) return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key, enabled, shift]);
}
