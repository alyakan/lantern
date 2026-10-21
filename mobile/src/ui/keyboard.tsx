import { useEffect, useState, type ReactNode } from "react";
import { Keyboard, KeyboardAvoidingView, Platform, type StyleProp, type ViewStyle } from "react-native";

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

/**
 * Lifts what is inside above the keyboard: on iOS by shrinking itself by the keyboard's height (so a list above a message
 * box gets shorter, and the box stays in view). Android resizes the window by itself, so there it is just a view.
 */
export function AboveKeyboard({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={[{ flex: 1 }, style]}>
      {children}
    </KeyboardAvoidingView>
  );
}
