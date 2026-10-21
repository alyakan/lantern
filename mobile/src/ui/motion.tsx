import { useEffect, useRef, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Easing, type StyleProp, type ViewStyle } from "react-native";

/**
 * Whether to skip animations: always in tests (they run on Node, with no frames to draw), and for people who asked the
 * phone for less motion.
 */
export const motion = {
  instant: typeof process !== "undefined" && process.env.JEST_WORKER_ID !== undefined,
  reduced: false,
};

try {
  void AccessibilityInfo.isReduceMotionEnabled()
    .then((on) => {
      motion.reduced = on;
    })
    .catch(() => {});
} catch {
  // No accessibility module (a test): motion stays as it is.
}

export const skips = () => motion.instant || motion.reduced;

/** Moves `value` to `to`, easing out; `done` is called once it got there (at once when motion is skipped). */
export function run(value: Animated.Value, to: number, ms: number, done?: () => void) {
  if (skips()) {
    value.setValue(to);
    done?.();
    return;
  }
  Animated.timing(value, { toValue: to, duration: ms, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start(({ finished }) => {
    if (finished) done?.();
  });
}

/** Fades its content in, and up from `from` points below, when it appears. A new `key` is a new arrival. */
export function FadeSlideIn({ children, from = 10, ms = 240, style }: { children: ReactNode; from?: number; ms?: number; style?: StyleProp<ViewStyle> }) {
  const p = useRef(new Animated.Value(skips() ? 1 : 0)).current;
  useEffect(() => {
    run(p, 1, ms);
  }, [p, ms]);
  return <Animated.View style={[style, { opacity: p, transform: [{ translateY: p.interpolate({ inputRange: [0, 1], outputRange: [from, 0] }) }] }]}>{children}</Animated.View>;
}
