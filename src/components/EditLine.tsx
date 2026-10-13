import { useState } from "react";
import type { EditInfo } from "../store";
import type { Hunk } from "../types";
import { countChanges, lineKind, relativeTo } from "../lib/diff";

/** How many lines of a change show until "Show all". */
export const SHOWN_DIFF_LINES = 60;

export function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="counts">
      {added > 0 && <span className="added">+{added}</span>}
      {removed > 0 && <span className="removed">−{removed}</span>}
    </span>
  );
}

/**
 * An edit's line: a chevron shows its change inline, and the name opens it in the review panel. `counts` overrides the
 * edit's own +/−, e.g. when several edits to one file are shown as one line.
 */
export function EditLine({ edit, counts, folder, onOpen }: { edit: EditInfo; counts?: { added: number; removed: number }; folder: string | null; onOpen: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const { added, removed } = counts ?? countChanges(edit.hunks);
  const name = relativeTo(edit.path, folder);
  return (
    <div className="edit-row">
      <div className="edit-head">
        <button className="edit-toggle" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} the change to ${name}`} onClick={() => setOpen(!open)}>
          <span className="chev" aria-hidden />
        </button>
        <button className="edit-line" title="Show in the review panel" onClick={() => onOpen(edit.path)}>
          <span className="edit-icon" aria-hidden>
            ✎
          </span>
          <span className="edit-path">{name}</span>
          {edit.created && <span className="tag">new</span>}
          <Counts added={added} removed={removed} />
        </button>
      </div>
      {open && <Hunks hunks={edit.hunks} />}
    </div>
  );
}

/** A change's hunks, coloured as the diff view colours them. A long one shows its first lines, then Show all. */
export function Hunks({ hunks }: { hunks: Hunk[] }) {
  const [all, setAll] = useState(false);
  const lines = hunks.flatMap((h) => [
    { text: `@@ -${h.old_start},${h.old_lines} +${h.new_start},${h.new_lines} @@`, meta: true },
    ...h.lines.map((text) => ({ text, meta: false })),
  ]);
  const shown = all ? lines : lines.slice(0, SHOWN_DIFF_LINES);
  return (
    <div className="edit-hunks">
      {/* Scrollable, so focusable (for the keyboard) and named. */}
      <pre className="code-block-colored code-block-diff" role="region" aria-label="Change" tabIndex={0}>
        <code>
          {shown.map((l, i) => (
            <span key={i} className={`diff-line ${l.meta ? "meta" : lineKind(l.text)}`}>
              {l.text || " "}
              {"\n"}
            </span>
          ))}
        </code>
      </pre>
      {!all && lines.length > shown.length && (
        <button className="link-button" onClick={() => setAll(true)}>
          Show all {lines.length} lines
        </button>
      )}
    </div>
  );
}
