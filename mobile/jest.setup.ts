// What the screens' tests need from the native side, as nothing: the tests run on Node.
jest.mock("react-native-safe-area-context", () => require("react-native-safe-area-context/jest/mock").default);
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
