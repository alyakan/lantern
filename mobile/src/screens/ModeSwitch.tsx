import { View } from "react-native";
import type { HomeMode } from "../prefs";
import { Txt } from "../ui/components";
import { PressScale } from "../ui/motion";
import { radius, useColors } from "../ui/theme";

export interface ModeChoice {
  id: HomeMode;
  label: string;
  /** How many things wait in it (Work: the steps to do next). */
  badge?: number;
}

/** Home as the Desk (every chat at once, and a box that finds the chat), Your work (where things stand, and what to do next) or the list of chats. */
export function ModeSwitch({ value, modes, onChange }: { value: HomeMode; modes: ModeChoice[]; onChange: (m: HomeMode) => void }) {
  const colors = useColors();
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", backgroundColor: colors.card, borderRadius: radius.pill, padding: 3, borderWidth: 1, borderColor: colors.rule }}>
      {modes.map((m) => (
        <PressScale key={m.id} accessibilityRole="tab" accessibilityLabel={m.badge ? `${m.label}, ${m.badge} to do` : m.label} accessibilityState={{ selected: value === m.id }} onPress={() => onChange(m.id)} haptic="select" scaleTo={0.94} style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 4, borderRadius: radius.pill, backgroundColor: value === m.id ? colors.ink : "transparent" }}>
          <Txt variant="small" tone={value === m.id ? "on-ink" : "ink2"} style={{ fontWeight: "700" }}>
            {m.label}
          </Txt>
          {!!m.badge && (
            <View style={{ minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 4, alignItems: "center", justifyContent: "center", backgroundColor: colors.hi }}>
              <Txt variant="tiny" tone="on-hi" style={{ fontWeight: "700" }}>
                {m.badge}
              </Txt>
            </View>
          )}
        </PressScale>
      ))}
    </View>
  );
}
