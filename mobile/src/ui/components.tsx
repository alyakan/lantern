import type { ReactNode } from "react";
import { Text, View, type StyleProp, type TextProps, type ViewStyle } from "react-native";
import { PressScale } from "./motion";
import { colors, MIN_TARGET, radius, space, type as scale, type Variant } from "./theme";

/** Text in the type scale. Ink by default; `tone` picks another of the palette's. */
export function Txt({ variant = "body", tone = "ink", style, ...rest }: TextProps & { variant?: Variant; tone?: "ink" | "ink2" | "ink3" | "white" | "night" | "go" | "stop" | "cobalt" | "night-stop" }) {
  const color = { ink: colors.ink, ink2: colors.ink2, ink3: colors.ink3, white: colors.white, night: colors.nightText, go: colors.go, stop: colors.stop, cobalt: colors.cobalt, "night-stop": colors.nightStop }[tone];
  return <Text {...rest} style={[scale[variant], { color }, style]} />;
}

type ButtonKind = "ink" | "ghost" | "go" | "hi" | "night-stop" | "night-ghost";

/** A button at least as tall as a touch target; the label says what happens. */
export function Button({ label, onPress, kind = "ink", disabled, style, accessibilityHint }: { label: string; onPress: () => void; kind?: ButtonKind; disabled?: boolean; style?: StyleProp<ViewStyle>; accessibilityHint?: string }) {
  // "hi" is the highlighter: dark words on yellow (white ones can't be read on it).
  const bg = { ink: colors.ink, ghost: colors.paper, go: colors.go, hi: colors.hi, "night-stop": "transparent", "night-ghost": colors.nightRaised }[kind];
  const fg = kind === "ink" || kind === "go" ? "white" : kind === "night-stop" ? "night-stop" : kind === "night-ghost" ? "white" : "ink";
  return (
    <PressScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      opacity={disabled ? 0.4 : 1}
      style={[{ minHeight: MIN_TARGET, borderRadius: radius.inner, paddingHorizontal: space.lg, alignItems: "center", justifyContent: "center", backgroundColor: bg }, style]}
    >
      <Txt variant="body" tone={fg} style={{ fontWeight: "700" }}>
        {label}
      </Txt>
    </PressScale>
  );
}

/** The highlighter pill: what sort of thing is waiting. */
export function Tag({ children }: { children: string }) {
  return (
    <View style={{ alignSelf: "flex-start", backgroundColor: colors.hi, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 }}>
      <Txt variant="tiny" style={{ fontWeight: "700" }}>
        {children}
      </Txt>
    </View>
  );
}

/** One small fact, as the timeline folds a turn's steps into a row of them. */
export function Chip({ children, tone = "plain", onPress }: { children: ReactNode; tone?: "plain" | "ok" | "bad"; onPress?: () => void }) {
  const border = tone === "ok" ? "#1f9d5555" : tone === "bad" ? "#d93b3b55" : colors.rule;
  const content = (
    <View style={{ backgroundColor: colors.card, borderColor: border, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 }}>
      <Txt variant="small" tone={tone === "ok" ? "go" : tone === "bad" ? "stop" : "ink2"}>
        {children}
      </Txt>
    </View>
  );
  if (!onPress) return content;
  return (
    <PressScale accessibilityRole="button" onPress={onPress} hitSlop={8} haptic="select" scaleTo={0.93}>
      {content}
    </PressScale>
  );
}

/** A coloured tile with the chat's first letter. */
export function Tile({ letter, bg, fg }: { letter: string; bg: string; fg: string }) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: bg, alignItems: "center", justifyContent: "center" }}>
      <Txt variant="heading" style={{ color: fg }}>
        {letter}
      </Txt>
    </View>
  );
}
