import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, Keyboard, Platform, StyleSheet, useWindowDimensions, View, type StyleProp, type ViewStyle } from "react-native";
import { skips } from "./motion";

/** Whether the on-screen keyboard is up (iOS says so as it starts to move, Android once it is there). */
export function useKeyboardUp() {
  const [up, setUp] = useState(false);
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const show = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", () => setUp(true));
    const hide = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () => setUp(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return up;
}

/** The curve iOS moves its keyboard along (close to it), so what rides above it keeps pace instead of arriving after. */
const KEYBOARD_EASING = Easing.bezier(0.17, 0.59, 0.4, 0.77);

/**
 * How much of the screen's bottom the keyboard covers, moving as the keyboard moves (over its own time) on iOS. Android
 * resizes the window by itself, so there it stays 0.
 */
export function useKeyboardLift() {
  const { height } = useWindowDimensions();
  const lift = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    // One event for the keyboard coming, going and changing size: how much of the screen it covers is where it ends.
    const sub = Keyboard.addListener("keyboardWillChangeFrame", (e) => {
      const to = Math.max(0, height - e.endCoordinates.screenY);
      if (skips()) lift.setValue(to);
      else Animated.timing(lift, { toValue: to, duration: e.duration || 250, easing: KEYBOARD_EASING, useNativeDriver: false }).start();
    });
    return () => sub.remove();
  }, [height, lift]);
  return lift;
}

/**
 * Lifts what is inside above the keyboard: it shrinks by the keyboard's height as the keyboard moves, so a list above a
 * message box gets shorter and the box stays right on top of the keyboard. The room under what is inside, where the
 * keyboard's rounded corners are, is painted in `style`'s background (else there would be a gap to see through).
 */
export function AboveKeyboard({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const lift = useKeyboardLift();
  const { backgroundColor } = StyleSheet.flatten(style) ?? {};
  return (
    <Animated.View style={{ flex: 1, backgroundColor, paddingBottom: lift }}>
      <View style={[{ flex: 1 }, style]}>{children}</View>
    </Animated.View>
  );
}
