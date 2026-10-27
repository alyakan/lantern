import type { ReactNode } from "react";
import { Text, View, type StyleProp, type TextProps, type ViewStyle } from "react-native";
import { EMBER, useAccent, useRegular } from "./accent";
import { Chevron } from "./Chevron";
import { PressScale } from "./motion";
import { projectTint } from "../view/home";
import { MIN_TARGET, radius, space, type as scale, useColors, type Variant } from "./theme";

/** Text in the type scale. Ink by default; `tone` picks another of the palette's. "white" is always white (on night, go and stop); "on-ink" is what is written on an ink fill. */
/** How far larger than normal the phone's text size may make Lantern's text (a person who needs more can still read it: 1.8 is large). */
export const MAX_TEXT_SCALE = 1.8;

export function Txt({ variant = "body", tone = "ink", style, ...rest }: TextProps & { variant?: Variant; tone?: "ink" | "ink2" | "ink3" | "white" | "on-ink" | "on-hi" | "night" | "go" | "stop" | "cobalt" | "night-stop" }) {
  // "cobalt" is the accent: another colour for someone who is a regular.
  const accent = useAccent();
  const colors = useColors();
  const color = { ink: colors.ink, ink2: colors.ink2, ink3: colors.ink3, white: colors.white, "on-ink": colors.onInk, "on-hi": colors.onHi, night: colors.nightText, go: colors.go, stop: colors.stop, cobalt: accent, "night-stop": colors.nightStop }[tone];
  // The phone's text size is followed (Dynamic Type), up to a limit past which fixed-size things (a swipe bar, a tile) would break.
  return <Text maxFontSizeMultiplier={MAX_TEXT_SCALE} {...rest} style={[scale[variant], { color }, style]} />;
}

type ButtonKind = "ink" | "ghost" | "go" | "hi" | "night-stop" | "night-ghost";

/** A button at least as tall as a touch target; the label says what happens. */
export function Button({ label, onPress, kind = "ink", disabled, style, accessibilityHint }: { label: string; onPress: () => void; kind?: ButtonKind; disabled?: boolean; style?: StyleProp<ViewStyle>; accessibilityHint?: string }) {
  // "hi" is the highlighter: dark words on yellow (white ones can't be read on it).
  // A regular's main buttons are Ember too.
  const regular = useRegular();
  const colors = useColors();
  const bg = { ink: regular ? EMBER : colors.ink, ghost: colors.paper, go: colors.go, hi: colors.hi, "night-stop": "transparent", "night-ghost": colors.nightRaised }[kind];
  // On "hi" the words are dark in either appearance: they are on yellow.
  const fg = kind === "go" || (kind === "ink" && regular) ? "white" : kind === "ink" ? "on-ink" : kind === "night-stop" ? "night-stop" : kind === "night-ghost" ? "white" : kind === "hi" ? "on-hi" : "ink";
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
  const colors = useColors();
  return (
    <View style={{ alignSelf: "flex-start", backgroundColor: colors.hi, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 }}>
      <Txt variant="tiny" tone="on-hi" style={{ fontWeight: "700" }}>
        {children}
      </Txt>
    </View>
  );
}

/** One small fact, as the timeline folds a turn's steps into a row of them. */
export function Chip({ children, tone = "plain", onPress, chevron }: { children: ReactNode; tone?: "plain" | "ok" | "bad"; onPress?: () => void; /** A chip that opens something: a small chevron after the words, turned down while it is open. */ chevron?: "open" | "closed" }) {
  const colors = useColors();
  const border = tone === "ok" ? `${colors.go}55` : tone === "bad" ? `${colors.stop}55` : colors.rule;
  const content = (
    <View style={{ backgroundColor: colors.card, borderColor: border, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Txt variant="small" tone={tone === "ok" ? "go" : tone === "bad" ? "stop" : "ink2"}>
          {children}
        </Txt>
        {chevron && <Chevron open={chevron === "open"} size={6} />}
      </View>
    </View>
  );
  if (!onPress) return content;
  return (
    <PressScale accessibilityRole="button" accessibilityState={chevron ? { expanded: chevron === "open" } : undefined} onPress={onPress} hitSlop={8} haptic="select" scaleTo={0.93}>
      {content}
    </PressScale>
  );
}

/**
 * A project's name as a tag in its colour (the one the Mac's sidebar gives it): the colour faintly behind, the colour in the
 * words and in a dot, so which project a chat belongs to reads at a glance. A project the Mac gave no colour is a plain grey tag.
 */
export function ProjectTag({ name, color }: { name: string; color: string | null }) {
  const { bg, fg } = projectTint(color, useColors().plainTint);
  return (
    <View style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: bg, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2, maxWidth: "100%" }}>
      <View accessibilityElementsHidden style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: fg }} />
      <Txt variant="tiny" numberOfLines={1} style={{ color: fg, fontWeight: "700", flexShrink: 1 }}>
        {name}
      </Txt>
    </View>
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
