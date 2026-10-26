import { ScrollView, View } from "react-native";
import { Txt } from "../ui/components";
import { fonts, radius, useColors } from "../ui/theme";
import { countsOf, type DiffPreview } from "../view/diffPreview";

/**
 * The change a prompt asks to make, drawn as a diff on the decision screen (dark, like the screen): what goes in red, what comes
 * in green, a little of what stays around it. Long lines scroll sideways inside it, not the page.
 */
export function DiffPreviewCard({ preview, file }: { preview: DiffPreview; file: string | null }) {
  const colors = useColors();
  const counts = countsOf(preview);
  return (
    <View testID="diff-preview" style={{ backgroundColor: colors.nightRaised, borderRadius: radius.inner, overflow: "hidden", marginTop: 6 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8 }}>
        <Txt variant="small" tone="night" style={{ fontWeight: "700" }}>
          {preview.kind === "new" ? "What it writes" : "What changes"}
        </Txt>
        {!!counts && (
          <Txt variant="small" tone="white" accessibilityLabel={`${preview.added} lines added, ${preview.removed} removed`} style={{ fontWeight: "700" }}>
            {preview.partial ? `at least ${counts}` : counts}
          </Txt>
        )}
      </View>
      {preview.partial && (
        <Txt variant="small" tone="white" accessibilityRole="alert" style={{ marginHorizontal: 14, marginBottom: 8, padding: 8, borderRadius: 8, backgroundColor: `${colors.hi}33` }}>
          Only part of this change is shown. The rest is on your Mac: look there before you approve if it matters.
        </Txt>
      )}
      {!!file && (
        <Txt variant="tiny" tone="night" numberOfLines={1} ellipsizeMode="head" style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
          {file}
        </Txt>
      )}
      {preview.blocks.map((b, n) => (
        <View key={n} style={{ borderTopWidth: n === 0 && !b.title ? 0 : 1, borderTopColor: colors.nightLine }}>
          {!!b.title && (
            <Txt variant="tiny" tone="night" style={{ paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4, fontWeight: "700" }}>
              {b.title}
            </Txt>
          )}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ minWidth: "100%", paddingBottom: 6 }}>
              {b.lines.map((l, i) => (
                <View key={i} style={{ flexDirection: "row", backgroundColor: l.sign === "+" ? `${colors.go}26` : l.sign === "-" ? `${colors.stop}26` : "transparent", paddingHorizontal: 14 }}>
                  <Txt variant="mono" accessibilityElementsHidden style={{ width: 14, fontFamily: fonts.mono, color: l.sign === "+" ? colors.go : l.sign === "-" ? colors.stop : colors.nightText }}>
                    {l.sign}
                  </Txt>
                  <Txt variant="mono" selectable accessibilityLabel={`${l.sign === "+" ? "added" : l.sign === "-" ? "removed" : "unchanged"}: ${l.text}`} style={{ fontFamily: fonts.mono, color: l.sign === " " ? colors.nightText : colors.white }}>
                    {l.text || " "}
                  </Txt>
                </View>
              ))}
            </View>
          </ScrollView>
        </View>
      ))}
      {preview.hidden > 0 && (
        <Txt variant="tiny" tone="night" style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
          …and {preview.hidden} more {preview.hidden === 1 ? "line" : "lines"} not shown here. Open the chat on your Mac to see all of it.
        </Txt>
      )}
    </View>
  );
}
