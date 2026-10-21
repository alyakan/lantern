import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { useFonts } from "expo-font";
import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import { BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold } from "@expo-google-fonts/bricolage-grotesque";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { Controller } from "./src/shell/controller";
import { Root } from "./src/shell/Root";
import { zeroconfDiscovery } from "./src/net/discovery";
import { webSocketTransport } from "./src/net/transport";
import { registerForPush, slotOfNotification } from "./src/notifications";
import { TipsContext } from "./src/shell/tipsContext";
import { iapPlatform, secureTipMemory, startTipListener } from "./src/platformTips";
import { demoPlatform, TipJar } from "./src/tips";
import { onNotificationTap, pushPlatform, quietInForeground } from "./src/platformPush";
import { secureMacStore } from "./src/storage";

// The splash stays up until the headings' font is in (see below), instead of a blank screen.
void SplashScreen.preventAutoHideAsync().catch(() => {});

/** The EAS project id Expo's push service needs (app.json, extra.eas.projectId; `eas init` writes it). */
const projectId: string | undefined = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;

export default function App() {
  const [fontsLoaded, fontError] = useFonts({ BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold });
  // A font that failed to load shows the system font instead of keeping the app on its splash for good.
  const fontsReady = fontsLoaded || fontError !== null;
  const controller = useMemo(
    () =>
      new Controller({
        transport: webSocketTransport,
        store: secureMacStore,
        discovery: zeroconfDiscovery(),
        deviceName: Device.deviceName ?? Device.modelName ?? "Phone",
        appVersion: Constants.expoConfig?.version ?? "0",
      }),
    [],
  );
  // The tip jar: the real store, or (EXPO_PUBLIC_FAKE_TIPS=1) three made-up tips for trying the screens without one.
  const tipJar = useMemo(() => new TipJar(process.env.EXPO_PUBLIC_FAKE_TIPS === "1" ? demoPlatform : iapPlatform, secureTipMemory), []);
  useEffect(() => {
    // A tip that goes through while no screen is waiting on it (an Ask to Buy approval) still gets finished.
    if (process.env.EXPO_PUBLIC_FAKE_TIPS !== "1") startTipListener();
  }, []);
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const [openSlot, setOpenSlot] = useState<string | null>(null);
  const registered = useRef(false);

  useEffect(() => {
    void controller.start();
    const sub = AppState.addEventListener("change", (s) => s === "active" && controller.resume());
    return () => sub.remove();
  }, [controller]);

  // A pairing link tapped outside the app, or the one the app was opened with: confirmed before it pairs.
  useEffect(() => {
    const take = (url: string | null) => url && /^lantern:\/\/pair/i.test(url) && setPendingLink(url);
    void Linking.getInitialURL().then(take);
    const sub = Linking.addEventListener("url", (e) => take(e.url));
    return () => sub.remove();
  }, []);

  // Notifications: registered once a Mac is connected, and a tap opens its chat.
  useEffect(() => {
    quietInForeground();
    return onNotificationTap((data) => setOpenSlot(slotOfNotification(data)));
  }, []);
  useEffect(() => {
    const check = () => {
      if (registered.current || controller.getConnection().kind !== "connected") return;
      registered.current = true;
      void registerForPush(pushPlatform, projectId, (token) => controller.sync.registerPushToken(token));
    };
    check();
    const stop = controller.subscribeConnection(check);
    return () => void stop();
  }, [controller]);

  const clearLink = useCallback(() => setPendingLink(null), []);
  const clearSlot = useCallback(() => setOpenSlot(null), []);
  useEffect(() => {
    if (fontsReady) void SplashScreen.hideAsync().catch(() => {});
  }, [fontsReady]);
  // Until the headings' font is in, the splash: showing the system font for a moment and then swapping is worse.
  if (!fontsReady) return null;
  // The provider follows the keyboard on the native side, so what rides above it (a chat's message box) keeps pace with it.
  return (
    <KeyboardProvider>
      <TipsContext.Provider value={tipJar}>
        <Root controller={controller} pendingLink={pendingLink} onClearLink={clearLink} openSlot={openSlot} onOpened={clearSlot} />
      </TipsContext.Provider>
    </KeyboardProvider>
  );
}
