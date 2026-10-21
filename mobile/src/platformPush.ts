/** The real push platform: expo-notifications and expo-device, behind the PushPlatform seam. Not run in tests. */
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { PushPlatform } from "./notifications";

export const pushPlatform: PushPlatform = {
  isDevice: Device.isDevice,
  getPermission: async () => (await Notifications.getPermissionsAsync()).status,
  requestPermission: async () => (await Notifications.requestPermissionsAsync()).status,
  getToken: async (projectId) => (await Notifications.getExpoPushTokenAsync({ projectId })).data,
  prepareChannel: async () => {
    if (Platform.OS === "android") await Notifications.setNotificationChannelAsync("default", { name: "Lantern", importance: Notifications.AndroidImportance.HIGH });
  },
};

/** While the app is open a chat that needs you already shows on screen: a banner on top of it would only repeat. */
export function quietInForeground() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false }),
  });
}

/** Calls `open` with the chat a tapped notification is about; returns how to stop listening. */
export function onNotificationTap(open: (data: unknown) => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((r) => open(r.notification.request.content.data));
  // The tap that started the app.
  void Notifications.getLastNotificationResponseAsync().then((r) => r && open(r.notification.request.content.data));
  return () => sub.remove();
}
