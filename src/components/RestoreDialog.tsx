import { useEffect, useRef, useState } from "react";
import { api, type RestorePlan, type RestoreResult } from "../api";
import { basename, dirOf, relativeTo } from "../lib/diff";

interface Props {
  slot: string;
  folder: string | null;
  /** The message's number, which the restore point was taken before. */
  turn: number;
  /** The message in words, for "how they were just before …" (see `sinceLabel`). */
  since: string;
  /** Why nothing can be restored right now (Claude is working), or null. */
  blocked: string | null;
  onCancel: () => void;
  /** The restore happened (see `api.restoreFiles`); the dialog is done with it. */
  onDone: (result: RestoreResult) => void;
}

/** Files listed before the rest are only counted: a restore after a big turn can cover hundreds. */
const SHOWN = 100;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Asks before "Restore files to here": says what comes back, what Claude made since (it goes to the Trash), and how much
 * is lost, from what the backend finds without writing anything. It also says what a restore leaves alone: the chat, the
 * branch, and anything git ignores.
 */
export function RestoreDialog({ slot, folder, turn, since, blocked, onCancel, onDone }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [plan, setPlan] = useState<RestorePlan | null>(null);
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
    api.restorePreview(slot, turn).then(
      (found) => live && setPlan(found),
      (e) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [slot, turn]);

  const confirm = () => {
    setBusy(true);
    setError(null);
    api.restoreFiles(slot, turn).then(onDone, (e) => {
      setBusy(false);
      setError(String(e));
    });
  };

  const changes = plan ? plan.put_back.length + plan.removed.length : 0;
  const rows = plan ? [...plan.put_back.map((path) => ({ path, tag: null })), ...plan.removed.map((path) => ({ path, tag: "to Trash" }))] : [];
  const title = "Restore files to here?";
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
        <p className="revert-text">The files in this project go back to how they were just before {since}.</p>
        {!plan && !error && <p className="revert-text">Looking at what has changed since…</p>}
        {plan && changes === 0 && plan.skipped.length === 0 && <p className="revert-text">Nothing has changed since then, so there is nothing to restore.</p>}
        {plan && changes > 0 && (
          <>
            <p className="revert-text">
              {[
                plan.put_back.length > 0 ? `${count(plan.put_back.length, "file is", "files are")} put back.` : null,
                plan.removed.length > 0 ? `${count(plan.removed.length, "file", "files")} made since ${plan.removed.length === 1 ? "is" : "are"} moved to the Trash.` : null,
                plan.lines > 0 ? `About ${count(plan.lines, "line", "lines")} of changes made since will be lost.` : null,
              ]
                .filter(Boolean)
                .join(" ")}
            </p>
            <ul className="revert-files" aria-label="Files to restore">
              {rows.slice(0, SHOWN).map((r) => {
                const rel = relativeTo(r.path, folder);
                return (
                  <li key={`${r.tag}:${r.path}`} className="revert-file">
                    <span className="revert-file-name" title={r.path}>
                      {basename(rel)}
                      <span className="menu-row-path">{dirOf(rel)}</span>
                    </span>
                    {r.tag && <span className="tag">{r.tag}</span>}
                  </li>
                );
              })}
              {rows.length > SHOWN && <li className="revert-file">…and {rows.length - SHOWN} more</li>}
            </ul>
          </>
        )}
        {plan && plan.skipped.length > 0 && (
          <p className="revert-warning" role="note">
            Left alone: {plan.skipped.slice(0, 3).map((s) => `${basename(relativeTo(s.path, folder))}: ${s.reason}`).join(" ")}
            {plan.skipped.length > 3 ? ` And ${plan.skipped.length - 3} more.` : ""}
          </p>
        )}
        {plan && changes > 0 && (
          <p className="revert-text">
            Lantern keeps a copy of how things stand now first, so you can undo this right after. Only files change: the conversation stays as it is, and your branch, commits and files git ignores aren't touched.
          </p>
        )}
        {blocked && (
          <p className="revert-warning" role="note">
            {blocked}
          </p>
        )}
        {error && (
          <div className="revert-error" role="alert">
            {error}
          </div>
        )}
        <div className="revert-actions">
          <button onClick={onCancel} disabled={busy}>
            {plan && changes === 0 && plan.skipped.length === 0 ? "Close" : "Cancel"}
          </button>
          <button className="primary" onClick={confirm} disabled={busy || !plan || changes === 0 || !!blocked}>
            {busy ? "Restoring…" : changes > 0 ? `Restore ${count(changes, "file", "files")}` : "Restore"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
