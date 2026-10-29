/** The real push platform: expo-notifications and expo-device, behind the PushPlatform seam. Not run in tests. */
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { Controller } from "./shell/controller";
import type { AppLock } from "./lock";
import { CATEGORIES, connectedWithin, TAP, type ActionHost, type ResponseLike } from "./notificationActions";
import type { PushPlatform } from "./notifications";
import { todoOfNotification } from "./view/todos";

export const pushPlatform: PushPlatform = {
  isDevice: Device.isDevice,
  getPermission: async () => (await Notifications.getPermissionsAsync()).status,
  requestPermission: async () => (await Notifications.requestPermissionsAsync()).status,
  getToken: async (projectId) => (await Notifications.getExpoPushTokenAsync({ projectId })).data,
  // An iPhone's own token is what the Mac pushes to Apple with (it needs no Expo account).
  ...(Platform.OS === "ios" ? { getDeviceToken: async () => String((await Notifications.getDevicePushTokenAsync()).data) } : {}),
  prepareChannel: async () => {
    if (Platform.OS === "android") await Notifications.setNotificationChannelAsync("default", { name: "Lantern", importance: Notifications.AndroidImportance.HIGH });
  },
};

/**
 * While the app is open a chat that needs you already shows on screen: a banner on top of it would only repeat. A to-do's
 * reminder is shown nowhere else, so it still comes as a banner.
 */
export function quietInForeground() {
  Notifications.setNotificationHandler({
    handleNotification: async (n) => {
      const show = todoOfNotification(n.request.content.data) !== null;
      return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
    },
  });
}

/** Registers the buttons notifications can have (iOS keeps them by name: the Mac's push names one). Every launch, as they aren't kept. */
export async function registerButtons() {
  if (Platform.OS !== "ios") return;
  for (const c of CATEGORIES) await Notifications.setNotificationCategoryAsync(c.identifier, c.actions).catch(() => {});
}

/**
 * Calls `handle` with each response to a notification (a tap, or one of its buttons); returns how to stop listening. The last
 * response is given too, once: it is the tap that started the app, or a button pressed while the app was not running. It is
 * cleared after, so it isn't given again.
 */
export function onNotificationResponse(handle: (r: ResponseLike) => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((r) => handle(r));
  void Notifications.getLastNotificationResponseAsync().then((r) => {
    if (!r) return;
    handle(r);
    // A tap that started the app is opened once; a button is not pressed again by the next launch.
    if (r.actionIdentifier !== TAP) Notifications.clearLastNotificationResponse();
  });
  return () => sub.remove();
}

/** What a notification's buttons work with: this app's connection to the Mac, and a notification of its own for what failed. */
export function actionHost(controller: Controller, lock: AppLock): ActionHost {
  return {
    lockOn: async () => {
      if (!lock.getState().ready) await lock.start();
      const s = lock.getState();
      return s.enabled && s.available;
    },
    connected: (ms) =>
      connectedWithin(
        {
          now: Date.now,
          up: () => controller.getConnection().kind === "connected",
          alive: () => controller.sync.alive(),
          redial: () => controller.resume(),
          changed: (wait) =>
            new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer);
                stop();
                resolve();
              };
              const timer = setTimeout(done, wait);
              const stop = controller.subscribeConnection(done);
            }),
        },
        ms,
      ),
    answer: (slot, requestId, allow) => controller.sync.answer(slot, requestId, allow),
    send: (slot, text) => controller.sync.sendQuiet(slot, text),
    todoEdit: (project, edit) => controller.sync.todoEdit(project, edit),
    tell: (title, body) => Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: null }),
  };
}
