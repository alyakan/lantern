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
// No Liquid Glass on Node: the screens draw their solid look, and a test that wants glass turns it on.
jest.mock("expo-glass-effect", () => {
  const { View } = require("react-native");
  return { GlassView: View, GlassContainer: View, isLiquidGlassAvailable: jest.fn(() => false), isGlassEffectAPIAvailable: jest.fn(() => false) };
});
// No microphone on Node: there is no recognizer unless a test says so, and it can be made to "hear" with __emit.
jest.mock("expo-speech-recognition", () => {
  const { useEffect, useRef } = require("react");
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return {
    ExpoSpeechRecognitionModule: {
      isRecognitionAvailable: jest.fn(() => false),
      requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
      getSupportedLocales: jest.fn(async () => ({ locales: [], installedLocales: [] })),
      start: jest.fn(),
      stop: jest.fn(),
      abort: jest.fn(),
    },
    useSpeechRecognitionEvent: (name: string, fn: (e: unknown) => void) => {
      const latest = useRef(fn);
      latest.current = fn;
      useEffect(() => {
        const on = (e: unknown) => latest.current(e);
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(on);
        return () => void listeners.get(name)!.delete(on);
      }, [name]);
    },
    __emit: (name: string, e: unknown) => listeners.get(name)?.forEach((on) => on(e)),
  };
});
// No photo library or camera on Node: a test says what the picker gives back, and what shrinking a picture makes.
jest.mock("expo-image-picker", () => ({
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: true })),
  launchCameraAsync: jest.fn(async () => ({ canceled: true, assets: null })),
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true, assets: null })),
}));
jest.mock("expo-image-manipulator", () => ({
  SaveFormat: { JPEG: "jpeg", PNG: "png" },
  ImageManipulator: {
    manipulate: jest.fn(() => ({
      resize: jest.fn(),
      renderAsync: jest.fn(async () => ({ saveAsync: jest.fn(async () => ({ uri: "file:///small.jpg", width: 10, height: 10, base64: "/9j/4AAQ" })) })),
    })),
  },
}));
jest.mock("expo-clipboard", () => ({ getStringAsync: jest.fn(async () => ""), setStringAsync: jest.fn(async () => true) }));
jest.mock("expo-haptics", () => ({
  notificationAsync: jest.fn(async () => {}),
  impactAsync: jest.fn(async () => {}),
  selectionAsync: jest.fn(async () => {}),
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
  ImpactFeedbackStyle: { Light: "light", Medium: "medium" },
}));

// No voice on Node: speech finishes at once.
jest.mock("expo-speech", () => ({
  speak: jest.fn((_text: string, o?: { onDone?: () => void }) => o?.onDone?.()),
  stop: jest.fn(),
  isSpeakingAsync: jest.fn(async () => false),
}));

// An animation that never ends (the working bar) would keep a render from ever settling.
try {
  const { Animated } = require("react-native");
  jest.spyOn(Animated, "loop").mockImplementation(() => ({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() }));
} catch {
  // The integration tests run on plain Node, with no React Native.
}
