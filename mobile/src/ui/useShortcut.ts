import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { ComposerKeys, type Shortcut } from "../../modules/composer-keys";

/** How many screens listen for a shortcut: the keyboard's commands are on while any does. */
let listening = 0;

/**
 * On an iPad with a keyboard attached, `run` answers one of the app's shortcuts (Command-N, Command-F, Command-\, Escape) while
 * `active`. Holding Command lists them, as iPadOS does for any app. Nothing happens on a phone, or in a build without the native
 * module (an older one has no shortcuts at all).
 */
export function useShortcut(name: Shortcut, run: () => void, active = true) {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    const keys = ComposerKeys;
    if (!keys?.setShortcuts || !active || Platform.OS !== "ios" || !Platform.isPad) return;
    const sub = keys.addListener("onShortcut", (e) => e.name === name && latest.current());
    if (listening++ === 0) keys.setShortcuts(true);
    return () => {
      sub.remove();
      if (--listening === 0) keys.setShortcuts?.(false);
    };
  }, [name, active]);
}
