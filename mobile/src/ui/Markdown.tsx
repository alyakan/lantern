import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Linking, ScrollView, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { parseMarkdown, plainText, type Align, type Block, type Span } from "../view/markdown";
import { useAccent } from "./accent";
import { colors, fonts, radius, type as scale } from "./theme";
import { Txt } from "./components";
import { PressScale } from "./motion";

/** The colour of the words: ink on the page, night or white on a dark background (white: your own message). */
type Tone = "ink" | "night" | "white";

function Spans({ spans, tone }: { spans: Span[]; tone: Tone }) {
  const accent = useAccent();
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
                {s.spans ? <Spans spans={s.spans} tone={tone} /> : s.text}
              </Text>
            );
          case "italic":
            return (
              <Text key={i} style={{ fontStyle: "italic" }}>
                {s.spans ? <Spans spans={s.spans} tone={tone} /> : s.text}
              </Text>
            );
          case "strike":
            return (
              <Text key={i} style={{ textDecorationLine: "line-through", opacity: 0.7 }}>
                {s.spans ? <Spans spans={s.spans} tone={tone} /> : s.text}
              </Text>
            );
          case "link":
            return (
              <Text key={i} accessibilityRole="link" style={{ color: accent, textDecorationLine: "underline" }} onPress={() => void Linking.openURL(s.url).catch(() => {})}>
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

/** A task box in a list: empty, or filled with a check. */
function TaskBox({ checked }: { checked: boolean }) {
  return (
    <View accessible accessibilityRole="checkbox" accessibilityState={{ checked }} style={{ width: 17, height: 17, marginTop: 2, borderRadius: 5, borderWidth: 1.5, borderColor: checked ? colors.go : colors.ink3, backgroundColor: checked ? colors.go : "transparent", alignItems: "center", justifyContent: "center" }}>
      {checked && <View accessibilityElementsHidden style={{ width: 9, height: 5, marginTop: -2, borderLeftWidth: 2, borderBottomWidth: 2, borderColor: colors.white, transform: [{ rotate: "-45deg" }] }} />}
    </View>
  );
}

/** A code block: the language and a Copy on top, the code below (it scrolls sideways rather than wrapping). */
function CodeBlock({ lang, text, tone }: { lang: string; text: string; tone: Tone }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = () => {
    void Promise.resolve(Clipboard.setStringAsync(text)).catch(() => {});
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  const night = tone !== "ink";
  return (
    <View style={{ backgroundColor: night ? colors.nightRaised : colors.paper, borderRadius: radius.inner, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingLeft: 12, paddingRight: 6, minHeight: 30 }}>
        <Txt variant="tiny" tone={night ? "night" : "ink3"} style={{ fontWeight: "700" }}>
          {lang}
        </Txt>
        <PressScale accessibilityRole="button" accessibilityLabel={copied ? "Copied" : "Copy code"} onPress={copy} hitSlop={6} haptic="light" scaleTo={0.92} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Txt variant="tiny" tone={copied ? "go" : "cobalt"} style={{ fontWeight: "700" }}>
            {copied ? "Copied" : "Copy"}
          </Txt>
        </PressScale>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12 }}>
        <Text selectable style={[scale.mono, { color: night ? colors.white : colors.ink }]}>
          {text}
        </Text>
      </ScrollView>
    </View>
  );
}

/** What a column of a table needs, from what is longest in it: wide enough to read, narrow enough to leave room for the next. */
const columnWidth = (cells: Span[][]) => Math.round(Math.min(240, Math.max(72, Math.max(...cells.map((c) => plainText(c).length)) * 7.6 + 26)));

/**
 * A table in a box of its own: the header on a tint, a line between rows, columns as wide as their content (up to a
 * limit, past which a cell wraps), aligned as the table says. It scrolls sideways in there when it can't fit, not the page.
 */
function Table({ block, tone }: { block: Extract<Block, { kind: "table" }>; tone: Tone }) {
  const widths = block.head.map((h, c) => columnWidth([h, ...block.rows.map((r) => r[c] ?? [])]));
  const textAlign = (a: Align) => a;
  const night = tone !== "ink";
  const line = night ? "rgba(255,255,255,0.14)" : colors.rule;
  const row = (cells: Span[][], key: string, head: boolean, last: boolean) => (
    <View key={key} accessibilityRole={head ? "header" : undefined} style={{ flexDirection: "row", backgroundColor: head ? (night ? colors.nightRaised : colors.paper) : "transparent", borderBottomWidth: last ? 0 : 1, borderBottomColor: line }}>
      {cells.map((cell, c) => (
        <View key={c} style={{ width: widths[c], paddingHorizontal: 12, paddingVertical: 8, borderLeftWidth: c === 0 ? 0 : 1, borderLeftColor: line, justifyContent: "center" }}>
          <Txt variant="small" tone={tone} selectable style={{ textAlign: textAlign(block.align[c] ?? "left"), fontWeight: head ? "700" : undefined }}>
            <Spans spans={cell} tone={tone} />
          </Txt>
        </View>
      ))}
    </View>
  );
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ borderWidth: 1, borderColor: line, borderRadius: radius.inner }}>
      <View>
        {row(block.head, "head", true, block.rows.length === 0)}
        {block.rows.map((r, i) => row(r, `r${i}`, false, i === block.rows.length - 1))}
      </View>
    </ScrollView>
  );
}

/** Claude's text: headings, paragraphs, lists, tables, quotes, rules and code blocks. Memoised per text, so only a streaming block redraws. */
export const Markdown = memo(function Markdown({ text, tone = "ink", selectable = true }: { text: string; tone?: Tone; /** False where a long press means something else (a message's actions); code and tables stay selectable. */ selectable?: boolean }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <View style={{ gap: 8 }}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "heading":
            return b.level <= 2 ? (
              <Txt key={i} variant="heading" tone={tone} selectable={selectable} accessibilityRole="header" style={{ marginTop: 4 }}>
                <Spans spans={b.spans} tone={tone} />
              </Txt>
            ) : (
              <Txt key={i} variant="body" tone={tone} selectable={selectable} accessibilityRole="header" style={{ fontWeight: "700", marginTop: 2 }}>
                <Spans spans={b.spans} tone={tone} />
              </Txt>
            );
          case "paragraph":
            return (
              <Txt key={i} variant="body" tone={tone} selectable={selectable}>
                <Spans spans={b.spans} tone={tone} />
              </Txt>
            );
          case "list":
            return (
              <View key={i} style={{ gap: 4 }}>
                {b.items.map((item, j) => {
                  const m = b.meta[j];
                  return (
                    <View key={j} style={{ flexDirection: "row", gap: 8, paddingLeft: m.depth * 18 }}>
                      {m.checked !== null ? (
                        <View style={{ width: 22, alignItems: "flex-start" }}>
                          <TaskBox checked={m.checked} />
                        </View>
                      ) : (
                        <Txt variant="body" tone={tone} style={{ minWidth: 22 }}>
                          {m.marker}
                        </Txt>
                      )}
                      <Txt variant="body" tone={m.checked ? "ink3" : tone} selectable={selectable} style={{ flex: 1, textDecorationLine: m.checked ? "line-through" : "none" }}>
                        <Spans spans={item} tone={tone} />
                      </Txt>
                    </View>
                  );
                })}
              </View>
            );
          case "quote":
            return (
              <View key={i} style={{ borderLeftWidth: 3, borderLeftColor: colors.rule, paddingLeft: 10 }}>
                <Txt variant="body" tone="ink2" selectable={selectable}>
                  <Spans spans={b.spans} tone={tone} />
                </Txt>
              </View>
            );
          case "table":
            return <Table key={i} block={b} tone={tone} />;
          case "rule":
            return <View key={i} accessibilityElementsHidden style={{ height: 1, backgroundColor: tone === "ink" ? colors.rule : "rgba(255,255,255,0.14)", marginVertical: 6 }} />;
          case "code":
            return <CodeBlock key={i} lang={b.lang} text={b.text} tone={tone} />;
        }
      })}
    </View>
  );
});
