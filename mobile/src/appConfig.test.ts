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

  it("asks Android for the camera and for Wi-Fi multicast (Bonjour)", () => {
    expect(expo.android.permissions).toEqual(expect.arrayContaining(["CAMERA", "ACCESS_WIFI_STATE", "CHANGE_WIFI_MULTICAST_STATE"]));
  });

  it("opens lantern:// links, which is how a pairing link reaches the app", () => {
    expect(expo.scheme).toBe("lantern");
  });
});
