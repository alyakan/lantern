import { useEffect, useRef, type ReactNode } from "react";
import { Animated, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { run } from "./motion";

/** How much of the screen's height a sheet may take. */
const MOST = 0.88;

/**
 * A bottom sheet over the whole screen. The dark behind it fades in where it is, over the full height (the status bar
 * too), and only the sheet rises: the system's own "slide" would carry the dark up with it. `children` is given `close`,
 * which slides it away first and then calls `onClose`.
 */
export function Sheet({ onClose, children }: { onClose: () => void; children: (close: () => void) => ReactNode }) {
  const { height } = useWindowDimensions();
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
        <KeyboardAvoidingView pointerEvents="box-none" behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, justifyContent: "flex-end" }}>
          {/* The most it may take is a number: a percentage of a parent with no height of its own cuts the sheet short. */}
          <Animated.View style={{ maxHeight: height * MOST, flexShrink: 1, transform: [{ translateY: p.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }) }] }}>{children(close)}</Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
