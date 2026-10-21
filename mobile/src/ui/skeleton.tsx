import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Easing, View, type DimensionValue, type StyleProp, type ViewStyle } from "react-native";
import { skips } from "./motion";
import { colors, radius, space } from "./theme";

/**
 * What is shown where something is still coming: the shape of it in grey, breathing, instead of a spinner and a line of
 * words. A group breathes together (`Pulse`), its blocks are `Bar`s. Hidden from a screen reader, which is told by `label`.
 */
export function Pulse({ children, label, delay = 0, style }: { children: ReactNode; label?: string; delay?: number; style?: StyleProp<ViewStyle> }) {
  const p = useRef(new Animated.Value(skips() ? 0.75 : 0.45)).current;
  useEffect(() => {
    if (skips()) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(p, { toValue: 1, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(p, { toValue: 0.45, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [p, delay]);
  return (
    <Animated.View accessible={!!label} accessibilityLabel={label} accessibilityRole={label ? "progressbar" : undefined} importantForAccessibility={label ? "yes" : "no-hide-descendants"} style={[{ opacity: p }, style]}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {children}
      </View>
    </Animated.View>
  );
}

/** One grey block of the shape being waited for. */
export function Bar({ w = "100%", h = 12, r, dark, style }: { w?: DimensionValue; h?: number; r?: number; dark?: boolean; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ width: w, height: h, borderRadius: r ?? h / 2, backgroundColor: dark ? colors.ink3 : colors.rule, opacity: dark ? 0.35 : 1 }, style]} />;
}

/** Three dots that rise and fall in turn: "it is working on it", where there is nothing to draw the shape of. */
export function Dots({ color = colors.ink3, size = 6 }: { color?: string; size?: number }) {
  const values = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;
  useEffect(() => {
    if (skips()) return;
    const loops = values.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 140),
          Animated.timing(v, { toValue: 1, duration: 320, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(v, { toValue: 0, duration: 320, easing: Easing.in(Easing.quad), useNativeDriver: true }),
          Animated.delay((2 - i) * 140 + 200),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [values]);
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: "row", alignItems: "center", gap: size * 0.7, height: size * 2.2 }}>
      {values.map((v, i) => (
        <Animated.View key={i} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }), transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -size * 0.6] }) }] }} />
      ))}
    </View>
  );
}

/** A chat before its history has come: a message, Claude's reply, some chips, another exchange. */
export function ChatSkeleton({ label = "Loading this chat" }: { label?: string }) {
  return (
    <Pulse label={label} style={{ paddingHorizontal: space.lg, paddingTop: 16 }}>
      <View style={{ gap: 18 }}>
        <Bar w="52%" h={40} r={18} dark style={{ borderBottomLeftRadius: 6 }} />
        <View style={{ gap: 8 }}>
          <Bar w="94%" />
          <Bar w="88%" />
          <Bar w="62%" />
        </View>
        <View style={{ flexDirection: "row", gap: 6 }}>
          <Bar w={74} h={26} r={13} />
          <Bar w={96} h={26} r={13} />
          <Bar w={64} h={26} r={13} />
        </View>
        <Bar w="38%" h={40} r={18} dark style={{ borderBottomLeftRadius: 6 }} />
        <View style={{ gap: 8 }}>
          <Bar w="90%" />
          <Bar w="70%" />
        </View>
      </View>
    </Pulse>
  );
}

/** The projects of the new-chat sheet, before the Mac has said which they are. */
export function ProjectsSkeleton({ label = "Looking at your projects" }: { label?: string }) {
  return (
    <Pulse label={label}>
      <Bar w={56} h={12} style={{ marginBottom: 10 }} />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Bar w={78} h={38} r={radius.pill} />
        <Bar w={104} h={38} r={radius.pill} />
        <Bar w={68} h={38} r={radius.pill} />
        <Bar w={90} h={38} r={radius.pill} />
      </View>
    </Pulse>
  );
}

/** A file's diff before it has come: lines of code of different lengths. */
export function DiffSkeleton({ label = "Loading the changes" }: { label?: string }) {
  return (
    <Pulse label={label} style={{ paddingVertical: 8 }}>
      <View style={{ gap: 9 }}>
        {[48, 82, 70, 36, 90, 58, 76, 44].map((w, i) => (
          <Bar key={i} w={`${w}%`} h={11} />
        ))}
      </View>
    </Pulse>
  );
}

/** Home before the Mac has sent its chats and what waits: the headline, a card, and chat rows. */
export function HomeSkeleton({ label = "Loading your chats" }: { label?: string }) {
  return (
    <Pulse label={label}>
      <View style={{ paddingHorizontal: space.xl, paddingTop: 14, paddingBottom: 18, gap: 12 }}>
        <Bar w="58%" h={34} r={10} dark />
        <Bar w="82%" h={34} r={10} />
      </View>
      <View style={{ marginHorizontal: space.lg, backgroundColor: colors.card, borderRadius: radius.card, padding: 18, gap: 12 }}>
        <Bar w={92} h={22} r={11} />
        <Bar w="70%" h={18} />
        <Bar w="100%" h={44} r={radius.inner} />
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Bar w="48%" h={44} r={22} />
          <Bar w="48%" h={44} r={22} />
        </View>
      </View>
      <View style={{ paddingHorizontal: space.xl, paddingTop: 26, gap: 18 }}>
        <Bar w={84} h={14} />
        {[0, 1, 2].map((i) => (
          <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Bar w={44} h={44} r={13} />
            <View style={{ flex: 1, gap: 8 }}>
              <Bar w={`${68 - i * 10}%`} h={14} />
              <Bar w="34%" h={11} />
            </View>
          </View>
        ))}
      </View>
    </Pulse>
  );
}
