import { actionIdForKey, useAction } from "./actions";

/**
 * Runs `handler` on ⌘+`key` (with Shift when `shift`; no other modifiers) while `enabled`. The key is an action of the
 * registry (src/lib/actions.ts), so the menu bar, the palette and the keyboard all run the same one. Components use
 * this for the shortcuts of the buttons they own, so a shortcut is off exactly when its button is.
 */
export function useShortcut(key: string, handler: () => void, enabled = true, shift = false) {
  useAction(actionIdForKey(key, shift), handler, enabled);
}
