import { useEffect, useState } from "react";
import { AccessibilityInfo, StyleSheet, useColorScheme, View, type ViewProps } from "react-native";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { shadow, useColors } from "./theme";

/** Whether this phone can draw Liquid Glass (iOS 26 and later); false anywhere else, and where the module isn't there. */
function available(): boolean {
  try {
    return isLiquidGlassAvailable();
  } catch {
    return false;
  }
}

// Whether the phone is set to reduce transparency: asked once when the app starts, so a screen knows it when it first draws (a
// screen that switched layouts after it mounted would rebuild its list), and kept up to date as the setting changes.
let reducedNow = false;
const listeners = new Set<(on: boolean) => void>();
const setReducedNow = (on: boolean) => {
  reducedNow = on;
  listeners.forEach((l) => l(on));
};
void Promise.resolve(AccessibilityInfo.isReduceTransparencyEnabled?.())
  .then((on) => setReducedNow(!!on))
  .catch(() => {});
AccessibilityInfo.addEventListener?.("reduceTransparencyChanged", setReducedNow);

/** Whether to draw Liquid Glass: where the phone has it, and its owner hasn't asked for less transparency (they get solid colours). */
export function useGlass(): boolean {
  const [reduced, setReduced] = useState(reducedNow);
  useEffect(() => {
    listeners.add(setReduced);
    setReduced(reducedNow);
    return () => void listeners.delete(setReduced);
  }, []);
  return available() && !reduced;
}

/** How much of the card's colour (hex alpha, about 15%) the surface keeps under its glass. */
export const GLASS_FILL = "26";

/**
 * How much of the card's colour (about 65%) the message box keeps under its glass. The box is where words are typed, over a chat
 * that runs under it: at a tint it was sometimes all but invisible, and the words were hard to read over what showed through. It
 * still blurs what is behind it (the glass is over this fill), and is the one surface that is stronger than a tint.
 */
export const COMPOSER_FILL = "a6";

/**
 * A surface that floats over the page: Liquid Glass on iOS 26, and everywhere else today's solid card with its shadow
 * (`lift` is how strong the shadow is). `style` is only its shape and layout (size, radius, padding, how it lays out its
 * children), never its colour: that is the surface's own. It takes no touches itself, so it can sit inside a button.
 */
export function Glass({ style, lift = 0.08, solid = false, fill = GLASS_FILL, children, ...rest }: ViewProps & { /** The solid look's shadow strength. */ lift?: number; /** The card colour kept under the glass, as two hex digits of alpha: a tint unless the words on it need more. */ fill?: string; /** Always the solid card: for what holds words that must read over whatever is behind it. */ solid?: boolean }) {
  const glass = useGlass();
  const colors = useColors();
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  if (glass && !solid) {
    // (Never put this where it fades in from nothing: the glass then stays clear. See `FadeSlideIn`'s `glass` in motion.tsx.)
    // The glass is a layer behind the children. The surface itself has a faint fill of the card's colour and a hairline, which
    // don't depend on it: a glass view that mounts late (a chat's message box when the chat wakes) has sometimes drawn nothing,
    // and over a plain page there was then no edge at all. The fill is under the glass, so what the glass blurs includes it: a
    // strong one (it was over half the card's colour) leaves nothing behind the box to see through, and the glass looks like a
    // flat card. It is only a tint, enough for an edge.
    const radius = StyleSheet.flatten(style)?.borderRadius;
    return (
      <View style={[{ backgroundColor: `${colors.card}${fill}`, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: colors.rule }, style]} {...rest}>
        {/* The glass is told which look the app is in, and is made again when that changes: left to follow the system by itself it has stayed clear (switching light and dark put it right). */}
        <GlassView key={scheme} colorScheme={scheme} pointerEvents="none" glassEffectStyle="regular" style={[StyleSheet.absoluteFill, radius === undefined ? null : { borderRadius: radius }]} />
        {children}
      </View>
    );
  }
  return (
    <View style={[{ backgroundColor: colors.card }, shadow.float, { shadowOpacity: lift }, style]} {...rest}>
      {children}
    </View>
  );
}
