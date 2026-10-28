import config from "../app.json";

/**
 * Settings the phone can't talk to the Mac without, and that fail silently when they're missing: nothing in the code
 * says so, the connection just never opens (Android blocks `ws://` unless cleartext is allowed; iOS refuses the local
 * network, Bonjour and the camera without their usage strings).
 */
describe("app.json", () => {
  const expo = config.expo;

  it("lets Android open the plain ws:// connection to the Mac on the Wi-Fi", () => {
    const plugins: unknown[] = expo.plugins;
    const props = plugins.find((p) => Array.isArray(p) && p[0] === "expo-build-properties") as [string, { android?: { usesCleartextTraffic?: boolean } }] | undefined;
    expect(props?.[1].android?.usesCleartextTraffic).toBe(true);
  });

  it("asks iOS for the local network, Bonjour's service and the camera, in words", () => {
    const plist = expo.ios.infoPlist;
    expect(plist.NSLocalNetworkUsageDescription.length).toBeGreaterThan(10);
    expect(plist.NSBonjourServices).toEqual(["_lantern._tcp"]);
    expect(plist.NSCameraUsageDescription.length).toBeGreaterThan(10);
  });

  it("runs on an iPad in every orientation, while an iPhone stays upright", () => {
    expect(expo.ios.supportsTablet).toBe(true);
    // The top-level setting is the phone's: left alone it would turn on rotating for a Pro Max, which is wide enough to be mistaken for a tablet.
    expect(expo.orientation).toBe("portrait");
    expect(expo.ios.infoPlist["UISupportedInterfaceOrientations~ipad"]).toEqual(expect.arrayContaining(["UIInterfaceOrientationPortrait", "UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight"]));
    // Split View and Slide Over need this off.
    expect((expo.ios as { requireFullScreen?: boolean }).requireFullScreen).not.toBe(true);
  });

  it("asks Android for the camera and for Wi-Fi multicast (Bonjour)", () => {
    expect(expo.android.permissions).toEqual(expect.arrayContaining(["CAMERA", "ACCESS_WIFI_STATE", "CHANGE_WIFI_MULTICAST_STATE"]));
  });

  it("says in words why dictation wants the microphone and speech recognition (iOS ends the app without them)", () => {
    const plugins: unknown[] = expo.plugins;
    const speech = plugins.find((p) => Array.isArray(p) && p[0] === "expo-speech-recognition") as [string, { microphonePermission?: string; speechRecognitionPermission?: string }] | undefined;
    expect(speech?.[1].microphonePermission?.length).toBeGreaterThan(10);
    expect(speech?.[1].speechRecognitionPermission?.length).toBeGreaterThan(10);
  });

  it("says in words why attaching photos wants the camera and the library, and keeps the pairing reason in the camera's", () => {
    const plugins: unknown[] = expo.plugins;
    type Words = { cameraPermission?: string; photosPermission?: string; microphonePermission?: string };
    const picker = plugins.find((p) => Array.isArray(p) && p[0] === "expo-image-picker") as [string, Words] | undefined;
    expect(picker?.[1].cameraPermission).toMatch(/pairing code/);
    expect(picker?.[1].cameraPermission).toMatch(/photos/);
    expect(picker?.[1].photosPermission?.length).toBeGreaterThan(10);
    // The picker's plugin writes the microphone's words too: they must be dictation's, not its own default or nothing.
    const speech = plugins.find((p) => Array.isArray(p) && p[0] === "expo-speech-recognition") as [string, Words];
    expect(picker?.[1].microphonePermission).toBe(speech[1].microphonePermission);
    expect(expo.ios.infoPlist.NSCameraUsageDescription).toBe(picker?.[1].cameraPermission);
  });

  it("turns on the widget extension's push (the Mac updates the lock-screen card with pushes to Apple), and gives it no widgets of its own", () => {
    const plugins: unknown[] = expo.plugins;
    const widgets = plugins.find((p) => Array.isArray(p) && p[0] === "expo-widgets") as [string, { enablePushNotifications?: boolean; widgets?: unknown[] }] | undefined;
    expect(widgets?.[1].enablePushNotifications).toBe(true);
    // A Live Activity isn't declared as a widget: the package says an entry for it makes an invalid target.
    expect(widgets?.[1].widgets).toBeUndefined();
  });

  it("opens lantern:// links, which is how a pairing link reaches the app", () => {
    expect(expo.scheme).toBe("lantern");
  });
});
