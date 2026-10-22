import { useEffect, useState } from "react";
import { AccessibilityInfo, View, type ViewProps } from "react-native";
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

/**
 * A surface that floats over the page: Liquid Glass on iOS 26, and everywhere else today's solid card with its shadow
 * (`lift` is how strong the shadow is). `style` is only its shape and layout (size, radius, padding, how it lays out its
 * children), never its colour: that is the surface's own. It takes no touches itself, so it can sit inside a button.
 */
export function Glass({ style, lift = 0.08, solid = false, children, ...rest }: ViewProps & { /** The solid look's shadow strength. */ lift?: number; /** Always the solid card: for what holds words that must read over whatever is behind it. */ solid?: boolean }) {
  const glass = useGlass();
  const colors = useColors();
  if (glass && !solid) {
    return (
      <GlassView glassEffectStyle="regular" style={style} {...rest}>
        {children}
      </GlassView>
    );
  }
  return (
    <View style={[{ backgroundColor: colors.card }, shadow.float, { shadowOpacity: lift }, style]} {...rest}>
      {children}
    </View>
  );
}
