import type { EditInfo } from "../store";
import { countChanges, relativeTo } from "../lib/diff";

export function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="counts">
      {added > 0 && <span className="added">+{added}</span>}
      {removed > 0 && <span className="removed">−{removed}</span>}
    </span>
  );
}

/** `counts` overrides the edit's own +/−, e.g. when several edits to one file are shown as one line. */
export function EditLine({ edit, counts, folder, onOpen }: { edit: EditInfo; counts?: { added: number; removed: number }; folder: string | null; onOpen: (path: string) => void }) {
  const { added, removed } = counts ?? countChanges(edit.hunks);
  return (
    <button className="edit-line" title="Show in the review panel" onClick={() => onOpen(edit.path)}>
      <span className="edit-icon" aria-hidden>
        ✎
      </span>
      <span className="edit-path">{relativeTo(edit.path, folder)}</span>
      {edit.created && <span className="tag">new</span>}
      <Counts added={added} removed={removed} />
    </button>
  );
}
