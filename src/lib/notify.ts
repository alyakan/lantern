import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

let allowed: Promise<boolean> | null = null;

/** Posts a macOS notification, asking for permission the first time. Does nothing outside the app (tests, mock). */
export async function notify(title: string, body: string) {
  try {
    allowed ??= isPermissionGranted().then((ok) => ok || requestPermission().then((p) => p === "granted"));
    if (await allowed) sendNotification({ title, body });
  } catch {
    allowed = null;
  }
}
