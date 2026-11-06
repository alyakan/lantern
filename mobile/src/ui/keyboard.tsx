import { useEffect, useRef, useState, type ReactNode } from "react";
import { Keyboard, Platform, Pressable, StyleSheet, View, type GestureResponderEvent, type StyleProp, type ViewStyle } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

/** The room under the chat bar with the keyboard down (above the home indicator), and the gap between the bar and the keyboard when it is up. */
export const barRoom = (bottomInset: number) => Math.max(bottomInset, 12);
export const KEYBOARD_GAP = 8;

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

/** How far a finger may move, and for how long it may stay down, and still be a tap. */
const TAP_SLOP = 10;
const TAP_MS = 350;

/**
 * A tap anywhere in what these are put on closes the keyboard, as iOS's Messages does: on a message too, not only in the space
 * between them. What the tap lands on still gets it (a button, a link: the list's taps aren't held for the keyboard). A drag (a
 * scroll) or a hold (a message's actions) leaves the keyboard up. They only listen: nothing here takes the touch.
 */
export function useTapAway() {
  const start = useRef<{ x: number; y: number; at: number } | null>(null);
  return {
    onTouchStart: (e: GestureResponderEvent) => {
      const n = e.nativeEvent;
      start.current = n.touches.length > 1 ? null : { x: n.pageX, y: n.pageY, at: n.timestamp };
    },
    onTouchEnd: (e: GestureResponderEvent) => {
      const s = start.current;
      start.current = null;
      const n = e.nativeEvent;
      if (s && Math.abs(n.pageX - s.x) < TAP_SLOP && Math.abs(n.pageY - s.y) < TAP_SLOP && n.timestamp - s.at < TAP_MS && Keyboard.isVisible()) Keyboard.dismiss();
    },
    onTouchCancel: () => {
      start.current = null;
    },
  };
}

/**
 * Lifts what is inside above the keyboard: it shrinks by the keyboard's height, frame by frame as the keyboard moves
 * (the library follows the keyboard itself, on the native side, where JS can't keep pace), so a list above a message box
 * gets shorter and the box stays right on top of the keyboard. The room under what is inside, where the keyboard's rounded
 * corners are, is painted in `style`'s background (else there would be a gap to see through). `style` is on a view inside
 * the avoiding one, which owns the bottom padding. With `dismissOnTap`, a tap on the empty space inside closes the keyboard
 * (buttons and fields inside still get their taps; to a screen reader it is not a button).
 */
export function AboveKeyboard({ children, style, dismissOnTap = false, offset = 0 }: { children: ReactNode; style?: StyleProp<ViewStyle>; dismissOnTap?: boolean; /** Added to where the keyboard's top is taken to be, so a negative one lifts by that much less: for a bar whose own bottom padding is more than the gap it should keep above the keyboard (the library moves it with the keyboard, frame by frame, so nothing else has to change when the keyboard comes). */ offset?: number }) {
  const { backgroundColor } = StyleSheet.flatten(style) ?? {};
  return (
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={offset} style={{ flex: 1, backgroundColor }}>
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
