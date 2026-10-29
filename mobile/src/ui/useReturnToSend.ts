import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { ComposerKeys } from "../../modules/composer-keys";

/**
 * On an iPad with a keyboard attached, Return in the message box sends and Shift+Return makes a new line. `active` is whether the
 * box has the keyboard: Return is taken over only then, so every other field keeps its own. Nothing happens on a phone (where
 * Return is a new line and the button sends), on the on-screen keyboard, or in a build without the native module.
 */
export function useReturnToSend(active: boolean, send: () => void) {
  const latest = useRef(send);
  latest.current = send;
  useEffect(() => {
    const keys = ComposerKeys;
    if (!keys || !active || Platform.OS !== "ios" || !Platform.isPad) return;
    const listening = keys.addListener("onReturn", () => latest.current());
    keys.setEnabled(true);
    return () => {
      keys.setEnabled(false);
      listening.remove();
    };
  }, [active]);
}
