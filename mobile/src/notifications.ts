/**
 * Notifications on the phone. The Mac sends a push when a chat needs you or finishes: it carries a chat id and a kind (and a
 * title only if you turned that on in Lantern), never code or prompts. This registers the phone for them, and says which chat
 * a tap opens.
 *
 * On an iPhone the Mac pushes straight to Apple with the phone's own device token (the way the lock-screen cards are kept
 * right), which needs no account but the push key the Mac already has, and carries the buttons (see notificationActions.ts).
 * Elsewhere it goes through Expo's push service, which needs the app's EAS project id, which comes from the user's Expo account
 * (`eas init` writes it to app.json at extra.eas.projectId). Without it nothing is registered, and the app says so instead of
 * failing.
 */

export type PushStatus = { kind: "registered"; token: string } | { kind: "no-project" } | { kind: "denied" } | { kind: "not-a-phone" } | { kind: "failed"; why: string };

/** The parts of expo-notifications and expo-device this uses, so a test can stand in for them. */
export interface PushPlatform {
  isDevice: boolean;
  getPermission: () => Promise<"granted" | "denied" | "undetermined">;
  requestPermission: () => Promise<"granted" | "denied" | "undetermined">;
  getToken: (projectId: string) => Promise<string>;
  /** The phone's own device token, where the Mac can push to Apple with it (an iPhone): used instead of Expo's, with no project. */
  getDeviceToken?: () => Promise<string>;
  /** Android needs a channel before any notification shows. */
  prepareChannel: () => Promise<void>;
}

export async function registerForPush(platform: PushPlatform, projectId: string | undefined, send: (token: string) => Promise<unknown>): Promise<PushStatus> {
  if (!projectId && !platform.getDeviceToken) return { kind: "no-project" };
  if (!platform.isDevice) return { kind: "not-a-phone" };
  try {
    await platform.prepareChannel();
    let permission = await platform.getPermission();
    if (permission !== "granted") permission = await platform.requestPermission();
    if (permission !== "granted") return { kind: "denied" };
    const token = platform.getDeviceToken ? await platform.getDeviceToken() : await platform.getToken(projectId as string);
    await send(token);
    return { kind: "registered", token };
  } catch (e) {
    return { kind: "failed", why: (e as Error).message };
  }
}

/** The chat a tapped notification is about: a push carries `{ slot, kind }`, and anything else opens nothing. */
export function slotOfNotification(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const slot = (data as { slot?: unknown }).slot;
  return typeof slot === "string" && /^[A-Za-z0-9-]{1,16}$/.test(slot) ? slot : null;
}

/** The words for where push stands, for Settings and the Mac's sheet. */
export function pushLine(status: PushStatus | null): string {
  switch (status?.kind) {
    case "registered":
      return "Notifications are on.";
    case "denied":
      return "Notifications are off. Turn them on in this phone's Settings to hear when a chat needs you.";
    case "no-project":
      return "Notifications aren't set up in this build yet.";
    case "not-a-phone":
      return "Notifications need a real phone.";
    case "failed":
      return `Notifications couldn't be set up: ${status.why}`;
    default:
      return "";
  }
}
