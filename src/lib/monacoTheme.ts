/**
 * Monaco's theme (the diff and file editors, and the highlighted code blocks) from the app's colour tokens, so it follows
 * whichever theme is on. Kept apart from monaco.ts so it can be tested without loading the editor.
 */
import { alpha, ensureContrast } from "./color";
import type { ThemeId } from "./themes";

/** The tokens the editor's colours come from. */
export const EDITOR_TOKENS = ["pane", "sidebar", "field", "text", "muted", "faint", "line", "line-strong", "add", "del", "warn"];

/** Light's and Dark's own values, for a token the page can't be asked for (the editor still needs every colour). */
export const FALLBACK_TOKENS: Record<"light" | "dark", Record<string, string>> = {
  light: { pane: "#ffffff", sidebar: "#f5f5f7", field: "#ffffff", text: "#1d1d1f", muted: "#86868b", faint: "#aeaeb2", line: "#e5e5ea", "line-strong": "#d4d4d9", add: "#1a7f37", del: "#cf222e", warn: "#9a6700" },
  dark: { pane: "#1f1f24", sidebar: "#29292e", field: "#202025", text: "#dfdfe0", muted: "#8e8e93", faint: "#5d5d63", line: "#313137", "line-strong": "#3c3c43", add: "#6bd488", del: "#ff8a93", warn: "#e3b341" },
};

export interface MonacoRule {
  token: string;
  foreground: string;
  fontStyle?: string;
}

export interface MonacoThemeData {
  base: "vs" | "vs-dark";
  inherit: boolean;
  rules: MonacoRule[];
  colors: Record<string, string>;
}

/** Source colours by role: what a theme's code is drawn in. */
interface Syntax {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  type: string;
  tag: string;
  attrName: string;
  attrValue: string;
  regexp: string;
}

// Xcode's Default (Light) and Default (Dark) source colours.
const XCODE_LIGHT: Syntax = { keyword: "#9b2393", string: "#c41a16", number: "#1c00cf", comment: "#5d6c79", type: "#0b4f79", tag: "#9b2393", attrName: "#815f03", attrValue: "#c41a16", regexp: "#c41a16" };
const XCODE_DARK: Syntax = { keyword: "#fc5fa3", string: "#fc6a5d", number: "#d0bf69", comment: "#7f8c98", type: "#5dd8ff", tag: "#fc5fa3", attrName: "#bf8555", attrValue: "#fc6a5d", regexp: "#fc6a5d" };
const TERMINAL: Syntax = { keyword: "#b9f6c9", string: "#ffc933", number: "#ff9a3d", comment: "#3a9a58", type: "#5ac8fa", tag: "#b9f6c9", attrName: "#ffd23f", attrValue: "#ffc933", regexp: "#ff9a3d" };
const SOLARIZED: Syntax = { keyword: "#9cc41e", string: "#2aa198", number: "#e0709f", comment: "#657b83", type: "#d9a520", tag: "#4aa3e8", attrName: "#d9a520", attrValue: "#2aa198", regexp: "#e07a45" };
const NORD: Syntax = { keyword: "#81a1c1", string: "#a3be8c", number: "#b48ead", comment: "#7b88a1", type: "#8fbcbb", tag: "#81a1c1", attrName: "#8fbcbb", attrValue: "#a3be8c", regexp: "#ebcb8b" };

/** The source colours for a theme: its own where it has some, otherwise Xcode's for its light or dark. */
export function syntaxFor(theme: ThemeId | undefined, dark: boolean): Syntax {
  if (theme === "terminal") return TERMINAL;
  if (theme === "solarized") return SOLARIZED;
  if (theme === "nord") return NORD;
  return dark ? XCODE_DARK : XCODE_LIGHT;
}

/** Monaco's theme for these colours (the tokens in EDITOR_TOKENS, as hex): `dark` picks its base. */
export function monacoTheme(c: Record<string, string>, dark: boolean, syntax: Syntax): MonacoThemeData {
  const bg = c.pane;
  // Syntax colours are checked against the editor: a theme's own comment grey may be too faint on its background.
  const fg = (colour: string) => ensureContrast(colour, bg, 4.5).slice(1);
  const text = fg(c.text);
  const ink = (a: number) => alpha(c.text, a);
  const widget = dark ? c.sidebar : c.field;
  const rules: MonacoRule[] = [
    { token: "", foreground: text },
    { token: "keyword", foreground: fg(syntax.keyword), fontStyle: "bold" },
    { token: "string", foreground: fg(syntax.string) },
    { token: "number", foreground: fg(syntax.number) },
    { token: "comment", foreground: fg(syntax.comment) },
    { token: "type", foreground: fg(syntax.type) },
    { token: "type.identifier", foreground: fg(syntax.type) },
    { token: "regexp", foreground: fg(syntax.regexp) },
    { token: "tag", foreground: fg(syntax.tag) },
    { token: "attribute.name", foreground: fg(syntax.attrName) },
    { token: "attribute.value", foreground: fg(syntax.attrValue) },
    { token: "delimiter", foreground: text },
  ];
  const none = "#00000000";
  const brackets = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`editorBracketHighlight.foreground${n}`, c.text]));
  // Diff tints stay faint so the code, not the colour, carries the change.
  const [line, wash] = dark ? [0.08, 0.09] : [0.06, 0.08];
  return {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules,
    colors: {
      "editor.background": bg,
      "editor.foreground": c.text,
      "editorGutter.background": bg,
      "editor.lineHighlightBackground": none,
      "editor.lineHighlightBorder": none,
      "editorLineNumber.foreground": c.faint,
      "editorLineNumber.activeForeground": c.muted,
      "diffEditor.insertedLineBackground": alpha(c.add, line),
      "diffEditor.removedLineBackground": alpha(c.del, line * 0.9),
      "diffEditor.insertedTextBackground": alpha(c.add, wash),
      "diffEditor.removedTextBackground": alpha(c.del, wash),
      "diffEditorGutter.insertedLineBackground": none,
      "diffEditorGutter.removedLineBackground": none,
      "diffEditor.border": c.line,
      "diffEditor.unchangedRegionBackground": c.sidebar,
      "diffEditor.unchangedRegionForeground": c.muted,
      "scrollbarSlider.background": ink(0.08),
      "scrollbarSlider.hoverBackground": ink(0.13),
      // Neutral selection/focus instead of Monaco's default blue.
      "editor.selectionBackground": ink(dark ? 0.15 : 0.12),
      "editor.inactiveSelectionBackground": ink(0.08),
      "editor.selectionHighlightBackground": none,
      "editorCursor.foreground": c.text,
      // Brackets take the plain text colour, like Xcode.
      ...brackets,
      focusBorder: none,
      // Find (⌘F): matches in the review yellow, not Monaco's orange (orange means Claude is working).
      "editor.findMatchBackground": alpha(c.warn, 0.4),
      "editor.findMatchHighlightBackground": alpha(c.warn, 0.18),
      "editor.findMatchBorder": c.warn,
      "editor.rangeHighlightBackground": ink(0.04),
      // The suggestion list, hover and parameter hints: the app's neutral greys, not Monaco's blue selection.
      "editorWidget.background": widget,
      "editorWidget.border": c["line-strong"],
      "editorSuggestWidget.background": widget,
      "editorSuggestWidget.border": c["line-strong"],
      "editorSuggestWidget.selectedBackground": ink(0.11),
      "editorSuggestWidget.highlightForeground": c.text,
      "editorSuggestWidget.focusHighlightForeground": c.text,
      "editorHoverWidget.background": widget,
      "editorHoverWidget.border": c["line-strong"],
      "list.hoverBackground": ink(0.06),
      "list.activeSelectionBackground": ink(0.11),
      "list.activeSelectionForeground": c.text,
      "list.focusBackground": ink(0.11),
      "list.highlightForeground": c.text,
    },
  };
}
