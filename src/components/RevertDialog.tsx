import { useEffect, useRef, useState } from "react";
import { api, type RevertOutcome } from "../api";
import type { ChangedFile } from "../store";
import { basename, dirOf, relativeTo } from "../lib/diff";
import { rangeText, type RevertRequest } from "../lib/revert";
import { Counts } from "./EditLine";

interface Props {
  slot: string;
  folder: string | null;
  title: string;
  files: ChangedFile[];
  request: RevertRequest;
  /** The chat's latest turn's number, to find edits made after a range (null: not known). */
  latestTurn: number | null;
  onCancel: () => void;
  /** The backend's answer for each file; the dialog is done with them. */
  onDone: (outcomes: RevertOutcome[]) => void;
}

/** What a file's text was when the dialog opened: the text the user is shown, which the revert checks against. */
type Shown = { text: string | null } | { error: string };

/**
 * Asks before reverting: lists the files with their line counts, and says what happens to the ones Claude created and to
 * any later edits to the same files. Each file's text is read when the dialog opens, so a file changed after that is a
 * conflict, not overwritten.
 */
export function RevertDialog({ slot, folder, title, files: given, request, latestTurn, onCancel, onDone }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  // The files as they were when the dialog opened: a later change to the list doesn't move the dialog's ground.
  const [files] = useState(given);
  const [shown, setShown] = useState<Record<string, Shown> | null>(null);
  const [later, setLater] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || el.open) return;
    // jsdom has no showModal: there, the attribute alone opens it.
    if (el.showModal) el.showModal();
    else el.setAttribute("open", "");
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all(
      files.map(async (f): Promise<[string, Shown]> => {
        if (f.deleted) return [f.path, { text: null }];
        try {
          return [f.path, { text: await api.readFile(slot, f.path) }];
        } catch {
          return [f.path, { error: "It can't be read as text, so it can't be reverted from here." }];
        }
      }),
    ).then((entries) => live && setShown(Object.fromEntries(entries)));
    return () => {
      live = false;
    };
  }, [slot, files]);

  // Edits made after a range, to the same files: they're lost with it. (The last turn has none after it.)
  const { scope, turn, toTurn } = request;
  useEffect(() => {
    if (scope !== "turn" || turn === null || toTurn === null || latestTurn === null || toTurn >= latestTurn) return;
    let live = true;
    api.changeSummary(slot, "turn", toTurn + 1, latestTurn).then(
      (found) => live && setLater(found.map((f) => f.path)),
      () => live && setLater([]),
    );
    return () => {
      live = false;
    };
  }, [slot, scope, turn, toTurn, latestTurn]);
  const overlap = files.filter((f) => later.includes(f.path));
  const warning = overlap.length
    ? `Later messages also edited ${overlap.map((f) => basename(relativeTo(f.path, folder))).join(", ")}. Reverting loses those later edits too.`
    : null;

  // Only files whose current text is known can be sent: the revert checks each against it.
  const revertable = files.filter((f) => {
    const s = shown?.[f.path];
    return s !== undefined && "text" in s;
  });
  const confirm = () => {
    if (!shown) return;
    setBusy(true);
    setError(null);
    const send = revertable.map((f) => ({ path: f.path, expected: (shown[f.path] as { text: string | null }).text }));
    api.revertFiles(slot, request.scope, request.turn, request.toTurn, send).then(
      (outcomes) => onDone(outcomes),
      (e) => {
        setBusy(false);
        setError(String(e));
      },
    );
  };

  const created = files.some((f) => f.created);
  const n = revertable.length;
  return (
    <dialog
      ref={ref}
      className="revert-dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <div className="revert-body">
        <div className="revert-title">{title}</div>
        <p className="revert-text">
          {files.length === 1 ? "This file goes" : `${files.length} files go`} back to how {files.length === 1 ? "it was" : "they were"} {rangeText(request)}.
          {created && " Files Claude created are moved to the Trash, not deleted."}
        </p>
        {warning && (
          <p className="revert-warning" role="note">
            {warning}
          </p>
        )}
        <ul className="revert-files" aria-label="Files to revert">
          {files.map((f) => {
            const rel = relativeTo(f.path, folder);
            const s = shown?.[f.path];
            return (
              <li key={f.path} className="revert-file">
                <span className="revert-file-name" title={f.path}>
                  {basename(rel)}
                  <span className="menu-row-path">{dirOf(rel)}</span>
                </span>
                {f.created && <span className="tag">new</span>}
                {f.deleted && <span className="tag">deleted</span>}
                <Counts added={f.added} removed={f.removed} />
                {s && "error" in s && <span className="revert-file-error">{s.error}</span>}
              </li>
            );
          })}
        </ul>
        {error && (
          <div className="revert-error" role="alert">
            {error}
          </div>
        )}
        <div className="revert-actions">
          <button onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={confirm} disabled={busy || !shown || n === 0}>
            {busy ? "Reverting…" : `Revert ${n} ${n === 1 ? "file" : "files"}`}
          </button>
        </div>
      </div>
    </dialog>
  );
}
