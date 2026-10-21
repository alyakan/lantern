// What the screens' tests need from the native side, as nothing: the tests run on Node.
jest.mock("react-native-safe-area-context", () => require("react-native-safe-area-context/jest/mock").default);
jest.mock("react-native-keyboard-controller", () => require("react-native-keyboard-controller/jest"));
jest.mock("expo-local-authentication", () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 },
  getEnrolledLevelAsync: jest.fn(async () => 0),
  supportedAuthenticationTypesAsync: jest.fn(async () => []),
  authenticateAsync: jest.fn(async () => ({ success: false, error: "not_available" })),
}));
jest.mock("expo-clipboard", () => ({ getStringAsync: jest.fn(async () => ""), setStringAsync: jest.fn(async () => true) }));
jest.mock("expo-haptics", () => ({
  notificationAsync: jest.fn(async () => {}),
  impactAsync: jest.fn(async () => {}),
  selectionAsync: jest.fn(async () => {}),
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
  ImpactFeedbackStyle: { Light: "light", Medium: "medium" },
}));

// An animation that never ends (the working bar) would keep a render from ever settling.
try {
  const { Animated } = require("react-native");
  jest.spyOn(Animated, "loop").mockImplementation(() => ({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() }));
} catch {
  // The integration tests run on plain Node, with no React Native.
}
