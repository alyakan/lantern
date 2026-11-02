/**
 * The notification service extension: it opens the encrypted text a push from the Mac carries and puts it on the notification
 * (see PushText.swift and docs/MOBILE.md).
 *
 * The keychain group is the one the app writes the key to (app.json's ios.entitlements lists it too). It is given here as an
 * object, not a hand-written .entitlements file: the plugin reads such a file into an object the Expo config can't serialize,
 * and `expo prebuild` stops with "val.hasOwnProperty is not a function".
 *
 * @type {import('@bacons/apple-targets/app.plugin').Config}
 */
module.exports = {
  type: "notification-service",
  name: "NotificationService",
  displayName: "Lantern notifications",
  // Appended to the app's bundle id: com.alyakan.lantern.NotificationService. The App Store profile for it is made by the Fastfile.
  bundleIdentifier: ".NotificationService",
  // The app's own deployment target (Expo's), not the plugin's newer default.
  deploymentTarget: "16.4",
  // A team id is printed on every app in the store: it is not a secret.
  appleTeamId: "2NT5QR24SX",
  entitlements: {
    // (The plugin's type for entitlements doesn't list this key; it writes whatever it is given.)
    "keychain-access-groups": ["$(AppIdentifierPrefix)com.alyakan.lantern.push"],
  },
};
