import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Txt } from "../ui/components";
import { Sheet } from "../ui/Sheet";
import { radius, space, useColors } from "../ui/theme";
import type { ReleaseNotes } from "../whatsNew";

/** What changed in this build: shown once after an update, and again from the Mac sheet's "What's new". */
export function WhatsNewSheet({ notes, onClose }: { notes: ReleaseNotes; onClose: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <View style={{ flexShrink: 1, backgroundColor: colors.card, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, padding: space.xl, paddingBottom: insets.bottom + space.xl, gap: 8 }}>
          <Txt variant="heading" accessibilityRole="header">
            What's new
          </Txt>
          <Txt variant="small" tone="ink3">
            Build {notes.build}
          </Txt>
          <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ gap: 10, paddingVertical: space.sm }}>
            {notes.notes.map((note, i) => (
              <View key={i} style={{ flexDirection: "row", gap: 10 }}>
                <Txt variant="body" tone="ink2" accessibilityElementsHidden importantForAccessibility="no">
                  •
                </Txt>
                <Txt variant="body" style={{ flex: 1 }}>
                  {note}
                </Txt>
              </View>
            ))}
          </ScrollView>
          <Button label="Close" onPress={close} />
        </View>
      )}
    </Sheet>
  );
}
