import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Modal, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { LockCover } from "../shell/LockCover";
import { useLockState } from "../shell/lockContext";
import { run } from "./motion";
import { colors } from "./theme";

/** How much of the screen's height a sheet may take. */
const MOST = 0.88;

/**
 * A bottom sheet over the whole screen. The dark behind it fades in where it is, over the full height (the status bar
 * too), and only the sheet rises: the system's own "slide" would carry the dark up with it. `children` is given `close`,
 * which slides it away first and then calls `onClose`. With the keyboard up the sheet rides on top of it, following it
 * frame by frame, and what shows under the sheet at the keyboard's rounded corners is the sheet's own colour, `fill`.
 */
export function Sheet({ onClose, fill = colors.card, children }: { onClose: () => void; fill?: string; children: (close: () => void) => ReactNode }) {
  const { height } = useWindowDimensions();
  // The app lock's cover is drawn in here too: a sheet is a Modal of its own, and where it is on top the lock's isn't.
  const lock = useLockState();
  const covered = lock.ready && (lock.locked || lock.covered);
  const p = useRef(new Animated.Value(0)).current;
  const closing = useRef(false);
  useEffect(() => {
    run(p, 1, 300);
  }, [p]);
  const close = () => {
    if (closing.current) return;
    closing.current = true;
    run(p, 0, 220, onClose);
  };
  return (
    <Modal animationType="none" transparent statusBarTranslucent onRequestClose={close}>
      <View style={{ flex: 1 }}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: "#00000066", opacity: p }]}>
          <Pressable accessibilityLabel="Close" onPress={close} style={StyleSheet.absoluteFill} />
        </Animated.View>
        {/* Taps above the sheet reach the dark behind it. */}
        <KeyboardAvoidingView behavior="padding" pointerEvents="box-none" style={{ flex: 1, justifyContent: "flex-end" }}>
          {/* The most it may take is a number: a percentage of a parent with no height of its own cuts the sheet short. */}
          <Animated.View style={{ maxHeight: height * MOST, flexShrink: 1, transform: [{ translateY: p.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }) }] }}>
            {children(close)}
            {/* Under the sheet, where the keyboard's rounded corners are: its colour, so there is no gap to see through. */}
            <View pointerEvents="none" style={{ position: "absolute", top: "100%", left: 0, right: 0, height: 600, backgroundColor: fill }} />
          </Animated.View>
        </KeyboardAvoidingView>
        {covered && (
          <View style={StyleSheet.absoluteFill}>
            <LockCover />
          </View>
        )}
      </View>
    </Modal>
  );
}
