import { useMemo, useState, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { Button, Txt } from "../ui/components";
import { tokenColour } from "../ui/Markdown";
import { fonts, space, type as scale, useColors, type Palette } from "../ui/theme";
import { isMarkdown, languageOf, markdownOf, parseUnifiedDiff, tokensOf, type DiffRow, type MdLine, type RowKind } from "../view/fileDiff";
import type { TokenKind } from "../view/highlight";
import { parseInline, type Span } from "../view/markdown";

/** A token's colour in a diff: the chat's, but strings are not green (an added line already is), so none of them sinks into its row. */
const codeColour = (kind: TokenKind, colors: Palette) => (kind === "string" ? (colors.isDark ? "#c792ea" : "#8a3fbf") : tokenColour(kind, colors));

/** A row's wash by what it is: green for an added line, red for a removed one, none for the rest. The line numbers sit on a stronger one. */
const washOf = (kind: RowKind, colors: Palette, strong: boolean) => (kind === "add" ? `${colors.go}${strong ? "40" : "26"}` : kind === "del" ? `${colors.stop}${strong ? "40" : "26"}` : "transparent");

const KIND_WORDS: Partial<Record<RowKind, string>> = { add: "Added", del: "Removed", ctx: "Unchanged" };

/** How many rows are drawn at first: the Mac sends up to 512 KB, and a lock file's change would be thousands of native views. The rest waits behind a button. */
export const MAX_ROWS = 800;

/** A markdown line's words with their marks (bold, code, links…) drawn rather than written. Links are only coloured: the words are a file's, not a message's. */
function Inline({ spans, colors }: { spans: Span[]; colors: Palette }): ReactNode {
  return spans.map((s, i) => {
    const inner = "spans" in s && s.spans ? <Inline spans={s.spans} colors={colors} /> : s.text;
    switch (s.kind) {
      case "code":
        return (
          <Text key={i} style={{ fontFamily: fonts.mono, fontSize: 13, backgroundColor: colors.wash }}>
            {s.text}
          </Text>
        );
      case "bold":
        return (
          <Text key={i} style={{ fontWeight: "700" }}>
            {inner}
          </Text>
        );
      case "italic":
        return (
          <Text key={i} style={{ fontStyle: "italic" }}>
            {inner}
          </Text>
        );
      case "strike":
        return (
          <Text key={i} style={{ textDecorationLine: "line-through", opacity: 0.7 }}>
            {inner}
          </Text>
        );
      case "link":
      case "file":
        return (
          <Text key={i} style={{ color: colors.cobalt, textDecorationLine: "underline" }}>
            {inner}
          </Text>
        );
      default:
        return s.text;
    }
  });
}

/** One line of a markdown file, drawn as what it is: a heading bold, a list item with its bullet, a quote with its bar, code as code. */
function MdText({ line, colors }: { line: MdLine; colors: Palette }) {
  const words = line.text === "" ? " " : null;
  const ink = { color: colors.ink, flexShrink: 1 } as const;
  switch (line.kind) {
    case "heading":
      return (
        <Text selectable style={[scale.body, ink, { fontWeight: "700" }]}>
          {words ?? <Inline spans={parseInline(line.text)} colors={colors} />}
        </Text>
      );
    case "list":
      return (
        <View style={{ flexDirection: "row", gap: 6, paddingLeft: line.depth * 16 }}>
          <Text style={[scale.body, { color: colors.ink3 }]}>{line.marker}</Text>
          <Text selectable style={[scale.body, ink, { flex: 1 }]}>
            {words ?? <Inline spans={parseInline(line.text)} colors={colors} />}
          </Text>
        </View>
      );
    case "quote":
      return (
        <View style={{ borderLeftWidth: 3, borderLeftColor: colors.rule, paddingLeft: 8 }}>
          <Text selectable style={[scale.body, { color: colors.ink2, fontStyle: "italic" }]}>
            {words ?? <Inline spans={parseInline(line.text)} colors={colors} />}
          </Text>
        </View>
      );
    case "rule":
      return <View style={{ height: 1, backgroundColor: colors.rule, marginVertical: 9 }} />;
    case "fence":
      return <Text style={[scale.mono, { color: colors.ink3 }]}>{line.text || " "}</Text>;
    case "code":
    case "table":
      return (
        <Text selectable style={[scale.mono, { color: line.kind === "code" ? colors.ink : colors.ink2 }]}>
          {line.text || " "}
        </Text>
      );
    default:
      return (
        <Text selectable style={[scale.body, ink]}>
          {words ?? <Inline spans={parseInline(line.text)} colors={colors} />}
        </Text>
      );
  }
}

/**
 * A file's change, drawn as the file: each line with its number in the old and new file, a green wash behind what was added and a
 * red one behind what was removed (no "+" or "-"), code coloured as its language and a markdown file's lines as markdown. Code
 * scrolls sideways; markdown wraps, as prose should. Read-only.
 */
export function DiffView({ path, text }: { path: string; text: string }) {
  const colors = useColors();
  const rows = useMemo(() => parseUnifiedDiff(text), [text]);
  const markdown = isMarkdown(path);
  const lang = languageOf(path);
  const tokens = useMemo(() => (markdown ? null : tokensOf(rows, lang)), [rows, markdown, lang]);
  const lines = useMemo(() => (markdown ? markdownOf(rows) : null), [rows, markdown]);
  const widest = useMemo(() => rows.reduce((n, r) => Math.max(n, r.oldNo ?? 0, r.newNo ?? 0), 0), [rows]);
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, MAX_ROWS);
  if (rows.length === 0) {
    return (
      <Txt variant="small" tone="ink2" style={{ padding: space.lg }}>
        Nothing to show.
      </Txt>
    );
  }
  // A diff with no numbers in it (see parseUnifiedDiff) gets no gutter.
  const gutter = widest > 0 ? String(widest).length * 8 + 10 : 0;
  // A View round the number, so its wash is as tall as the row when a markdown line wraps.
  const number = (n: number | null, row: DiffRow) => (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: gutter, backgroundColor: washOf(row.kind, colors, true) }}>
      <Text style={[scale.mono, { textAlign: "right", paddingRight: 6, color: colors.ink3 }]}>{n ?? ""}</Text>
    </View>
  );
  const body = (
    <View testID="diff-view" style={{ minWidth: "100%", paddingVertical: 4 }}>
      {shown.map((row, i) => {
        if (row.kind === "gap") {
          return (
            <View key={i} accessible accessibilityLabel={`Lines skipped, next from line ${row.text}`} style={{ backgroundColor: colors.wash, paddingVertical: 2, paddingLeft: gutter ? 8 : space.lg, marginVertical: 4 }}>
              <Txt variant="tiny" tone="ink3">
                ⋯ line {row.text}
              </Txt>
            </View>
          );
        }
        if (row.kind === "note") {
          return (
            <Txt key={i} variant="small" tone="ink2" style={{ paddingHorizontal: space.lg, paddingVertical: 8 }}>
              {row.text}
            </Txt>
          );
        }
        const no = row.kind === "del" ? row.oldNo : row.newNo;
        const md = lines?.[i];
        const code = tokens?.[i] ?? [];
        return (
          <View key={i} accessible accessibilityLabel={`${KIND_WORDS[row.kind]}${no ? `, line ${no}` : ""}: ${row.text.trim() ? row.text : "blank"}`} style={{ flexDirection: "row", backgroundColor: washOf(row.kind, colors, false) }}>
            {gutter > 0 && number(row.oldNo, row)}
            {gutter > 0 && number(row.newNo, row)}
            {md ? (
              <View style={{ flex: 1, paddingLeft: 8, paddingRight: space.lg }}>
                <MdText line={md} colors={colors} />
              </View>
            ) : (
              <Text selectable style={[scale.mono, { color: row.kind === "ctx" ? colors.ink2 : colors.ink, paddingLeft: 8, paddingRight: space.lg }]}>
                {code.length === 0 || row.text === ""
                  ? row.text || " "
                  : code.map((t, j) => {
                      const colour = codeColour(t.kind, colors);
                      return colour ? (
                        <Text key={j} style={{ color: colour }}>
                          {t.text}
                        </Text>
                      ) : (
                        t.text
                      );
                    })}
              </Text>
            )}
          </View>
        );
      })}
      {shown.length < rows.length && (
        <View style={{ paddingHorizontal: space.lg, paddingTop: 8 }}>
          <Button label={`Show the other ${rows.length - shown.length} lines`} kind="ghost" onPress={() => setAll(true)} />
        </View>
      )}
    </View>
  );
  return markdown ? body : <ScrollView horizontal showsHorizontalScrollIndicator={false}>{body}</ScrollView>;
}
