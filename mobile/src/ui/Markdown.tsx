import { createContext, Fragment, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Linking, ScrollView, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { parseMarkdown, plainText, type Align, type Block, type Span } from "../view/markdown";
import { foldOf, FOLDED_LINES, highlight, type TokenKind } from "../view/highlight";
import { hasMark, markTokens, splitMarked } from "../view/mark";
import { useAccent } from "./accent";
import { fonts, radius, type as scale, useColors, type Palette } from "./theme";
import { Txt } from "./components";
import { PressScale } from "./motion";

/** The colour of the words: ink on the page, night or white on a dark background, on-ink on an ink one (your own message). */
type Tone = "ink" | "night" | "white" | "on-ink";

/** What a tone's surroundings look like: a raised box, a faint wash behind code, a hairline, and the colour of code. */
function look(tone: Tone, colors: Palette) {
  if (tone === "ink") return { raised: colors.paper, wash: colors.wash, line: colors.rule, code: colors.ink, label: "ink3" as const };
  if (tone === "on-ink") return { raised: `${colors.onInk}1f`, wash: `${colors.onInk}1f`, line: `${colors.onInk}30`, code: colors.onInk, label: "on-ink" as const };
  return { raised: colors.nightRaised, wash: colors.nightRaised, line: colors.nightLine, code: colors.white, label: "night" as const };
}

/** What a chat search looks for, in the soft highlighter wash with ink words on it (a bubble's own words would be lost on it). */
function useHit() {
  const colors = useColors();
  return { backgroundColor: colors.hiSoft, color: colors.ink };
}

/** Plain text with what a chat search looks for marked: just the text when nothing is searched. */
export function Marked({ text, mark }: { text: string; mark?: string }) {
  const hit = useHit();
  if (!mark) return <>{text}</>;
  return (
    <>
      {splitMarked(text, mark).map((p, i) =>
        p.hit ? (
          <Text key={i} style={hit}>
            {p.text}
          </Text>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

/** The files a message's turn edited, and what a tap on one named in its words does (opens its diff). */
const FileLinks = createContext<{ files: string[]; onFile: (path: string) => void } | null>(null);

/** The edited file a bit of code in the words names: the whole path, or its end ("home.ts", "view/home.ts", "home.ts:42"). */
export function fileNamed(code: string, files: string[]): string | null {
  const name = code.trim().replace(/:\d+(?::\d+)?$/, "");
  if (!name || /\s/.test(name)) return null;
  return files.find((f) => f === name || f.endsWith(`/${name.replace(/^\.?\//, "")}`)) ?? null;
}

function Spans({ spans, tone, mark }: { spans: Span[]; tone: Tone; mark?: string }) {
  const accent = useAccent();
  const colors = useColors();
  const hit = useHit();
  const links = useContext(FileLinks);
  return (
    <>
      {spans.map((s, i) => {
        switch (s.kind) {
          case "code": {
            const file = links ? fileNamed(s.text, links.files) : null;
            return (
              <Text
                key={i}
                accessibilityRole={file ? "link" : undefined}
                accessibilityHint={file ? "Shows what changed in this file" : undefined}
                onPress={file ? () => links?.onFile(file) : undefined}
                style={[{ fontFamily: fonts.mono, fontSize: 13, backgroundColor: look(tone, colors).wash }, file ? { color: accent, textDecorationLine: "underline", textDecorationStyle: "dotted" } : null]}
              >
                {mark
                  ? splitMarked(s.text, mark).map((p, j) => (
                      <Text key={j} style={p.hit ? hit : undefined}>
                        {p.text}
                      </Text>
                    ))
                  : s.text}
              </Text>
            );
          }
          case "bold":
            return (
              <Text key={i} style={{ fontWeight: "700" }}>
                {s.spans ? <Spans spans={s.spans} tone={tone} mark={mark} /> : <Marked text={s.text} mark={mark} />}
              </Text>
            );
          case "italic":
            return (
              <Text key={i} style={{ fontStyle: "italic" }}>
                {s.spans ? <Spans spans={s.spans} tone={tone} mark={mark} /> : <Marked text={s.text} mark={mark} />}
              </Text>
            );
          case "strike":
            return (
              <Text key={i} style={{ textDecorationLine: "line-through", opacity: 0.7 }}>
                {s.spans ? <Spans spans={s.spans} tone={tone} mark={mark} /> : <Marked text={s.text} mark={mark} />}
              </Text>
            );
          case "link":
            return (
              <Text key={i} accessibilityRole="link" style={{ color: accent, textDecorationLine: "underline" }} onPress={() => void Linking.openURL(s.url).catch(() => {})}>
                <Marked text={s.text} mark={mark} />
              </Text>
            );
          default:
            return mark ? <Marked key={i} text={s.text} mark={mark} /> : s.text;
        }
      })}
    </>
  );
}

/** A task box in a list: empty, or filled with a check. */
function TaskBox({ checked }: { checked: boolean }) {
  const colors = useColors();
  return (
    <View accessible accessibilityRole="checkbox" accessibilityState={{ checked }} style={{ width: 17, height: 17, marginTop: 2, borderRadius: 5, borderWidth: 1.5, borderColor: checked ? colors.go : colors.ink3, backgroundColor: checked ? colors.go : "transparent", alignItems: "center", justifyContent: "center" }}>
      {checked && <View accessibilityElementsHidden style={{ width: 9, height: 5, marginTop: -2, borderLeftWidth: 2, borderBottomWidth: 2, borderColor: colors.white, transform: [{ rotate: "-45deg" }] }} />}
    </View>
  );
}

/** What each kind of token is coloured, for code on the page (your own message and the night screens keep it plain). */
function tokenColour(kind: TokenKind, colors: Palette): string | undefined {
  switch (kind) {
    case "keyword":
      return colors.cobalt;
    case "string":
      return colors.go;
    case "comment":
    case "meta":
      return colors.ink3;
    case "number":
      return colors.isDark ? "#e0a458" : "#a15c00";
    case "add":
      return colors.go;
    case "del":
      return colors.stop;
    default:
      return undefined;
  }
}

/** A code block: the language and a Copy on top, the code below (it scrolls sideways rather than wrapping), a long one folded until opened. */
function CodeBlock({ lang, text, tone, mark }: { lang: string; text: string; tone: Tone; mark?: string }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = () => {
    void Promise.resolve(Clipboard.setStringAsync(text)).catch(() => {});
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  const colors = useColors();
  const l = look(tone, colors);
  const { lines: total, folds } = useMemo(() => foldOf(text), [text]);
  // Colour only on the page itself: on an ink bubble or the night screens the words stay one colour, as they always were.
  const lines = useMemo(() => highlight(text, tone === "ink" ? lang : ""), [text, lang, tone]);
  // What a search looks for in the folded part opens it: a match you can't see is no match to step to.
  const found = !!mark && folds && lines.slice(FOLDED_LINES).some((l) => hasMark(l.map((t) => t.text).join(""), mark));
  const folded = folds && !open && !found;
  const shown = folded ? lines.slice(0, FOLDED_LINES) : lines;
  const hit = useHit();
  return (
    <View style={{ backgroundColor: l.raised, borderRadius: radius.inner, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingLeft: 12, paddingRight: 6, minHeight: 30 }}>
        <Txt variant="tiny" tone={l.label} style={{ fontWeight: "700" }}>
          {lang}
        </Txt>
        <PressScale accessibilityRole="button" accessibilityLabel={copied ? "Copied" : "Copy code"} onPress={copy} hitSlop={6} haptic="light" scaleTo={0.92} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Txt variant="tiny" tone={copied ? "go" : "cobalt"} style={{ fontWeight: "700" }}>
            {copied ? "Copied" : "Copy"}
          </Txt>
        </PressScale>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: folds ? 6 : 12 }}>
        <Text selectable style={[scale.mono, { color: l.code }]}>
          {shown.map((line, i) => (
            <Fragment key={i}>
              {i > 0 ? "\n" : ""}
              {(mark ? markTokens(line, mark) : line.map((t) => ({ ...t, hit: false }))).map((t, j) => {
                const colour = tokenColour(t.kind, colors);
                return colour || t.hit ? (
                  <Text key={j} style={t.hit ? hit : { color: colour }}>
                    {t.text}
                  </Text>
                ) : (
                  t.text
                );
              })}
            </Fragment>
          ))}
        </Text>
      </ScrollView>
      {folds && (
        <PressScale accessibilityRole="button" accessibilityLabel={folded ? `Show ${total - FOLDED_LINES} more lines of code` : "Show less code"} accessibilityState={{ expanded: !folded }} onPress={() => setOpen((o) => !o)} haptic="select" scaleTo={0.97} style={{ paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: l.line }}>
          <Txt variant="tiny" tone="cobalt" style={{ fontWeight: "700" }}>
            {folded ? `Show ${total - FOLDED_LINES} more lines` : "Show less"}
          </Txt>
        </PressScale>
      )}
    </View>
  );
}

/** What a column of a table needs, from what is longest in it: wide enough to read, narrow enough to leave room for the next. */
const columnWidth = (cells: Span[][]) => Math.round(Math.min(240, Math.max(72, Math.max(...cells.map((c) => plainText(c).length)) * 7.6 + 26)));

/**
 * A table in a box of its own: the header on a tint, a line between rows, columns as wide as their content (up to a
 * limit, past which a cell wraps), aligned as the table says. It scrolls sideways in there when it can't fit, not the page.
 */
function Table({ block, tone, mark }: { block: Extract<Block, { kind: "table" }>; tone: Tone; mark?: string }) {
  const widths = block.head.map((h, c) => columnWidth([h, ...block.rows.map((r) => r[c] ?? [])]));
  const textAlign = (a: Align) => a;
  const colors = useColors();
  const { raised, line } = look(tone, colors);
  const row = (cells: Span[][], key: string, head: boolean, last: boolean) => (
    <View key={key} accessibilityRole={head ? "header" : undefined} style={{ flexDirection: "row", backgroundColor: head ? raised : "transparent", borderBottomWidth: last ? 0 : 1, borderBottomColor: line }}>
      {cells.map((cell, c) => (
        <View key={c} style={{ width: widths[c], paddingHorizontal: 12, paddingVertical: 8, borderLeftWidth: c === 0 ? 0 : 1, borderLeftColor: line, justifyContent: "center" }}>
          <Txt variant="small" tone={tone} selectable style={{ textAlign: textAlign(block.align[c] ?? "left"), fontWeight: head ? "700" : undefined }}>
            <Spans spans={cell} tone={tone} mark={mark} />
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

/** How wide the room for a bullet is: the dot and a little over, so the words aren't left a gap after it (a number gets room for two digits, and more if it needs it). */
const BULLET_WIDTH = 10;

/** Claude's text: headings, paragraphs, lists, tables, quotes, rules and code blocks. Memoised per text, so only a streaming block redraws. */
export const Markdown = memo(function Markdown({ text, tone = "ink", selectable = true, mark, files, onFile }: { text: string; tone?: Tone; /** False where a long press means something else (a message's actions); code and tables stay selectable. */ selectable?: boolean; /** What a chat search looks for: marked wherever it is in the text. Leave it out when not searching, so the text is not drawn again. */ mark?: string; /** The files this message's turn edited: a path to one of them in the words is a link to its diff. */ files?: string[]; onFile?: (path: string) => void }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const colors = useColors();
  const links = useMemo(() => (files?.length && onFile ? { files, onFile } : null), [files, onFile]);
  const body = (
    <View style={{ gap: 8 }}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "heading":
            return b.level <= 2 ? (
              <Txt key={i} variant="heading" tone={tone} selectable={selectable} accessibilityRole="header" style={{ marginTop: 4 }}>
                <Spans spans={b.spans} tone={tone} mark={mark} />
              </Txt>
            ) : (
              <Txt key={i} variant="body" tone={tone} selectable={selectable} accessibilityRole="header" style={{ fontWeight: "700", marginTop: 2 }}>
                <Spans spans={b.spans} tone={tone} mark={mark} />
              </Txt>
            );
          case "paragraph":
            return (
              <Txt key={i} variant="body" tone={tone} selectable={selectable}>
                <Spans spans={b.spans} tone={tone} mark={mark} />
              </Txt>
            );
          case "list":
            return (
              <View key={i} style={{ gap: 4 }}>
                {b.items.map((item, j) => {
                  const m = b.meta[j];
                  return (
                    <View key={j} style={{ flexDirection: "row", gap: m.checked !== null ? 8 : 6, paddingLeft: m.depth * 18 }}>
                      {m.checked !== null ? (
                        <View style={{ width: 22, alignItems: "flex-start" }}>
                          <TaskBox checked={m.checked} />
                        </View>
                      ) : (
                        <Txt variant="body" tone={tone} style={{ minWidth: b.ordered ? 22 : BULLET_WIDTH }}>
                          {m.marker}
                        </Txt>
                      )}
                      <Txt variant="body" tone={m.checked ? "ink3" : tone} selectable={selectable} style={{ flexGrow: 1, flexShrink: 1, textDecorationLine: m.checked ? "line-through" : "none" }}>
                        <Spans spans={item} tone={tone} mark={mark} />
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
                  <Spans spans={b.spans} tone={tone} mark={mark} />
                </Txt>
              </View>
            );
          case "table":
            return <Table key={i} block={b} tone={tone} mark={mark} />;
          case "rule":
            return <View key={i} accessibilityElementsHidden style={{ height: 1, backgroundColor: look(tone, colors).line, marginVertical: 6 }} />;
          case "code":
            return <CodeBlock key={i} lang={b.lang} text={b.text} tone={tone} mark={mark} />;
        }
      })}
    </View>
  );
  return links ? <FileLinks.Provider value={links}>{body}</FileLinks.Provider> : body;
});
