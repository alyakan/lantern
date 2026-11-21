import { ScrollView, StyleSheet, Text, View } from "react-native";
import { PressScale } from "../ui/motion";
import { Sheet, SheetBar } from "../ui/Sheet";
import { Txt } from "../ui/components";
import { fonts, space, useColors } from "../ui/theme";
import { linesOf, previewOf } from "../view/paste";

/** What a long paste is called on its card. */
const sizeOf = (text: string) => {
  const n = linesOf(text);
  return n > 1 ? `${n} lines` : `${text.length} characters`;
};

/**
 * A long paste, held above the message box instead of in it, as the Claude app does: its first lines, a PASTED tag, a small ×
 * to take it off, and a tap to read all of it.
 */
export function PastedCards({ items, onOpen, onRemove }: { items: { id: string; text: string }[]; onOpen: (id: string) => void; onRemove: (id: string) => void }) {
  const colors = useColors();
  return (
    <ScrollView horizontal accessibilityLabel="Pasted text" showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8, paddingHorizontal: 6, paddingTop: 6, paddingBottom: 2 }} style={{ flexGrow: 0 }}>
      {items.map((p, i) => (
        <View key={p.id} style={{ width: 150, height: 88 }}>
          <PressScale accessibilityRole="button" accessibilityLabel={`Pasted text ${i + 1}, ${sizeOf(p.text)}`} accessibilityHint="Opens all of it" onPress={() => onOpen(p.id)} haptic="select" scaleTo={0.96} reach={false} style={{ flex: 1, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.rule, backgroundColor: colors.card, padding: 10, justifyContent: "space-between" }}>
            <Text numberOfLines={3} style={{ color: colors.ink2, fontSize: 12, lineHeight: 16 }}>
              {previewOf(p.text)}
            </Text>
            <View style={{ alignSelf: "flex-start", borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.rule, paddingHorizontal: 6, paddingVertical: 1 }}>
              <Text style={{ color: colors.ink3, fontSize: 10, letterSpacing: 0.6, fontWeight: "600" }}>PASTED</Text>
            </View>
          </PressScale>
          <PressScale accessibilityRole="button" accessibilityLabel={`Remove pasted text ${i + 1}`} onPress={() => onRemove(p.id)} hitSlop={12} haptic="light" scaleTo={0.85} reach={false} style={{ position: "absolute", top: 5, right: 5, width: 20, height: 20, borderRadius: 10, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center" }}>
            <View accessibilityElementsHidden style={{ position: "absolute", width: 9, height: 1.5, borderRadius: 1, backgroundColor: "#ffffff", transform: [{ rotate: "45deg" }] }} />
            <View accessibilityElementsHidden style={{ position: "absolute", width: 9, height: 1.5, borderRadius: 1, backgroundColor: "#ffffff", transform: [{ rotate: "-45deg" }] }} />
          </PressScale>
        </View>
      ))}
    </ScrollView>
  );
}

/** All of a long paste or a long message, to read and select. */
export function PastedSheet({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <Sheet size="large" onClose={onClose}>
      {(close, scroll) => (
        <View style={{ flex: 1 }}>
          <SheetBar title="Pasted text" close={{ label: "Close", onPress: close }} />
          <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: 6, paddingBottom: space.lg }}>
            <Text selectable style={{ fontFamily: fonts.mono, fontSize: 13, lineHeight: 19 }}>
              {text}
            </Text>
          </ScrollView>
        </View>
      )}
    </Sheet>
  );
}

/**
 * A long message of yours in the chat: its first lines in the bubble, fading out, and what it holds, which opens all of it.
 * (The Claude app does not print a page of pasted text into the conversation.)
 */
export function LongMessage({ text, onOpen }: { text: string; onOpen: () => void }) {
  const colors = useColors();
  return (
    <PressScale accessibilityRole="button" accessibilityLabel={`Long message, ${sizeOf(text)}`} accessibilityHint="Opens all of it" onPress={onOpen} haptic="select" scaleTo={0.98} reach={false}>
      <View testID="long-message" style={{ gap: 6 }}>
        <Text numberOfLines={5} style={{ color: colors.ink, fontSize: 15, lineHeight: 21 }}>
          {previewOf(text, 5)}
        </Text>
        <Txt variant="tiny" tone="ink3">
          Pasted text · {sizeOf(text)}
        </Txt>
      </View>
    </PressScale>
  );
}
