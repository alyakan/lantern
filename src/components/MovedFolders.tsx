import { useId, useState } from "react";
import type { MovedFolder } from "../types";
import { basename } from "../lib/diff";
import { splitPath } from "../lib/relocate";

/** How many moved folders the folder menu lists before "Show all". */
export const MOVED_SHOWN = 3;

/** A path that is cut in the middle when it's too long: the folder's own name always stays, with the full path in the tooltip. */
export function MiddlePath({ path, className = "" }: { path: string; className?: string }) {
  const [head, tail] = splitPath(path);
  return (
    <span className={`mid-path ${className}`.trim()} title={path}>
      <span className="mid-head">{head}</span>
      <span className="mid-tail">{tail}</span>
    </span>
  );
}

interface Handlers {
  onRelocate: (from: MovedFolder) => void;
  onDismiss: (old: string) => void;
}

/**
 * The folder menu's "Folders that moved": one compact row for each folder whose path is gone, from the old path to the
 * place it probably went (or "Choose a folder…"), with Move chats and Not moved. Only the first few show until "Show all".
 */
export function MovedFolders({ moved, onRelocate, onDismiss }: Handlers & { moved: MovedFolder[] }) {
  const [all, setAll] = useState(false);
  const heading = useId();
  const shown = all ? moved : moved.slice(0, MOVED_SHOWN);
  return (
    <section className="moved-section" aria-labelledby={heading}>
      <div className="menu-heading" id={heading}>
        Folders that moved
      </div>
      <p className="moved-hint">These folders are gone. Move their chats to where they are now.</p>
      <ul className="moved-folders">
        {shown.map((m) => (
          <li key={m.old} className="moved-folder">
            <MiddlePath path={m.old} className="moved-old" />
            <div className="moved-to">
              <span className="moved-arrow" aria-hidden>
                →
              </span>
              {m.suggested ? <MiddlePath path={m.suggested} className="moved-new" /> : <span className="moved-new none">Choose a folder…</span>}
              <span className="moved-actions">
                <button role="menuitem" className="primary moved-btn" aria-label={`Move chats from ${m.old}${m.suggested ? ` to ${m.suggested}` : ""}`} onClick={() => onRelocate(m)}>
                  Move chats
                </button>
                <button role="menuitem" className="ghost moved-btn" aria-label={`Not moved: hide the notice for ${basename(m.old)}`} onClick={() => onDismiss(m.old)}>
                  Not moved
                </button>
              </span>
            </div>
          </li>
        ))}
      </ul>
      {moved.length > MOVED_SHOWN && (
        <button role="menuitem" className="link-button moved-all" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${moved.length}…`}
        </button>
      )}
    </section>
  );
}

/** The sidebar's one quiet line under a project whose folder is gone, with the same two actions. */
export function MovedNotice({ moved, label, onRelocate, onDismiss }: Handlers & { moved: MovedFolder; label: string }) {
  return (
    <div className="sb-moved" role="group" aria-label={`${label} may have moved`}>
      <span className="sb-moved-text" title={moved.suggested ? `${moved.old} → ${moved.suggested}` : moved.old}>
        Moved?
      </span>
      <button className="moved-link primary-link" aria-label={`Move chats from ${moved.old}${moved.suggested ? ` to ${moved.suggested}` : ""}`} onClick={() => onRelocate(moved)}>
        Move chats
      </button>
      <button className="moved-link" aria-label={`Not moved: hide the notice for ${label}`} onClick={() => onDismiss(moved.old)}>
        Not moved
      </button>
    </div>
  );
}
