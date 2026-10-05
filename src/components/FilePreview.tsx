import { useEffect, useState } from "react";
import { Editor, type OnMount } from "@monaco-editor/react";
import { DARK_THEME, LIGHT_THEME } from "../monaco";
import { api } from "../api";
import { useSlot } from "../lib/slot";
import { languageFor } from "../lib/diff";
import { usePrefersDark } from "../lib/theme";
import { registerFindable } from "../lib/editorFind";

/** `line`: scroll to it and mark it (e.g. where a test failed). */
export default function FilePreview({ path, line = null }: { path: string; line?: number | null }) {
  const slot = useSlot();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dark = usePrefersDark();

  useEffect(() => {
    let live = true;
    setText(null);
    setError(null);
    api.readFile(slot, path).then(
      (t) => live && setText(t),
      (e) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [path, slot]);

  const onMount: OnMount = (e) => {
    registerFindable(e);
    if (!line) return;
    e.revealLineInCenter(line);
    e.createDecorationsCollection([{ range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, options: { isWholeLine: true, className: "whole-removed", marginClassName: "whole-removed-margin" } }]);
  };

  if (error) return <div className="empty">{error}</div>;
  if (text === null) return <div className="empty">Loading…</div>;
  return (
    <div className="diff-body">
      <Editor
        height="100%"
        value={text}
        language={languageFor(path)}
        theme={dark ? DARK_THEME : LIGHT_THEME}
        onMount={onMount}
        options={{
          readOnly: true,
          domReadOnly: true,
          minimap: { enabled: false },
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          renderLineHighlight: "none",
          scrollBeyondLastLine: false,
          glyphMargin: false,
          folding: false,
          lineNumbersMinChars: 3,
          fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
          fontSize: 12,
          lineHeight: 19,
          padding: { top: 10, bottom: 10 },
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
        }}
      />
    </div>
  );
}
