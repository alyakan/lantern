import { ScrollView, View } from "react-native";
import { Txt } from "../ui/components";
import { fonts, radius, useColors } from "../ui/theme";
import { countsOf, type DiffPreview } from "../view/diffPreview";

/**
 * The change a prompt asks to make, drawn as a diff: what goes in red, what comes in green, a little of what stays around it.
 * Long lines scroll sideways inside it, not the page. `tone` "night" is for the full-screen decision (dark), "paper" for the
 * card inside the chat. It says plainly what it can't show: a change cut short, an edit that replaces every place its text
 * appears, a file written whole over whatever was there.
 */
export function DiffPreviewCard({ preview, file, tone = "night" }: { preview: DiffPreview; file: string | null; tone?: "night" | "paper" }) {
  const colors = useColors();
  const night = tone === "night";
  const palette = night ? { bg: colors.nightRaised, ink: colors.white, soft: colors.nightText, line: colors.nightLine, label: "night" as const, title: "white" as const } : { bg: colors.paper, ink: colors.ink, soft: colors.ink2, line: colors.rule, label: "ink3" as const, title: "ink" as const };
  const counts = countsOf(preview);
  // The counts are for what is drawn: a lower bound when the change is bigger than that.
  const atLeast = preview.partial || preview.replaceAll;
  const notes = [preview.partial ? "Only part of this change is shown. The rest is on your Mac: look there before you approve if it matters." : null, preview.replaceAll ? "This changes every place this text appears. One is shown." : null, preview.kind === "new" ? "This writes the whole file. What it replaces is not shown." : null].filter((n): n is string => n !== null);
  return (
    <View testID="diff-preview" style={{ backgroundColor: palette.bg, borderRadius: radius.inner, overflow: "hidden", marginTop: 6 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8 }}>
        <Txt variant="small" tone={palette.label} style={{ fontWeight: "700" }}>
          {preview.kind === "new" ? "What it writes" : "What changes"}
        </Txt>
        {!!counts && (
          <Txt variant="small" tone={palette.title} accessibilityLabel={`${atLeast ? "at least " : ""}${preview.added} lines added, ${preview.removed} removed`} style={{ fontWeight: "700" }}>
            {atLeast ? `at least ${counts}` : counts}
          </Txt>
        )}
      </View>
      {notes.map((n) => (
        <Txt key={n} variant="small" tone={palette.title} accessibilityRole="alert" style={{ marginHorizontal: 14, marginBottom: 8, padding: 8, borderRadius: 8, backgroundColor: `${colors.hi}33` }}>
          {n}
        </Txt>
      ))}
      {!!file && (
        <Txt variant="tiny" tone={palette.label} numberOfLines={1} ellipsizeMode="head" style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
          {file}
        </Txt>
      )}
      {preview.blocks.map((b, n) => (
        <View key={n} style={{ borderTopWidth: n === 0 && !b.title ? 0 : 1, borderTopColor: palette.line }}>
          {!!b.title && (
            <Txt variant="tiny" tone={palette.label} style={{ paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4, fontWeight: "700" }}>
              {b.title}
            </Txt>
          )}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ minWidth: "100%", paddingBottom: 6 }}>
              {b.lines.map((l, i) => (
                <View key={i} style={{ flexDirection: "row", backgroundColor: l.sign === "+" ? `${colors.go}26` : l.sign === "-" ? `${colors.stop}26` : "transparent", paddingHorizontal: 14 }}>
                  <Txt variant="mono" accessibilityElementsHidden style={{ width: 14, fontFamily: fonts.mono, color: l.sign === "+" ? colors.go : l.sign === "-" ? colors.stop : palette.soft }}>
                    {l.sign}
                  </Txt>
                  <Txt variant="mono" selectable accessibilityLabel={`${l.sign === "+" ? "added" : l.sign === "-" ? "removed" : "unchanged"}: ${l.text}`} style={{ fontFamily: fonts.mono, color: l.sign === " " ? palette.soft : palette.ink }}>
                    {l.text || " "}
                  </Txt>
                </View>
              ))}
            </View>
          </ScrollView>
        </View>
      ))}
      {preview.hidden > 0 && (
        <Txt variant="tiny" tone={palette.label} style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
          …and {preview.hidden} more {preview.hidden === 1 ? "line" : "lines"} not shown here. Open the chat on your Mac to see all of it.
        </Txt>
      )}
    </View>
  );
}
