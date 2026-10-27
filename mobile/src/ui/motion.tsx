import { useEffect, useRef, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Easing, Pressable, View, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import * as Haptics from "expo-haptics";

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

/** Moves `value` to `to`, easing out, after `delay`; `done` is called once it got there (at once when motion is skipped). */
export function run(value: Animated.Value, to: number, ms: number, done?: () => void, delay = 0) {
  if (skips()) {
    value.setValue(to);
    done?.();
    return;
  }
  Animated.timing(value, { toValue: to, duration: ms, delay, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start(({ finished }) => {
    if (finished) done?.();
  });
}

/** A spring to `to` (a little bounce on the way: for things that land). */
export function bounce(value: Animated.Value, to: number, o: { delay?: number; bounciness?: number; speed?: number } = {}) {
  if (skips()) {
    value.setValue(to);
    return;
  }
  Animated.sequence([Animated.delay(o.delay ?? 0), Animated.spring(value, { toValue: to, useNativeDriver: true, speed: o.speed ?? 14, bounciness: o.bounciness ?? 12 })]).start();
}

/**
 * A spring for what layout draws (a width, a margin, a scale that follows them): the native driver can't move those, so this one
 * runs in JavaScript. It overshoots a little, so a thing that grows swells past its size and settles.
 */
export function springLayout(value: Animated.Value, to: number, o: { bounciness?: number; speed?: number } = {}) {
  if (skips()) {
    value.setValue(to);
    return;
  }
  Animated.spring(value, { toValue: to, useNativeDriver: false, speed: o.speed ?? 12, bounciness: o.bounciness ?? 10 }).start();
}

/** A small tap on the phone: "light" for a press, "select" for a choice, "success" and "warning" for what a decision came to. */
export function buzz(kind: "light" | "select" | "success" | "warning" = "light") {
  if (motion.instant) return;
  const p =
    kind === "select"
      ? Haptics.selectionAsync()
      : kind === "success"
        ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
        : kind === "warning"
          ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
          : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  void p.catch(() => {});
}

/**
 * Opacity that rises from nothing over Liquid Glass leaves the glass clear: not only glass there as it fades in, but glass that
 * comes inside it later (a chat opened a minute after the app faded in had a clear header and message box). Seen on the
 * simulator with the fade run natively and in JavaScript alike; glass that was already drawn and then faded out and back was
 * fine, and so was glass that only moved in. So what holds glass moves in and doesn't fade (`glass`).
 */
const opacityOf = (p: Animated.Value, glass: boolean) => (glass ? 1 : p);

/**
 * Fades its content in, and up from `from` points below, when it appears (after `delay`). A new `key` is a new arrival.
 * `animate={false}` is for things that were there from the start: they just are. `glass`: it holds Liquid Glass, so it only
 * moves up, without the fade (see `opacityOf`).
 */
export function FadeSlideIn({ children, from = 10, ms = 240, delay = 0, animate = true, glass = false, style }: { children: ReactNode; from?: number; ms?: number; delay?: number; animate?: boolean; glass?: boolean; style?: StyleProp<ViewStyle> }) {
  const p = useRef(new Animated.Value(skips() || !animate ? 1 : 0)).current;
  useEffect(() => {
    if (animate) run(p, 1, ms, undefined, delay);
    // Only when it appears: a list's recycled cell holding another item must not play it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <Animated.View style={[style, { opacity: opacityOf(p, glass), transform: [{ translateY: p.interpolate({ inputRange: [0, 1], outputRange: [from, 0] }) }] }]}>{children}</Animated.View>;
}

/** Pops its content in from small, with a little overshoot (a check mark, a badge). `glass`: it only grows, without the fade. */
export function PopIn({ children, delay = 0, glass = false, style }: { children: ReactNode; delay?: number; glass?: boolean; style?: StyleProp<ViewStyle> }) {
  const p = useRef(new Animated.Value(skips() ? 1 : 0)).current;
  useEffect(() => {
    bounce(p, 1, { delay, bounciness: 16 });
  }, [p, delay]);
  return <Animated.View style={[style, { opacity: glass ? 1 : p.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 1, 1] }), transform: [{ scale: p.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) }] }]}>{children}</Animated.View>;
}

const APressable = Animated.createAnimatedComponent(Pressable);

/**
 * A pressable that gives under the finger: it shrinks a little while pressed and springs back, with a tap on the phone.
 * `opacity` is the resting opacity (a disabled one is dimmer); it dims a touch more while pressed.
 */
export function PressScale({ children, style, scaleTo = 0.96, haptic = "light", opacity = 1, disabled, onPressIn, onPressOut, ...rest }: Omit<PressableProps, "style" | "children"> & { children: ReactNode; style?: StyleProp<ViewStyle>; scaleTo?: number; haptic?: "light" | "select" | "none"; opacity?: number }) {
  const s = useRef(new Animated.Value(1)).current;
  const to = (v: number) => {
    if (skips()) return s.setValue(v);
    Animated.spring(s, { toValue: v, useNativeDriver: true, speed: 60, bounciness: v === 1 ? 14 : 0 }).start();
  };
  return (
    <APressable
      {...rest}
      disabled={disabled}
      onPressIn={(e) => {
        to(scaleTo);
        if (haptic !== "none") buzz(haptic);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        to(1);
        onPressOut?.(e);
      }}
      style={[style, { opacity: s.interpolate({ inputRange: [scaleTo, 1], outputRange: [opacity * 0.86, opacity], extrapolate: "clamp" }), transform: [{ scale: s }] }]}
    >
      {children}
    </APressable>
  );
}

/** A dot with a ring that swells out of it and fades, over and over: something alive, or something that wants you. */
export function PulseDot({ color, size = 8, ms = 1800 }: { color: string; size?: number; ms?: number }) {
  const p = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (skips()) return;
    const loop = Animated.loop(Animated.timing(p, { toValue: 1, duration: ms, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [p, ms]);
  return (
    <View style={{ width: size, height: size }}>
      <Animated.View style={{ position: "absolute", top: 0, left: 0, width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: p.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }), transform: [{ scale: p.interpolate({ inputRange: [0, 1], outputRange: [1, 2.9] }) }] }} />
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
    </View>
  );
}
