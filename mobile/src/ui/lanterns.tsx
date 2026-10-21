import { View } from "react-native";
import { colors } from "./theme";

/** A lantern gone dark: the empty state's picture, drawn from a few boxes. */
export function DarkLantern() {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ alignItems: "center", marginBottom: 22 }}>
      <View style={{ width: 16, height: 10, borderWidth: 2, borderBottomWidth: 0, borderColor: colors.ink3, borderTopLeftRadius: 8, borderTopRightRadius: 8 }} />
      <View style={{ width: 44, height: 64, borderWidth: 2, borderColor: colors.ink3, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderBottomLeftRadius: 12, borderBottomRightRadius: 12 }} />
    </View>
  );
}
