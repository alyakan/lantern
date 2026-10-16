import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DiffOnMount, OnMount } from "@monaco-editor/react";
import { basename } from "../lib/diff";
import { commentId, kindOf, lineText, newLineOf, removedBlockAfter, type CommentControls, type LineChange } from "../lib/diffComments";
import { CommentBox, CommentNote, lineLabel } from "./DiffComments";

type CodeEditor = Parameters<OnMount>[0];
type DiffEd = Parameters<DiffOnMount>[0];
type Monaco = Parameters<OnMount>[1];

/** What the comments hang on: a diff (side by side or unified), or one editor showing a file that was created or deleted. */
export type Surface = { kind: "diff"; diff: DiffEd; split: boolean } | { kind: "whole"; editor: CodeEditor; side: "new" | "old" };

/** The editor's line height (FullDiff's option), for finding a removed line inside the block unified view draws. */
export const LINE_HEIGHT = 19;

/** Monaco's MouseTargetType, for the parts of an editor a line can be pointed at. */
const T = { gutterZone: 5, contentZone: 8, lineParts: [2, 3, 4, 6, 7] };

/** Which editor a line was in: a diff's new side, its old side (side by side only), or the one editor of a whole file. */
type Role = "modified" | "original" | "whole";
/** A line that can take a comment, and where its button goes (pixels from the top left of the diff). */
interface Anchor {
  side: "new" | "old";
  line: number;
  top: number;
  left: number;
  height: number;
}
/** A comment being written. */
interface Draft {
  side: "new" | "old";
  line: number;
}

/**
 * Comments on a diff's lines, over the Monaco editors: a "+" in the gutter of the line the pointer (or the cursor) is on,
 * the box a comment is written in, and each comment as a note under its line. The notes are Monaco view zones, so the
 * code moves down for them. Every line number here is the one a comment is stored with: the new file's for added and
 * unchanged lines, the old file's for removed ones.
 */
export function DiffCommentLayer({ path, original, modified, surface, monaco, comments }: { path: string; original: string; modified: string; surface: Surface; monaco: Monaco; comments: CommentControls }) {
  const root = useRef<HTMLDivElement>(null);
  const where = basename(path);
  const [changes, setChanges] = useState<LineChange[] | null>(null);
  const [hover, setHover] = useState<Anchor | null>(null);
  const [cursor, setCursor] = useState<Anchor | null>(null);
  const [focused, setFocused] = useState(false);
  // Whether the keys are in use rather than the pointer: only then does the cursor's line get a button of its own.
  const [keys, setKeys] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const leaving = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const whole = surface.kind === "whole";
  const editors = useMemo<{ ed: CodeEditor; role: Role }[]>(() => (surface.kind === "diff" ? [{ ed: surface.diff.getModifiedEditor(), role: "modified" as const }, { ed: surface.diff.getOriginalEditor(), role: "original" as const }] : [{ ed: surface.editor, role: "whole" as const }]), [surface.kind === "diff" ? surface.diff : surface.editor]);
  const split = surface.kind === "diff" && surface.split;
  const wholeSide = surface.kind === "whole" ? surface.side : "new";
  // Read inside the editors' event handlers, which are set up once.
  const live = useRef({ changes, split, original, modified, wholeSide });
  live.current = { changes, split, original, modified, wholeSide };

  // A comment half written belongs to the file it was started in.
  useEffect(() => setDraft(null), [path]);

  // The diff's changed lines, read again each time Monaco has worked it out.
  useEffect(() => {
    if (surface.kind !== "diff") return;
    const read = () => setChanges(surface.diff.getLineChanges() ?? null);
    read();
    const d = surface.diff.onDidUpdateDiff(read);
    return () => d.dispose();
  }, [surface.kind === "diff" ? surface.diff : null]);

  // Each editor's notes are drawn over it, in a box of the editor's size and place, so one scrolled out of sight is cut off.
  // They aren't drawn inside the editor: its lines sit over its zones and would take the clicks.
  const [clips, setClips] = useState<Map<CodeEditor, HTMLDivElement> | null>(null);
  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const made = new Map<CodeEditor, HTMLDivElement>();
    const stops: (() => void)[] = [];
    for (const { ed } of editors) {
      const clip = document.createElement("div");
      clip.className = "diff-comment-clip";
      host.appendChild(clip);
      made.set(ed, clip);
      const fit = () => {
        const frame = host.getBoundingClientRect();
        const box = ed.getDomNode()?.getBoundingClientRect();
        if (box) Object.assign(clip.style, { left: `${box.left - frame.left}px`, top: `${box.top - frame.top}px`, width: `${box.width}px`, height: `${box.height}px` });
      };
      fit();
      const size = new ResizeObserver(fit);
      size.observe(host);
      const dom = ed.getDomNode();
      if (dom) size.observe(dom);
      const layout = ed.onDidLayoutChange(fit);
      stops.push(() => size.disconnect(), () => layout.dispose(), () => clip.remove());
    }
    setClips(made);
    return () => {
      stops.forEach((stop) => stop());
      setClips(null);
    };
  }, [editors]);

  /** The line of `role`'s editor that `line` stands for, as a comment could be made on it (null: not offered there). */
  const lineFor = (role: Role, line: number): { side: "new" | "old"; line: number } | null => {
    const { changes, split, wholeSide } = live.current;
    if (role === "whole") return { side: wholeSide, line };
    if (!changes) return null;
    if (role === "modified") return { side: "new", line };
    // Side by side, the old side offers the removed lines; the unchanged ones are on the new side too.
    return split && changes.some((c) => c.originalEndLineNumber > 0 && line >= c.originalStartLineNumber && line <= c.originalEndLineNumber) ? { side: "old", line } : null;
  };

  /** Where the button goes for a line of an editor; null when the line isn't on screen. */
  const anchorOf = (ed: CodeEditor, side: "new" | "old", line: number): Anchor | null => {
    const frame = root.current?.getBoundingClientRect();
    const box = ed.getDomNode()?.getBoundingClientRect();
    const at = ed.getScrolledVisiblePosition({ lineNumber: line, column: 1 });
    if (!frame || !box || !at || at.top < -at.height || at.top > box.height) return null;
    return { side, line, top: box.top - frame.top + at.top, left: box.left - frame.left, height: at.height };
  };

  /** The removed line under a point of a unified diff, in the block Monaco draws for the removals; null if it isn't over one. */
  const removedAt = (ed: CodeEditor, e: Parameters<Parameters<CodeEditor["onMouseMove"]>[0]>[0]): Anchor | null => {
    const { changes } = live.current;
    const target = e.target;
    // The zone is between the line before it (none: it is above the first) and the line after.
    const detail = "detail" in target ? (target.detail as unknown) : null;
    const zone = detail && typeof detail === "object" && "positionBefore" in detail ? { after: (detail as { positionBefore: { lineNumber: number } | null }).positionBefore?.lineNumber ?? 0 } : null;
    if (!changes || !zone || (target.type !== T.gutterZone && target.type !== T.contentZone)) return null;
    const block = target.element?.closest<HTMLElement>(".view-lines.line-delete, .inline-deleted-margin-view-zone");
    const change = changes.find((c) => c.originalEndLineNumber > 0 && removedBlockAfter(c.originalStartLineNumber, [c]) === zone.after);
    const frame = root.current?.getBoundingClientRect();
    if (!block || !change || !frame) return null;
    const rect = block.getBoundingClientRect();
    const row = Math.floor((e.event.posy - rect.top) / LINE_HEIGHT);
    const line = change.originalStartLineNumber + row;
    if (row < 0 || line > change.originalEndLineNumber) return null;
    const box = ed.getDomNode()?.getBoundingClientRect();
    if (!box) return null;
    return { side: "old", line, top: rect.top - frame.top + row * LINE_HEIGHT, left: box.left - frame.left, height: LINE_HEIGHT };
  };

  useEffect(() => {
    const stops: { dispose: () => void }[] = [];
    for (const { ed, role } of editors) {
      stops.push(
        ed.onMouseMove((e) => {
          clearTimeout(leaving.current);
          const t = e.target;
          const line = t.position?.lineNumber;
          const mapped = line !== undefined && T.lineParts.includes(t.type) ? lineFor(role, line) : null;
          setHover(mapped ? anchorOf(ed, mapped.side, mapped.line) : role === "modified" && !live.current.split ? removedAt(ed, e) : null);
        }),
        // The pointer going to the button leaves the editor too: the button keeps the line for a moment.
        ed.onMouseLeave(() => {
          clearTimeout(leaving.current);
          leaving.current = setTimeout(() => setHover(null), 150);
        }),
        ed.onDidScrollChange(() => {
          setHover(null);
          showCursor(role);
        }),
        ed.onDidChangeCursorPosition(() => showCursor(role)),
        ed.onDidFocusEditorText(() => showCursor(role)),
      );
      // "C" on the line the cursor is on: a comment there, from the keyboard. Only while the editor's own text has focus,
      // so it isn't taken from the box a comment is written in.
      const key = monaco?.KeyCode?.KeyC;
      if (key !== undefined) ed.addCommand(key, () => commentAtCursor(role, ed), "editorTextFocus");
    }
    return () => {
      stops.forEach((s) => s.dispose());
      clearTimeout(leaving.current);
    };
  }, [editors]);

  // The cursor's line: where the button is for someone using the keyboard.
  const showCursor = (role: Role) => {
    const ed = editors.find((x) => x.role === role)?.ed;
    const pos = ed?.getPosition();
    if (!ed || !pos) return;
    const m = lineFor(role, pos.lineNumber);
    setCursor(m ? anchorOf(ed, m.side, m.line) : null);
  };
  const commentAtCursor = (role: Role, ed: CodeEditor) => {
    const line = ed.getPosition()?.lineNumber;
    const { changes } = live.current;
    if (line === undefined) return;
    const m = lineFor(role, line) ?? (role === "original" && changes ? { side: "new" as const, line: newLineOf(line, changes) } : null);
    if (m) setDraft(m);
  };

  // The focus being anywhere in the diff pane shows the cursor's button, so Tab from the editor reaches it.
  useEffect(() => {
    const pane = root.current?.parentElement;
    if (!pane) return;
    const into = () => setFocused(true);
    const out = (e: FocusEvent) => !pane.contains(e.relatedTarget as Node | null) && setFocused(false);
    const key = () => setKeys(true);
    const point = () => setKeys(false);
    pane.addEventListener("focusin", into);
    pane.addEventListener("focusout", out);
    pane.addEventListener("keydown", key);
    pane.addEventListener("pointerdown", point);
    return () => {
      pane.removeEventListener("focusin", into);
      pane.removeEventListener("focusout", out);
      pane.removeEventListener("keydown", key);
      pane.removeEventListener("pointerdown", point);
    };
  }, []);

  const shown = draft ? null : (hover ?? (focused && keys ? cursor : null));
  const textOf = (side: "new" | "old", line: number) => lineText(side === "old" ? live.current.original : live.current.modified, line);

  /** Where a comment's note goes: the editor, the line it comes after, and its place among the zones after that line. */
  const placeFor = (side: "new" | "old", line: number, extra = 0): { ed: CodeEditor; after: number; ordinal: number } | null => {
    const by = (role: Role) => editors.find((e) => e.role === role)?.ed;
    if (whole) return { ed: editors[0].ed, after: line, ordinal: 100 + extra };
    const modifiedEd = by("modified");
    if (side === "new") return modifiedEd ? { ed: modifiedEd, after: line, ordinal: 100 + extra } : null;
    if (split) {
      const orig = by("original");
      return orig ? { ed: orig, after: line, ordinal: 100 + extra } : null;
    }
    if (!modifiedEd || !changes) return null;
    // Unified: below the block of removed lines it belongs to (Monaco's own is ordinal 10000), or, if the line isn't
    // removed in this view, under the line it is a copy of.
    const block = removedBlockAfter(line, changes);
    return block !== null ? { ed: modifiedEd, after: block, ordinal: 20000 + extra } : { ed: modifiedEd, after: newLineOf(line, changes), ordinal: 100 + extra };
  };

  const draftPlace = draft && placeFor(draft.side, draft.line, 50);
  const mine = comments.items.filter((c) => c.path === path && !c.outdated);
  const add = (text: string) => {
    if (!draft) return;
    const { side, line } = draft;
    const kind = side === "old" ? "removed" : whole ? "added" : kindOf("new", line, changes ?? []);
    comments.update((all) => [...all, { id: commentId(), path, side, line, lineText: textOf(side, line), kind, text }]);
    setDraft(null);
    draftPlace?.ed.focus();
  };
  const draftLabel = draft ? `Comment on ${lineLabel(draft).toLowerCase()} of ${where}` : "";

  return (
    <div className="diff-comment-layer" ref={root}>
      {shown && (
        <button
          type="button"
          className="diff-comment-add"
          style={{ top: shown.top + (shown.height - 18) / 2, left: shown.left + 3 }}
          aria-label={`Comment on ${lineLabel(shown).toLowerCase()} of ${where}`}
          title="Comment on this line (C)"
          onMouseEnter={() => clearTimeout(leaving.current)}
          onMouseLeave={() => setHover(null)}
          onClick={() => {
            setDraft({ side: shown.side, line: shown.line });
            setHover(null);
          }}
        >
          +
        </button>
      )}
      {mine.map((c) => {
        const p = placeFor(c.side, c.line);
        return (
          p && (
            <Zone key={c.id} editor={p.ed} clip={clips?.get(p.ed)} after={p.after} ordinal={p.ordinal}>
              <CommentNote
                comment={c}
                where={where}
                quote={c.side === "old" && !split && !whole}
                onEdit={(text) => comments.update((all) => all.map((x) => (x.id === c.id ? { ...x, text } : x)))}
                onDelete={() => comments.update((all) => all.filter((x) => x.id !== c.id))}
              />
            </Zone>
          )
        );
      })}
      {draft && draftPlace && (
        <Zone key="draft" editor={draftPlace.ed} clip={clips?.get(draftPlace.ed)} after={draftPlace.after} ordinal={draftPlace.ordinal}>
          <CommentBox
            label={draftLabel}
            onSave={add}
            onCancel={() => {
              setDraft(null);
              draftPlace.ed.focus();
            }}
          />
        </Zone>
      )}
    </div>
  );
}

/**
 * A note under a line. The editor makes room for it (an empty view zone, as tall as the note), and the note itself is drawn
 * over that room in `clip`, following the zone as the code scrolls; that way it is an ordinary part of the page, which can
 * be clicked, typed in and read by a screen reader.
 */
function Zone({ editor, clip, after, ordinal, children }: { editor: CodeEditor; clip: HTMLElement | undefined; after: number; ordinal: number; children: ReactNode }) {
  const [note] = useState(() => {
    const el = document.createElement("div");
    el.className = "diff-comment-zone";
    return el;
  });
  useEffect(() => {
    if (!clip) return;
    clip.appendChild(note);
    const spec = {
      afterLineNumber: after,
      ordinal,
      domNode: document.createElement("div"),
      heightInPx: 60,
      onDomNodeTop: (top: number) => place(top),
    };
    let id = "";
    let at = -1e6;
    // Over the room its zone has: as wide as the editor's text area (it doesn't scroll sideways with the code), `top` into the editor.
    function place(top: number) {
      at = top;
      const info = editor.getLayoutInfo();
      note.style.top = `${top}px`;
      note.style.left = `${info.contentLeft}px`;
      note.style.width = `${Math.max(120, info.contentWidth - 4)}px`;
      // Out of sight, it is still laid out, so its height is known before it scrolls in.
      note.style.visibility = top < -1e5 ? "hidden" : "visible";
    }
    editor.changeViewZones((a) => {
      id = a.addZone(spec);
    });
    const fit = () => {
      const h = note.offsetHeight;
      if (h > 0 && h !== spec.heightInPx) {
        spec.heightInPx = h;
        editor.changeViewZones((a) => a.layoutZone(id));
      }
    };
    const size = new ResizeObserver(fit);
    size.observe(note);
    // The wheel over a note scrolls the code, as it does anywhere else over the editor.
    const wheel = (e: WheelEvent) => {
      editor.setScrollTop(editor.getScrollTop() + e.deltaY);
      editor.setScrollLeft(editor.getScrollLeft() + e.deltaX);
      e.preventDefault();
    };
    note.addEventListener("wheel", wheel, { passive: false });
    const layout = editor.onDidLayoutChange(() => place(at));
    return () => {
      size.disconnect();
      note.removeEventListener("wheel", wheel);
      note.remove();
      // The editor may already be gone: the diff closing disposes it before this runs.
      try {
        layout.dispose();
        editor.changeViewZones((a) => a.removeZone(id));
      } catch {
        // Nothing left to take the zone out of.
      }
    };
  }, [editor, clip, after, ordinal]);
  return createPortal(children, note);
}
