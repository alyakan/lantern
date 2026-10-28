import { useState } from "react";
import { View } from "react-native";
import { Txt } from "../ui/components";
import { Chevron } from "../ui/Chevron";
import { PressScale } from "../ui/motion";
import { radius, shadow, useColors } from "../ui/theme";

/** What the chat's sheet beside it can show. Only Changes for now; more (its files…) take a row here. */
export type Panel = "changes";

const PANELS: { value: Panel; label: string }[] = [{ value: "changes", label: "Changes" }];

/** The title bar's icon for the sheet: a page with a line added and a line taken out. */
export function ChangesIcon({ color }: { color: string }) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 16, height: 20, borderRadius: 3, borderWidth: 2, borderColor: color, alignItems: "center", justifyContent: "center", gap: 3 }}>
      {/* + */}
      <View style={{ width: 8, height: 8, alignItems: "center", justifyContent: "center" }}>
        <View style={{ position: "absolute", width: 8, height: 2, borderRadius: 1, backgroundColor: color }} />
        <View style={{ position: "absolute", width: 2, height: 8, borderRadius: 1, backgroundColor: color }} />
      </View>
      {/* − */}
      <View style={{ width: 8, height: 2, borderRadius: 1, backgroundColor: color }} />
    </View>
  );
}

/** The sheet's heading as a menu: what it shows, and (opened) what else it can. */
export function PanelMenu({ value, onPick }: { value: Panel; onPick?: (p: Panel) => void }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const label = PANELS.find((p) => p.value === value)?.label ?? value;
  return (
    <View style={{ alignSelf: "flex-start", zIndex: 2 }}>
      <PressScale accessibilityRole="button" accessibilityLabel={`Showing ${label}`} accessibilityHint="Choose what this sheet shows" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} haptic="select" scaleTo={0.97} hitSlop={8} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Txt variant="heading" accessibilityRole="header">
          {label}
        </Txt>
        <Chevron open={open} color={colors.ink2} />
      </PressScale>
      {open && (
        <View accessibilityRole="menu" style={[{ position: "absolute", top: 32, left: -8, minWidth: 200, backgroundColor: colors.card, borderRadius: radius.inner, borderWidth: 1, borderColor: colors.rule, paddingVertical: 4 }, shadow.card]}>
          {PANELS.map((p) => (
            <PressScale
              key={p.value}
              accessibilityRole="menuitem"
              accessibilityState={{ selected: p.value === value }}
              onPress={() => {
                setOpen(false);
                onPick?.(p.value);
              }}
              haptic="select"
              scaleTo={0.98}
              style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 10, paddingHorizontal: 14 }}
            >
              <Txt variant="body" style={{ fontWeight: p.value === value ? "700" : "400" }}>
                {p.label}
              </Txt>
              {p.value === value && (
                <Txt variant="body" tone="cobalt">
                  ✓
                </Txt>
              )}
            </PressScale>
          ))}
        </View>
      )}
    </View>
  );
}
