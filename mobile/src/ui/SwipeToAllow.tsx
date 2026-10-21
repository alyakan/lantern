import { useRef, useState } from "react";
import { Animated, Easing, PanResponder, Pressable, StyleSheet, View, type AccessibilityActionEvent } from "react-native";
import * as Haptics from "expo-haptics";
import { allows } from "../view/swipe";
import { colors } from "./theme";
import { Txt } from "./components";
import { buzz, FadeSlideIn, PopIn, skips } from "./motion";

/** The knob, and the space around it; the bar's height is both, and it is what the bar shrinks to across: a circle. */
const sizes = (compact: boolean) => {
  const KNOB = compact ? 38 : 52;
  const INSET = compact ? 4 : 5;
  return { KNOB, INSET, BAR: KNOB + INSET * 2 };
};

/**
 * "Swipe to allow": a knob dragged to the end, the bar filling green behind it. Only a drag that is let go near the end
 * allows; a tap does nothing. Once allowed the knob becomes a check, and the bar shrinks into a circle at the right edge
 * holding it; with `onDone` that circle is a button (the one that takes you back). A screen reader gets an "Allow"
 * action instead of the drag (a deliberate double tap).
 */
export function SwipeToAllow({ onAllow, onDone, label = "Swipe to allow", doneLabel = "Allowed", compact = false, progress }: { onAllow: () => void; /** Once allowed, the circle can be pressed: this is what it does. */ onDone?: () => void; label?: string; doneLabel?: string; /** A smaller bar, for sitting inside a card. */ compact?: boolean; /** The knob's position, for a test to move it (a drag can't be made in one). */ progress?: Animated.Value }) {
  const { KNOB, INSET, BAR } = sizes(compact);
  const [width, setWidth] = useState(0);
  const [completed, setCompleted] = useState(false);
  const own = useRef(new Animated.Value(0)).current;
  const x = progress ?? own;
  const bump = useRef(new Animated.Value(1)).current;
  // 0 is the full bar, 1 the circle.
  const shrink = useRef(new Animated.Value(0)).current;
  const done = useRef(false);
  const max = Math.max(0, width - KNOB - INSET * 2);
  const maxRef = useRef(max);
  maxRef.current = max;

  const allow = () => {
    if (done.current) return;
    done.current = true;
    setCompleted(true);
    // The knob runs the rest of the way, the bar gives a little jump, and the phone says yes; then the bar closes in on the knob.
    if (skips()) {
      x.setValue(maxRef.current);
      shrink.setValue(1);
    } else {
      Animated.timing(x, { toValue: maxRef.current, duration: 120, useNativeDriver: false }).start();
      Animated.sequence([Animated.timing(bump, { toValue: 1.045, duration: 120, useNativeDriver: true }), Animated.spring(bump, { toValue: 1, useNativeDriver: true, bounciness: 16, speed: 14 })]).start();
      Animated.timing(shrink, { toValue: 1, duration: 380, delay: 260, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    onAllow();
  };

  const pan = useRef(
    PanResponder.create({
      // Only a drag starts it: a touch that doesn't move is never an allow.
      onMoveShouldSetPanResponder: (_, g) => !done.current && Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderGrant: () => buzz("select"),
      // Once it has the drag, a list it sits in (a chat) doesn't take it away.
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_, g) => x.setValue(Math.min(maxRef.current, Math.max(0, g.dx))),
      onPanResponderRelease: (_, g) => {
        if (allows(g.dx, maxRef.current)) allow();
        else Animated.spring(x, { toValue: 0, useNativeDriver: false }).start();
      },
      onPanResponderTerminate: () => !done.current && Animated.spring(x, { toValue: 0, useNativeDriver: false }).start(),
    }),
  ).current;

  const button = completed && !!onDone;
  const press = (to: number) => Animated.spring(bump, { toValue: to, useNativeDriver: true, speed: 60, bounciness: to === 1 ? 14 : 0 }).start();

  return (
    <Animated.View style={{ transform: [{ scale: bump }] }}>
      {/* Its own width is the whole bar's, always: the bar inside is what shrinks. */}
      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        <Animated.View
          accessible={!button}
          accessibilityRole={button ? undefined : "button"}
          accessibilityLabel={button ? undefined : completed ? doneLabel : label}
          accessibilityHint={completed ? undefined : "Double tap to allow"}
          accessibilityState={button ? undefined : { disabled: completed }}
          accessibilityActions={completed ? [] : [{ name: "activate", label: "Allow" }]}
          onAccessibilityAction={(e: AccessibilityActionEvent) => e.nativeEvent.actionName === "activate" && allow()}
          style={{ alignSelf: "flex-end", height: BAR, width: completed ? shrink.interpolate({ inputRange: [0, 1], outputRange: [Math.max(BAR, width), BAR] }) : "100%", borderRadius: 999, backgroundColor: compact ? colors.ink : colors.nightRaised, overflow: "hidden" }}
        >
          {/* Everything is held to the right edge, so the bar closes in on the knob and the rest is clipped. */}
          <View style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: width || "100%", justifyContent: "center", alignItems: "center" }}>
            {/* The bar fills green behind the knob as it is dragged, all of it by the end. */}
            <Animated.View
              testID="swipe-fill"
              pointerEvents="none"
              style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: x.interpolate({ inputRange: [0, Math.max(1, max)], outputRange: [BAR, Math.max(BAR, width)] }), borderRadius: 999, backgroundColor: colors.go, opacity: x.interpolate({ inputRange: [0, 8], outputRange: [0, 1], extrapolate: "clamp" }) }}
            />
            <Animated.View style={{ opacity: x.interpolate({ inputRange: [0, Math.max(1, max * 0.55)], outputRange: [1, 0], extrapolate: "clamp" }) }}>
              <Txt variant="body" tone="night" style={{ fontWeight: "600" }}>
                {label}
              </Txt>
            </Animated.View>
            {completed && (
              <FadeSlideIn from={6} ms={200} delay={120} style={{ position: "absolute" }}>
                <Animated.View style={{ opacity: shrink.interpolate({ inputRange: [0, 0.35], outputRange: [1, 0], extrapolate: "clamp" }) }}>
                  <Txt variant="body" tone="white" style={{ fontWeight: "700" }}>
                    {doneLabel}
                  </Txt>
                </Animated.View>
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
          {button && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={doneLabel}
              accessibilityHint="Double tap to go back to the chat"
              onPressIn={() => press(0.92)}
              onPressOut={() => press(1)}
              onPress={() => {
                buzz("light");
                onDone();
              }}
              style={StyleSheet.absoluteFill}
            />
          )}
        </Animated.View>
      </View>
    </Animated.View>
  );
}
