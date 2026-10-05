import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/basic-languages/monaco.contribution"; // Monarch syntax highlighting only; language services are intentionally off for this read-only diff
// The find bar (⌘F), which the bare editor API leaves out.
import "monaco-editor/editor/contrib/find/browser/findController";
// Its buttons are codicons; the bare API doesn't load their font. (By path: the package exports no .css.)
import "../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { loader } from "@monaco-editor/react";

(globalThis as unknown as { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};
loader.config({ monaco });

export const LIGHT_THEME = "lantern-light";
export const DARK_THEME = "lantern-dark";

// Xcode's Default (Light) and Default (Dark) source colours.
const XCODE_LIGHT = [
  { token: "", foreground: "1d1d1f" },
  { token: "keyword", foreground: "9b2393", fontStyle: "bold" },
  { token: "string", foreground: "c41a16" },
  { token: "number", foreground: "1c00cf" },
  { token: "comment", foreground: "5d6c79" },
  { token: "type", foreground: "0b4f79" },
  { token: "type.identifier", foreground: "0b4f79" },
  { token: "regexp", foreground: "c41a16" },
  { token: "tag", foreground: "9b2393" },
  { token: "attribute.name", foreground: "815f03" },
  { token: "attribute.value", foreground: "c41a16" },
  { token: "delimiter", foreground: "1d1d1f" },
];
const XCODE_DARK = [
  { token: "", foreground: "dfdfe0" },
  { token: "keyword", foreground: "fc5fa3", fontStyle: "bold" },
  { token: "string", foreground: "fc6a5d" },
  { token: "number", foreground: "d0bf69" },
  { token: "comment", foreground: "7f8c98" },
  { token: "type", foreground: "5dd8ff" },
  { token: "type.identifier", foreground: "5dd8ff" },
  { token: "regexp", foreground: "fc6a5d" },
  { token: "tag", foreground: "fc5fa3" },
  { token: "attribute.name", foreground: "bf8555" },
  { token: "attribute.value", foreground: "fc6a5d" },
  { token: "delimiter", foreground: "dfdfe0" },
];

// Matches the editor surface in styles.css. Diff tints stay faint so the code, not the colour, carries the change.
monaco.editor.defineTheme(LIGHT_THEME, {
  base: "vs",
  inherit: true,
  rules: XCODE_LIGHT,
  colors: {
    "editor.background": "#ffffff",
    "editorGutter.background": "#ffffff",
    "editor.lineHighlightBackground": "#00000000",
    "editor.lineHighlightBorder": "#00000000",
    "editorLineNumber.foreground": "#aeaeb2",
    "editorLineNumber.activeForeground": "#8c9199",
    "diffEditor.insertedLineBackground": "#1a7f370f",
    "diffEditor.removedLineBackground": "#cf222e0d",
    "diffEditor.insertedTextBackground": "#1a7f3714",
    "diffEditor.removedTextBackground": "#cf222e14",
    "diffEditorGutter.insertedLineBackground": "#00000000",
    "diffEditorGutter.removedLineBackground": "#00000000",
    "diffEditor.border": "#eceef0",
    "diffEditor.unchangedRegionBackground": "#f5f5f7",
    "diffEditor.unchangedRegionForeground": "#8c9199",
    "scrollbarSlider.background": "#00000014",
    "scrollbarSlider.hoverBackground": "#00000022",
    // Neutral selection/focus instead of Monaco's default blue.
    "editor.selectionBackground": "#0000001f",
    "editor.inactiveSelectionBackground": "#00000014",
    "editor.selectionHighlightBackground": "#00000000",
    "editorCursor.foreground": "#1f1f21",
    // Brackets take the plain text colour, like Xcode.
    "editorBracketHighlight.foreground1": "#1d1d1f",
    "editorBracketHighlight.foreground2": "#1d1d1f",
    "editorBracketHighlight.foreground3": "#1d1d1f",
    "editorBracketHighlight.foreground4": "#1d1d1f",
    "editorBracketHighlight.foreground5": "#1d1d1f",
    "editorBracketHighlight.foreground6": "#1d1d1f",
    "focusBorder": "#00000000",
    // Find (⌘F): matches in the review yellow, not Monaco's orange (orange means Claude is working).
    "editor.findMatchBackground": "#b5890055",
    "editor.findMatchHighlightBackground": "#b5890026",
    "editor.findMatchBorder": "#b58900",
    "editor.rangeHighlightBackground": "#0000000a",
  },
});

monaco.editor.defineTheme(DARK_THEME, {
  base: "vs-dark",
  inherit: true,
  rules: XCODE_DARK,
  colors: {
    "editor.background": "#1f1f24",
    "editorGutter.background": "#1f1f24",
    "editor.lineHighlightBackground": "#00000000",
    "editor.lineHighlightBorder": "#00000000",
    "editorLineNumber.foreground": "#5d5d63",
    "editorLineNumber.activeForeground": "#8e8e93",
    "diffEditor.insertedLineBackground": "#3fb95014",
    "diffEditor.removedLineBackground": "#f8514912",
    "diffEditor.insertedTextBackground": "#3fb95016",
    "diffEditor.removedTextBackground": "#f8514916",
    "diffEditorGutter.insertedLineBackground": "#00000000",
    "diffEditorGutter.removedLineBackground": "#00000000",
    "diffEditor.border": "#313137",
    "diffEditor.unchangedRegionBackground": "#29292e",
    "diffEditor.unchangedRegionForeground": "#767c85",
    "scrollbarSlider.background": "#ffffff14",
    "scrollbarSlider.hoverBackground": "#ffffff22",
    // Neutral selection/focus instead of Monaco's default blue.
    "editor.selectionBackground": "#ffffff26",
    "editor.inactiveSelectionBackground": "#ffffff14",
    "editor.selectionHighlightBackground": "#00000000",
    "editorCursor.foreground": "#dfdfe0",
    // Brackets take the plain text colour, like Xcode.
    "editorBracketHighlight.foreground1": "#dfdfe0",
    "editorBracketHighlight.foreground2": "#dfdfe0",
    "editorBracketHighlight.foreground3": "#dfdfe0",
    "editorBracketHighlight.foreground4": "#dfdfe0",
    "editorBracketHighlight.foreground5": "#dfdfe0",
    "editorBracketHighlight.foreground6": "#dfdfe0",
    "focusBorder": "#00000000",
    "editor.findMatchBackground": "#e3b34166",
    "editor.findMatchHighlightBackground": "#e3b3412e",
    "editor.findMatchBorder": "#e3b341",
    "editor.rangeHighlightBackground": "#ffffff0a",
  },
});

/** Code as highlighted HTML (Monaco's own escaping), in the app's Xcode colours; for code blocks in Claude's text. */
export async function colorize(code: string, language: string, dark: boolean): Promise<string> {
  // The token colours come from the current theme's stylesheet; the app shows one theme at a time.
  monaco.editor.setTheme(dark ? DARK_THEME : LIGHT_THEME);
  return monaco.editor.colorize(code, language, { tabSize: 2 });
}
