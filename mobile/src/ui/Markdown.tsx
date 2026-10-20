import { memo, useMemo } from "react";
import { Linking, ScrollView, Text, View } from "react-native";
import { parseMarkdown, type Span } from "../view/markdown";
import { colors, fonts, radius, type as scale } from "./theme";
import { Txt } from "./components";

function Spans({ spans, tone }: { spans: Span[]; tone: "ink" | "night" }) {
  return (
    <>
      {spans.map((s, i) => {
        switch (s.kind) {
          case "code":
            return (
              <Text key={i} style={{ fontFamily: fonts.mono, fontSize: 13, backgroundColor: tone === "ink" ? "#0000000d" : colors.nightRaised }}>
                {s.text}
              </Text>
            );
          case "bold":
            return (
              <Text key={i} style={{ fontWeight: "700" }}>
                {s.text}
              </Text>
            );
          case "italic":
            return (
              <Text key={i} style={{ fontStyle: "italic" }}>
                {s.text}
              </Text>
            );
          case "link":
            return (
              <Text key={i} accessibilityRole="link" style={{ color: colors.cobalt, textDecorationLine: "underline" }} onPress={() => void Linking.openURL(s.url).catch(() => {})}>
                {s.text}
              </Text>
            );
          default:
            return s.text;
        }
      })}
    </>
  );
}

/** Claude's text: headings, paragraphs, lists, quotes and code blocks. Memoised per text, so only a streaming block redraws. */
export const Markdown = memo(function Markdown({ text, tone = "ink" }: { text: string; tone?: "ink" | "night" }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <View style={{ gap: 8 }}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "heading":
            return (
              <Txt key={i} variant="heading" tone={tone}>
                <Spans spans={b.spans} tone={tone} />
              </Txt>
            );
          case "paragraph":
            return (
              <Txt key={i} variant="body" tone={tone}>
                <Spans spans={b.spans} tone={tone} />
              </Txt>
            );
          case "list":
            return (
              <View key={i} style={{ gap: 4 }}>
                {b.items.map((item, j) => (
                  <View key={j} style={{ flexDirection: "row", gap: 8 }}>
                    <Txt variant="body" tone={tone} style={{ width: 18 }}>
                      {b.ordered ? `${j + 1}.` : "•"}
                    </Txt>
                    <Txt variant="body" tone={tone} style={{ flex: 1 }}>
                      <Spans spans={item} tone={tone} />
                    </Txt>
                  </View>
                ))}
              </View>
            );
          case "quote":
            return (
              <View key={i} style={{ borderLeftWidth: 3, borderLeftColor: colors.rule, paddingLeft: 10 }}>
                <Txt variant="body" tone="ink2">
                  <Spans spans={b.spans} tone={tone} />
                </Txt>
              </View>
            );
          case "code":
            return (
              <ScrollView key={i} horizontal showsHorizontalScrollIndicator={false} style={{ backgroundColor: tone === "ink" ? colors.paper : colors.nightRaised, borderRadius: radius.inner }} contentContainerStyle={{ padding: 12 }}>
                <Text selectable style={[scale.mono, { color: tone === "ink" ? colors.ink : colors.white }]}>
                  {b.text}
                </Text>
              </ScrollView>
            );
        }
      })}
    </View>
  );
});
