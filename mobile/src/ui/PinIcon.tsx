import { View } from "react-native";
import { useColors } from "./theme";

/** A push pin, drawn from a head and a needle, leaning: it marks a pinned chat (and the swipe that pins). Decoration only. */
export function PinIcon({ color, size = 12 }: { color?: string; size?: number }) {
  const colors = useColors();
  const tint = color ?? colors.ink3;
  const u = size / 12;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size, transform: [{ rotate: "35deg" }] }}>
      <View style={{ position: "absolute", left: 3 * u, top: 0, width: 6 * u, height: 7.5 * u, borderRadius: 2 * u, backgroundColor: tint }} />
      <View style={{ position: "absolute", left: 1.5 * u, top: 6.5 * u, width: 9 * u, height: 1.6 * u, borderRadius: u, backgroundColor: tint }} />
      <View style={{ position: "absolute", left: 5.3 * u, top: 8 * u, width: 1.4 * u, height: 4 * u, borderRadius: 0.7 * u, backgroundColor: tint }} />
    </View>
  );
}
