import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Txt } from "../ui/components";
import { Sheet, SheetBar } from "../ui/Sheet";
import { space, useColors } from "../ui/theme";
import type { ReleaseNotes } from "../whatsNew";

/** What changed in this build: shown once after an update, and again from the Mac sheet's "What's new". */
export function WhatsNewSheet({ notes, onClose }: { notes: ReleaseNotes; onClose: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  return (
    <Sheet onClose={onClose}>
      {(close, scroll) => (
        <View style={{ flexShrink: 1, paddingBottom: insets.bottom + space.xl, gap: 8 }}>
          <SheetBar title="What's new" close={{ label: "Close", onPress: close }} />
          <Txt variant="small" tone="ink3" style={{ paddingHorizontal: space.xl }}>
            Build {notes.build}
          </Txt>
          <ScrollView ref={scroll} style={{ flexShrink: 1 }} contentContainerStyle={{ gap: 10, paddingVertical: space.sm, paddingHorizontal: space.xl }}>
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
        </View>
      )}
    </Sheet>
  );
}
