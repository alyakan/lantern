import { useEffect, useRef, useState } from "react";
import { DiffEditor, Editor, type DiffOnMount, type OnMount } from "@monaco-editor/react";
import { DARK_THEME, LIGHT_THEME } from "../monaco";
import { api, type ChangeScope } from "../api";
import { useSlot } from "../lib/slot";
import type { FileDiff } from "../types";
import { languageFor } from "../lib/diff";
import { usePrefersDark } from "../lib/theme";
import { registerFindable } from "../lib/editorFind";

/** "inline": one unified view, removals above additions. "split": old and new side by side. */
export type DiffLayout = "inline" | "split";

/** A line to scroll to and flash in the new version; `key` changes for every request. */
export type Reveal = { line: number; key: number } | null;

export default function FullDiff({ path, refreshKey, layout, scope = "session", turn = null, toTurn = null, pr = null, reveal = null }: { path: string; refreshKey: number; layout: DiffLayout; scope?: ChangeScope; turn?: number | null; toTurn?: number | null; pr?: number | null; reveal?: Reveal }) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dark = usePrefersDark();
  const slot = useSlot();

  useEffect(() => {
    let live = true;
    api.getFileDiff(slot, path, scope, turn, toTurn, pr).then(
      (d) => {
        if (live) {
          setDiff(d);
          setError(null);
        }
      },
      (e) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [path, refreshKey, slot, scope, turn, toTurn, pr]);

  if (error) return <div className="empty">{error}</div>;
  if (!diff) return <div className="empty">Loading…</div>;

  // While the next file loads, the last one is still on screen: a line is for the file asked about.
  const current = diff.path === path;
  const theme = dark ? DARK_THEME : LIGHT_THEME;
  const language = languageFor(path);
  // Diffed against an empty file, Monaco shows the empty original as one removed blank line. A file that was created
  // or deleted is shown whole instead, every line marked added or removed.
  const whole = diff.original === "" ? { text: diff.current, kind: "added" as const } : diff.deleted && diff.current === "" ? { text: diff.original, kind: "removed" as const } : null;
  return (
    <div className="diff-body">
      {diff.deleted && <div className="diff-note">This file was deleted.</div>}
      {whole ? <WholeFile key={whole.text} text={whole.text} kind={whole.kind} language={language} theme={theme} reveal={whole.kind === "added" && current ? reveal : null} /> : <Diff original={diff.original} modified={diff.current} language={language} theme={theme} layout={layout} reveal={current ? reveal : null} />}
    </div>
  );
}

type CodeEditor = Parameters<OnMount>[0];

/**
 * Scrolls an editor to the requested line and flashes it. The request stays open for a moment, so a diff that's
 * still being worked out (its unchanged regions folding away) gets the line again once it's done.
 */
function useReveal(reveal: Reveal) {
  const pending = useRef<number | null>(null);
  const flash = useRef<{ clear: () => void } | null>(null);
  const apply = (editor: CodeEditor | null | undefined) => {
    const line = pending.current;
    const lines = editor?.getModel()?.getLineCount() ?? 0;
    if (!editor || line === null || line > lines) return;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    flash.current?.clear();
    const shown = editor.createDecorationsCollection([{ range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, options: { isWholeLine: true, className: "reveal-line" } }]);
    flash.current = shown;
    setTimeout(() => shown.clear(), 1600);
  };
  const queue = () => {
    pending.current = reveal?.line ?? null;
    const asked = pending.current;
    setTimeout(() => {
      if (pending.current === asked) pending.current = null;
    }, 1200);
  };
  return { apply, queue };
}

function Diff({ original, modified, language, theme, layout, reveal }: { original: string; modified: string; language: string; theme: string; layout: DiffLayout; reveal: Reveal }) {
  const editor = useRef<Parameters<DiffOnMount>[0] | null>(null);
  // A finding's line: shown once the diff is worked out, since hidden unchanged regions move lines until then.
  const toLine = useReveal(reveal);
  useEffect(() => {
    toLine.queue();
    toLine.apply(editor.current?.getModifiedEditor());
  }, [reveal?.key]);

  // Inline, Monaco keeps the original editor as a strip of old line numbers beside the new ones, which reads
  // like a second column. One column is enough: removed lines are already marked red.
  const showOldNumbers = () => editor.current?.getOriginalEditor().updateOptions({ lineNumbers: layout === "inline" ? "off" : "on" });
  useEffect(showOldNumbers, [layout]);

  // The React wrapper disposes the diff's text models before the diff widget, which Monaco reports as an error
  // ("TextModel got disposed before DiffEditorWidget model got reset"). So it keeps them, and they're disposed here
  // a tick after unmounting, once the widget is gone.
  const models = useRef<{ dispose: () => void }[]>([]);
  useEffect(
    () => () => {
      const held = models.current;
      setTimeout(() => held.forEach((m) => m.dispose()));
    },
    [],
  );

  return (
    <DiffEditor
      height="100%"
      original={original}
      modified={modified}
      language={language}
      theme={theme}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      onMount={(e) => {
        editor.current = e;
        const m = e.getModel();
        if (m) models.current = [m.original, m.modified];
        showOldNumbers();
        e.onDidUpdateDiff(() => toLine.apply(e.getModifiedEditor()));
        registerFindable(e.getModifiedEditor());
      }}
      options={{
        ...EDITOR_OPTIONS,
        renderSideBySide: layout === "split",
        useInlineViewWhenSpaceIsLimited: false,
        hideUnchangedRegions: { enabled: true },
        renderOverviewRuler: false,
        renderIndicators: false,
        renderMarginRevertIcon: false,
      }}
    />
  );
}

function WholeFile({ text, kind, language, theme, reveal }: { text: string; kind: "added" | "removed"; language: string; theme: string; reveal: Reveal }) {
  const editor = useRef<CodeEditor | null>(null);
  const toLine = useReveal(reveal);
  useEffect(() => {
    toLine.queue();
    toLine.apply(editor.current);
  }, [reveal?.key]);
  const onMount: OnMount = (e) => {
    editor.current = e;
    registerFindable(e);
    toLine.apply(e);
    const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    e.createDecorationsCollection([
      { range: { startLineNumber: 1, startColumn: 1, endLineNumber: Math.max(lines, 1), endColumn: 1 }, options: { isWholeLine: true, className: `whole-${kind}`, marginClassName: `whole-${kind}-margin` } },
    ]);
  };
  return <Editor height="100%" value={text} language={language} theme={theme} onMount={onMount} options={{ ...EDITOR_OPTIONS, renderLineHighlight: "none" }} />;
}

// Shared by the diff and the whole-file view.
const EDITOR_OPTIONS = {
  readOnly: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  glyphMargin: false,
  folding: false,
  // Xcode colours brackets like the code around them and draws no indent guides.
  bracketPairColorization: { enabled: false },
  guides: { indentation: false, bracketPairs: false },
  matchBrackets: "never" as const,
  lineNumbersMinChars: 3,
  fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
  fontSize: 12,
  lineHeight: 19,
  padding: { top: 10, bottom: 10 },
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
};
