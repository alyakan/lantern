import { useEffect, useRef, useState } from "react";
import { Editor, type OnMount } from "@monaco-editor/react";
import { DARK_THEME, LIGHT_THEME } from "../monaco";
import { api } from "../api";
import { useSlot } from "../lib/slot";
import { languageFor } from "../lib/diff";
import { usePrefersDark } from "../lib/theme";
import { registerFindable } from "../lib/editorFind";
import { stash, stashKey, unstash } from "../lib/editStash";

interface Props {
  path: string;
  /** Scroll to this line and mark it (e.g. where a test failed). */
  line?: number | null;
  /** Changes whenever the files may have (Claude edited something): the file is read again. */
  refreshKey?: number;
  /** Whether there are unsaved edits. */
  onDirty?: (dirty: boolean) => void;
  /** An edit was saved. */
  onSaved?: () => void;
}

/** What the file on disk is now, when it isn't what the edits were made on: its text, or null if it's gone. */
interface Conflict {
  current: string | null;
}

/**
 * A file in the editor. Edits are kept apart from the file on disk (`saved`), ⌘S writes them, and the write is refused
 * if the file changed on disk meanwhile (Claude's edit, git): then you choose between your version and the one there.
 */
export default function FilePreview({ path, line = null, refreshKey = 0, onDirty, onSaved }: Props) {
  const slot = useSlot();
  const key = stashKey(slot, path);
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [saving, setSaving] = useState(false);
  const dark = usePrefersDark();

  // Latest values for the callbacks Monaco and the reads below hold on to.
  const savedRef = useRef(saved);
  const draftRef = useRef(draft);
  savedRef.current = saved;
  draftRef.current = draft;
  const dirty = saved !== null && draft !== saved;

  // Read the file: once on opening (bringing back edits kept when this editor last closed), and again whenever files
  // may have changed. An unedited file follows the disk; an edited one that no longer matches is a conflict.
  useEffect(() => {
    let live = true;
    api.readFile(slot, path).then(
      (disk) => {
        if (!live) return;
        const before = savedRef.current;
        if (before === null) {
          const kept = unstash(key);
          if (kept) {
            setSaved(kept.saved);
            setDraft(kept.draft);
            setRestored(true);
            if (disk !== kept.saved) setConflict({ current: disk });
          } else {
            setSaved(disk);
            setDraft(disk);
          }
        } else if (disk !== before) {
          if (draftRef.current === before) {
            setSaved(disk);
            setDraft(disk);
          } else setConflict({ current: disk });
        }
      },
      (e) => {
        if (!live) return;
        if (savedRef.current !== null && draftRef.current !== savedRef.current) setConflict({ current: null });
        else setError(String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [slot, path, refreshKey]);

  useEffect(() => {
    onDirty?.(dirty);
  }, [dirty]);
  // Closing the editor with edits keeps them (see editStash), and says there are none.
  useEffect(
    () => () => {
      onDirty?.(false);
      if (savedRef.current !== null) stash(key, savedRef.current, draftRef.current);
    },
    [key],
  );

  // One save at a time: a second ⌘S while one is on its way would be sent with the text from before it, and so
  // come back as a conflict with the file's own save.
  const inFlight = useRef(false);
  const save = async (expected: string | null | undefined = savedRef.current) => {
    if (savedRef.current === null || expected === undefined || inFlight.current) return;
    inFlight.current = true;
    const text = draftRef.current;
    setSaving(true);
    setSaveError(null);
    try {
      const r = await api.writeFile(slot, path, text, expected);
      if (r.status === "saved") {
        setSaved(text);
        setConflict(null);
        setRestored(false);
        onSaved?.();
      } else setConflict({ current: r.current });
    } catch (e) {
      setSaveError(String(e));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  // ⌘S saves while the editor has focus.
  const editor = useRef<Parameters<OnMount>[0] | null>(null);
  const marks = useRef<{ clear: () => void } | null>(null);
  const onMount: OnMount = (e, monaco) => {
    editor.current = e;
    registerFindable(e);
    e.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current());
    revealLine(e);
  };
  const revealLine = (e: NonNullable<typeof editor.current>) => {
    marks.current?.clear();
    marks.current = null;
    if (!line) return;
    e.revealLineInCenter(line);
    marks.current = e.createDecorationsCollection([{ range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, options: { isWholeLine: true, className: "whole-removed", marginClassName: "whole-removed-margin" } }]);
  };
  // Another line of the same open file (a mention, a failed test): scroll there without losing edits.
  useEffect(() => {
    if (editor.current) revealLine(editor.current);
  }, [line]);

  if (error) return <div className="empty">{error}</div>;
  if (saved === null) return <div className="empty">Loading…</div>;

  const takeDisk = (current: string) => {
    setSaved(current);
    setDraft(current);
    setConflict(null);
  };
  return (
    <>
      {conflict ? (
        <div className="edit-bar conflict" role="alert">
          <span className="edit-bar-text">{conflict.current === null ? "This file was deleted while you were editing it." : "This file changed on disk while you were editing it."}</span>
          <button onClick={() => void save(conflict.current)} disabled={saving} title={conflict.current === null ? "Create the file again with your text" : "Overwrite the file with your text"}>
            Keep my version
          </button>
          {conflict.current !== null ? (
            <button onClick={() => takeDisk(conflict.current!)}>Use the file on disk</button>
          ) : (
            <button
              onClick={() => {
                setDraft(saved);
                setConflict(null);
                setError("This file was deleted.");
              }}
            >
              Discard my edits
            </button>
          )}
        </div>
      ) : dirty || saveError || restored ? (
        <div className={`edit-bar${saveError ? " failed" : ""}`}>
          <span className="edit-bar-text">{saveError ?? (dirty ? (restored ? "Your unsaved edits are back" : "Unsaved changes") : "Saved")}</span>
          {dirty && (
            <>
              <button onClick={() => setDraft(saved)} disabled={saving}>
                Revert
              </button>
              <button className="primary" onClick={() => void save()} disabled={saving} title="Save (⌘S)">
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          )}
        </div>
      ) : null}
      <div className="diff-body editable-editor">
        <Editor
          height="100%"
          path={path}
          value={draft}
          onChange={(v) => setDraft(v ?? "")}
          language={languageFor(path)}
          theme={dark ? DARK_THEME : LIGHT_THEME}
          onMount={onMount}
          options={{
            minimap: { enabled: false },
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            renderLineHighlight: "line",
            scrollBeyondLastLine: false,
            automaticLayout: true,
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
    </>
  );
}
