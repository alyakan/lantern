import { View, type Insets } from "react-native";
import { Glass } from "./Glass";
import { PressScale } from "./motion";
import { control, MIN_TARGET, useColors } from "./theme";

/** The chevron that says back: one drawing for every bar that has a way back. */
export function BackChevron() {
  const colors = useColors();
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 12, height: 12, marginLeft: 4, borderLeftWidth: 3, borderBottomWidth: 3, borderColor: colors.ink, borderRadius: 2, transform: [{ rotate: "45deg" }] }} />;
}

/** The way back at the left of a bar, as iOS 26 draws it: a chevron in a circle of glass, with the same tap under the finger everywhere. */
export function BackButton({ label = "Back", hint, onPress, hitSlop = 8 }: { label?: string; hint?: string; onPress?: () => void; hitSlop?: number | Insets }) {
  return (
    <PressScale accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint} onPress={onPress} hitSlop={hitSlop} haptic="select" scaleTo={0.88} style={{ minHeight: MIN_TARGET, minWidth: MIN_TARGET, justifyContent: "center" }}>
      <Glass style={{ width: control, height: control, borderRadius: control / 2, alignItems: "center", justifyContent: "center" }}>
        <BackChevron />
      </Glass>
    </PressScale>
  );
}
