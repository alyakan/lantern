import { useRef, useState } from "react";
import { Animated, PanResponder, View, type AccessibilityActionEvent } from "react-native";
import * as Haptics from "expo-haptics";
import { allows } from "../view/swipe";
import { colors } from "./theme";
import { Txt } from "./components";

const KNOB = 52;
const INSET = 5;

/**
 * "Swipe to allow": a knob dragged to the end. Only a drag that is let go near the end allows; a tap does nothing. A
 * screen reader gets an "Allow" action instead (a deliberate double tap), since it can't drag.
 */
export function SwipeToAllow({ onAllow, label = "Swipe to allow" }: { onAllow: () => void; label?: string }) {
  const [width, setWidth] = useState(0);
  const x = useRef(new Animated.Value(0)).current;
  const done = useRef(false);
  const max = Math.max(0, width - KNOB - INSET * 2);
  const maxRef = useRef(max);
  maxRef.current = max;

  const allow = () => {
    if (done.current) return;
    done.current = true;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    onAllow();
  };

  const pan = useRef(
    PanResponder.create({
      // Only a drag starts it: a touch that doesn't move is never an allow.
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (_, g) => x.setValue(Math.min(maxRef.current, Math.max(0, g.dx))),
      onPanResponderRelease: (_, g) => {
        if (allows(g.dx, maxRef.current)) {
          Animated.timing(x, { toValue: maxRef.current, duration: 80, useNativeDriver: false }).start();
          allow();
        } else {
          Animated.spring(x, { toValue: 0, useNativeDriver: false }).start();
        }
      },
      onPanResponderTerminate: () => Animated.spring(x, { toValue: 0, useNativeDriver: false }).start(),
    }),
  ).current;

  return (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Double tap to allow"
      accessibilityActions={[{ name: "activate", label: "Allow" }]}
      onAccessibilityAction={(e: AccessibilityActionEvent) => e.nativeEvent.actionName === "activate" && allow()}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{ height: KNOB + INSET * 2, borderRadius: 999, backgroundColor: colors.nightRaised, justifyContent: "center", alignItems: "center" }}
    >
      <Txt variant="body" tone="night" style={{ fontWeight: "600" }}>
        {label}
      </Txt>
      <Animated.View
        testID="swipe-knob"
        {...pan.panHandlers}
        style={{ position: "absolute", left: INSET, top: INSET, width: KNOB, height: KNOB, borderRadius: KNOB / 2, backgroundColor: colors.go, alignItems: "center", justifyContent: "center", transform: [{ translateX: x }] }}
      >
        <View accessibilityElementsHidden style={{ width: 14, height: 14, marginLeft: -4, borderTopWidth: 3, borderRightWidth: 3, borderColor: "#fff", borderRadius: 2, transform: [{ rotate: "45deg" }] }} />
      </Animated.View>
    </View>
  );
}
