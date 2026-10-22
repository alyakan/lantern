import { useEffect, useRef } from "react";
import { Animated, Easing, View } from "react-native";
import { skips } from "./motion";
import { colors } from "./theme";

/**
 * A small chevron drawn from two borders, like the Back button's: it points right when `open` is false and turns down (with
 * a short turn, not a jump) when it is true. Decoration only: what it belongs to says the state.
 */
export function Chevron({ open, color = colors.ink3, size = 8 }: { open: boolean; color?: string; size?: number }) {
  const turn = useRef(new Animated.Value(open ? 1 : 0)).current;
  useEffect(() => {
    if (skips()) turn.setValue(open ? 1 : 0);
    else Animated.timing(turn, { toValue: open ? 1 : 0, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [open, turn]);
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size + 6, height: size + 6, alignItems: "center", justifyContent: "center" }}>
      <Animated.View style={{ width: size, height: size, borderRightWidth: 2, borderBottomWidth: 2, borderColor: color, borderRadius: 1, transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ["-45deg", "45deg"] }) }] }} />
    </View>
  );
}
