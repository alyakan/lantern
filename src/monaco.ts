import * as monaco from "monaco-editor/editor/editor.api";
// The language services load this anyway the first time a TypeScript, JSON, CSS or HTML file opens: every editor feature,
// with the services some of them need. Editors made before that point would have no such services, and one made after
// it fails to set up (no suggestions, console errors). So it loads first, and every editor gets the same set.
import "monaco-editor/internal/common/workers";
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
import { jsonDefaults } from "monaco-editor/language/json/monaco.contribution";
import "monaco-editor/language/css/monaco.contribution";
import "monaco-editor/language/html/monaco.contribution";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import TypeScriptWorker from "monaco-editor/language/typescript/ts.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import { loader } from "@monaco-editor/react";
import { onThemeChange, pageIsDark, readColors } from "./lib/theme";
import { EDITOR_TOKENS, FALLBACK_TOKENS, monacoTheme, syntaxFor } from "./lib/monacoTheme";
import type { ThemeId } from "./lib/themes";

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

// tsconfig.json, .eslintrc and VS Code's settings are JSON with comments and trailing commas; flagging those would put
// errors on files that are fine, so only real syntax mistakes are reported.
jsonDefaults.setDiagnosticsOptions({ validate: true, allowComments: true, comments: "ignore", trailingCommas: "ignore" });

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

/**
 * Defines the editor theme for the light or dark that's on, from the page's own colour tokens (see lib/monacoTheme.ts),
 * so every app theme has its editor, and puts it on. Defining a theme again restyles the editors that show it.
 */
function defineEditorTheme(): void {
  const dark = pageIsDark();
  const colors = { ...FALLBACK_TOKENS[dark ? "dark" : "light"], ...readColors(EDITOR_TOKENS) };
  const name = dark ? DARK_THEME : LIGHT_THEME;
  monaco.editor.defineTheme(name, monacoTheme(colors, dark, syntaxFor(document.documentElement.dataset.theme as ThemeId | undefined, dark)));
  monaco.editor.setTheme(name);
}
defineEditorTheme();
onThemeChange(defineEditorTheme);

/** Code as highlighted HTML (Monaco's own escaping), in the theme's source colours; for code blocks in Claude's text. */
export async function colorize(code: string, language: string, dark: boolean): Promise<string> {
  // The token colours come from the current theme's stylesheet; the app shows one theme at a time.
  monaco.editor.setTheme(dark ? DARK_THEME : LIGHT_THEME);
  return monaco.editor.colorize(code, language, { tabSize: 2 });
}
