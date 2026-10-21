import { useRef, useState } from "react";
import { Animated, PanResponder, View, type AccessibilityActionEvent } from "react-native";
import * as Haptics from "expo-haptics";
import { allows } from "../view/swipe";
import { colors } from "./theme";
import { Txt } from "./components";
import { buzz, FadeSlideIn, PopIn, skips } from "./motion";

const KNOB = 52;
const INSET = 5;

/**
 * "Swipe to allow": a knob dragged to the end, the bar filling green behind it. Only a drag that is let go near the end
 * allows; a tap does nothing. Once allowed the knob becomes a check and the bar says `doneLabel`. A screen reader gets an
 * "Allow" action instead (a deliberate double tap), since it can't drag.
 */
export function SwipeToAllow({ onAllow, label = "Swipe to allow", doneLabel = "Allowed", progress }: { onAllow: () => void; label?: string; doneLabel?: string; /** The knob's position, for a test to move it (a drag can't be made in one). */ progress?: Animated.Value }) {
  const [width, setWidth] = useState(0);
  const [completed, setCompleted] = useState(false);
  const own = useRef(new Animated.Value(0)).current;
  const x = progress ?? own;
  const bump = useRef(new Animated.Value(1)).current;
  const done = useRef(false);
  const max = Math.max(0, width - KNOB - INSET * 2);
  const maxRef = useRef(max);
  maxRef.current = max;

  const allow = () => {
    if (done.current) return;
    done.current = true;
    setCompleted(true);
    // The knob runs the rest of the way, the bar gives a little jump, and the phone says yes.
    if (skips()) x.setValue(maxRef.current);
    else {
      Animated.timing(x, { toValue: maxRef.current, duration: 120, useNativeDriver: false }).start();
      Animated.sequence([Animated.timing(bump, { toValue: 1.045, duration: 120, useNativeDriver: true }), Animated.spring(bump, { toValue: 1, useNativeDriver: true, bounciness: 16, speed: 14 })]).start();
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    onAllow();
  };

  const pan = useRef(
    PanResponder.create({
      // Only a drag starts it: a touch that doesn't move is never an allow.
      onMoveShouldSetPanResponder: (_, g) => !done.current && Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderGrant: () => buzz("select"),
      onPanResponderMove: (_, g) => x.setValue(Math.min(maxRef.current, Math.max(0, g.dx))),
      onPanResponderRelease: (_, g) => {
        if (allows(g.dx, maxRef.current)) allow();
        else Animated.spring(x, { toValue: 0, useNativeDriver: false }).start();
      },
      onPanResponderTerminate: () => !done.current && Animated.spring(x, { toValue: 0, useNativeDriver: false }).start(),
    }),
  ).current;

  return (
    <Animated.View style={{ transform: [{ scale: bump }] }}>
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={completed ? doneLabel : label}
        accessibilityHint={completed ? undefined : "Double tap to allow"}
        accessibilityState={{ disabled: completed }}
        accessibilityActions={completed ? [] : [{ name: "activate", label: "Allow" }]}
        onAccessibilityAction={(e: AccessibilityActionEvent) => e.nativeEvent.actionName === "activate" && allow()}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={{ height: KNOB + INSET * 2, borderRadius: 999, backgroundColor: colors.nightRaised, justifyContent: "center", alignItems: "center", overflow: "hidden" }}
      >
        {/* The bar fills green behind the knob as it is dragged, all of it by the end. */}
        <Animated.View
          testID="swipe-fill"
          pointerEvents="none"
          style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: x.interpolate({ inputRange: [0, Math.max(1, max)], outputRange: [KNOB + INSET * 2, Math.max(KNOB + INSET * 2, width)] }), borderRadius: 999, backgroundColor: colors.go, opacity: x.interpolate({ inputRange: [0, 8], outputRange: [0, 1], extrapolate: "clamp" }) }}
        />
        <Animated.View style={{ opacity: x.interpolate({ inputRange: [0, Math.max(1, max * 0.55)], outputRange: [1, 0], extrapolate: "clamp" }) }}>
          <Txt variant="body" tone="night" style={{ fontWeight: "600" }}>
            {label}
          </Txt>
        </Animated.View>
        {completed && (
          <FadeSlideIn from={6} ms={200} delay={120} style={{ position: "absolute" }}>
            <Txt variant="body" tone="white" style={{ fontWeight: "700" }}>
              {doneLabel}
            </Txt>
          </FadeSlideIn>
        )}
        <Animated.View
          testID="swipe-knob"
          {...pan.panHandlers}
          style={{ position: "absolute", left: INSET, top: INSET, width: KNOB, height: KNOB, borderRadius: KNOB / 2, backgroundColor: x.interpolate({ inputRange: [0, 14], outputRange: [colors.go, "#ffffff"], extrapolate: "clamp" }), alignItems: "center", justifyContent: "center", transform: [{ translateX: x }] }}
        >
          {completed ? (
            <PopIn>
              <View accessibilityElementsHidden style={{ width: 20, height: 11, marginTop: -4, borderLeftWidth: 4, borderBottomWidth: 4, borderColor: colors.go, borderRadius: 2, transform: [{ rotate: "-45deg" }] }} />
            </PopIn>
          ) : (
            <Animated.View accessibilityElementsHidden style={{ width: 14, height: 14, marginLeft: -4, borderTopWidth: 3, borderRightWidth: 3, borderColor: x.interpolate({ inputRange: [0, 14], outputRange: ["#ffffff", colors.go], extrapolate: "clamp" }), borderRadius: 2, transform: [{ rotate: "45deg" }] }} />
          )}
        </Animated.View>
      </View>
    </Animated.View>
  );
}
