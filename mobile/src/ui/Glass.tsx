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

/** Whether to draw Liquid Glass: where the phone has it, and its owner hasn't asked for less transparency (they get solid colours). */
export function useGlass(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    void Promise.resolve(AccessibilityInfo.isReduceTransparencyEnabled())
      .then((on) => live && setReduced(!!on))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener("reduceTransparencyChanged", setReduced);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return available() && !reduced;
}

/**
 * A surface that floats over the page: Liquid Glass on iOS 26, and everywhere else today's solid card with its shadow
 * (`lift` is how strong the shadow is). `style` is only its shape and layout (size, radius, padding, how it lays out its
 * children), never its colour: that is the surface's own. It takes no touches itself, so it can sit inside a button.
 */
export function Glass({ style, lift = 0.08, children, ...rest }: ViewProps & { /** The solid look's shadow strength. */ lift?: number }) {
  const glass = useGlass();
  const colors = useColors();
  if (glass) {
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
