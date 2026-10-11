import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/basic-languages/monaco.contribution"; // Monarch syntax highlighting for every language
// The find bar (⌘F), which the bare editor API leaves out.
import "monaco-editor/editor/contrib/find/browser/findController";
// What editing a file takes beyond typing: copy and paste, comment toggling, line moves and deletes, word jumps, and
// matching brackets, indentation and multiple cursors.
import "monaco-editor/editor/contrib/clipboard/browser/clipboard";
import "monaco-editor/editor/contrib/comment/browser/comment";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching";
import "monaco-editor/editor/contrib/indentation/browser/indentation";
import "monaco-editor/editor/contrib/multicursor/browser/multicursor";
// Its buttons are codicons; the bare API doesn't load their font. (By path: the package exports no .css.)
import "../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
// Completions: the suggestion list (Monaco also suggests words from the file in any language), docs on hover,
// parameter hints while typing a call, quick fixes, formatting, and stepping through problems.
import "monaco-editor/editor/contrib/suggest/browser/suggestController";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution";
import "monaco-editor/editor/contrib/parameterHints/browser/parameterHints";
import "monaco-editor/editor/contrib/snippet/browser/snippetController2";
import "monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter";
import "monaco-editor/editor/contrib/codeAction/browser/codeActionContributions";
import "monaco-editor/editor/contrib/format/browser/formatActions";
import "monaco-editor/editor/contrib/gotoError/browser/gotoError";
// Real language services, each in its own worker: TypeScript and JavaScript (also what .tsx and .jsx use), JSON, CSS
// (and SCSS, Less) and HTML. Everything else gets highlighting and word suggestions.
import { javascriptDefaults, typescriptDefaults, JsxEmit, ModuleKind, ModuleResolutionKind, ScriptTarget } from "monaco-editor/language/typescript/monaco.contribution";
import "monaco-editor/language/json/monaco.contribution";
import "monaco-editor/language/css/monaco.contribution";
import "monaco-editor/language/html/monaco.contribution";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import TypeScriptWorker from "monaco-editor/language/typescript/ts.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import { loader } from "@monaco-editor/react";

// A worker per language service, made when a file of that language first opens.
(globalThis as unknown as { MonacoEnvironment: { getWorker: (id: string, label: string) => Worker } }).MonacoEnvironment = {
  getWorker: (_id, label) => {
    switch (label) {
      case "typescript":
      case "javascript":
        return new TypeScriptWorker();
      case "json":
        return new JsonWorker();
      case "css":
      case "scss":
      case "less":
        return new CssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new HtmlWorker();
      default:
        return new EditorWorker();
    }
  },
};
loader.config({ monaco });

// How TypeScript reads the files: modern syntax, JSX in .tsx and .jsx, and plain JavaScript checked the same way.
// Problems are limited to syntax errors: with only the files an open file imports to go on (see lib/projectLibs.ts), the
// type checker would report every package import as missing, and a wall of false errors helps nobody. Completions, hover
// and signature help use the full type information regardless.
for (const defaults of [typescriptDefaults, javascriptDefaults]) {
  defaults.setCompilerOptions({
    target: ScriptTarget.ESNext,
    module: ModuleKind.ESNext,
    moduleResolution: ModuleResolutionKind.NodeJs,
    jsx: JsxEmit.ReactJSX,
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    noEmit: true,
    skipLibCheck: true,
  });
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false, noSuggestionDiagnostics: true });
  defaults.setEagerModelSync(true);
}

/**
 * Gives the language service for `language` the project files the open file imports (see collectLibs), so imported
 * names complete and show their docs. Returns what removes them again.
 */
export function addProjectLibs(language: string, libs: { path: string; text: string }[]): () => void {
  const defaults = language === "typescript" ? typescriptDefaults : language === "javascript" ? javascriptDefaults : null;
  if (!defaults) return () => {};
  const handles = libs.map((l) => defaults.addExtraLib(l.text, monaco.Uri.file(l.path).toString()));
  return () => handles.forEach((h) => h.dispose());
}

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
    // The suggestion list, hover and parameter hints: the app's neutral greys, not Monaco's blue selection.
    "editorWidget.background": "#ffffff",
    "editorWidget.border": "#d9dbdf",
    "editorSuggestWidget.background": "#ffffff",
    "editorSuggestWidget.border": "#d9dbdf",
    "editorSuggestWidget.selectedBackground": "#0000001a",
    "editorSuggestWidget.highlightForeground": "#1d1d1f",
    "editorSuggestWidget.focusHighlightForeground": "#1d1d1f",
    "editorHoverWidget.background": "#ffffff",
    "editorHoverWidget.border": "#d9dbdf",
    "list.hoverBackground": "#0000000d",
    "list.activeSelectionBackground": "#0000001a",
    "list.activeSelectionForeground": "#1d1d1f",
    "list.focusBackground": "#0000001a",
    "list.highlightForeground": "#1d1d1f",
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
    "editorWidget.background": "#29292e",
    "editorWidget.border": "#3a3a40",
    "editorSuggestWidget.background": "#29292e",
    "editorSuggestWidget.border": "#3a3a40",
    "editorSuggestWidget.selectedBackground": "#ffffff1f",
    "editorSuggestWidget.highlightForeground": "#ffffff",
    "editorSuggestWidget.focusHighlightForeground": "#ffffff",
    "editorHoverWidget.background": "#29292e",
    "editorHoverWidget.border": "#3a3a40",
    "list.hoverBackground": "#ffffff14",
    "list.activeSelectionBackground": "#ffffff1f",
    "list.activeSelectionForeground": "#ffffff",
    "list.focusBackground": "#ffffff1f",
    "list.highlightForeground": "#ffffff",
  },
});

/** Code as highlighted HTML (Monaco's own escaping), in the app's Xcode colours; for code blocks in Claude's text. */
export async function colorize(code: string, language: string, dark: boolean): Promise<string> {
  // The token colours come from the current theme's stylesheet; the app shows one theme at a time.
  monaco.editor.setTheme(dark ? DARK_THEME : LIGHT_THEME);
  return monaco.editor.colorize(code, language, { tabSize: 2 });
}
