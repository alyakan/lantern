import { useEffect, useState, type ReactNode } from "react";
import { Keyboard, Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

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
 * Lifts what is inside above the keyboard: it shrinks by the keyboard's height, frame by frame as the keyboard moves
 * (the library follows the keyboard itself, on the native side, where JS can't keep pace), so a list above a message box
 * gets shorter and the box stays right on top of the keyboard. The room under what is inside, where the keyboard's rounded
 * corners are, is painted in `style`'s background (else there would be a gap to see through). `style` is on a view inside
 * the avoiding one, which owns the bottom padding. With `dismissOnTap`, a tap on the empty space inside closes the keyboard
 * (buttons and fields inside still get their taps; to a screen reader it is not a button).
 */
export function AboveKeyboard({ children, style, dismissOnTap = false }: { children: ReactNode; style?: StyleProp<ViewStyle>; dismissOnTap?: boolean }) {
  const { backgroundColor } = StyleSheet.flatten(style) ?? {};
  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor }}>
      {dismissOnTap ? (
        <Pressable testID="dismiss-keyboard" accessible={false} onPress={Keyboard.dismiss} style={[{ flex: 1 }, style]}>
          {children}
        </Pressable>
      ) : (
        <View style={[{ flex: 1 }, style]}>{children}</View>
      )}
    </KeyboardAvoidingView>
  );
}
