import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { Attention } from "./attention";
import { loadNotifyPrefs, shouldNotify } from "./notifyPrefs";

let allowed: Promise<boolean> | null = null;

/**
 * Posts a macOS notification, asking for permission the first time. Nothing is posted when Settings has this kind of
 * event off, or notifications are paused. Does nothing outside the app (tests, mock).
 */
export async function notify(title: string, body: string, kind: Attention["kind"] | "reminder") {
  // A to-do's reminder is the user's own: only notifications being off or paused holds it back, not a kind of chat event.
  const prefs = loadNotifyPrefs();
  if (kind === "reminder" ? !prefs.on || Date.now() < prefs.pausedUntil : !shouldNotify(prefs, kind)) return;
  try {
    allowed ??= isPermissionGranted().then((ok) => ok || requestPermission().then((p) => p === "granted"));
    if (await allowed) sendNotification({ title, body });
  } catch {
    allowed = null;
  }
}
