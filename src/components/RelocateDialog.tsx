import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { MovedFolder, RecentFolder, RelocateOptions, RelocateOutcome, RelocationPreview } from "../types";
import { basename, dirOf } from "../lib/diff";

interface Props {
  /** The folder open now: offered as the new place when it isn't the old one. */
  current: string | null;
  /** Where to start, from a "moved?" notice: the old place, and the place it probably went. */
  start: { old: string; suggested: string | null } | null;
  /** The native folder picker; null when cancelled. */
  pickFolder: () => Promise<string | null>;
  onCancel: () => void;
  /** Done with a move: its outcome, for the app to carry the folder's saved state over. */
  onDone: (old: string, next: string, outcome: RelocateOutcome) => void;
}

/** A place the folder may have been: a recent folder that's gone (with where it probably went), or one that exists. */
export interface OldChoice {
  path: string;
  gone: boolean;
  suggested: string | null;
}

/** The old places to choose from: the gone folders first, then the other recent folders. */
export function oldChoices(moved: MovedFolder[], recent: RecentFolder[]): OldChoice[] {
  const gone = moved.map((m) => ({ path: m.old, gone: true, suggested: m.suggested }));
  const listed = new Set(gone.map((c) => c.path));
  return [...gone, ...recent.filter((r) => !listed.has(r.path)).map((r) => ({ path: r.path, gone: false, suggested: null }))];
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

/**
 * Moves a folder's history to where it is now. Asks where it was and where it is, shows what the move finds and what it
 * would carry over, and records it. Nothing is deleted or overwritten: the old session files are copied, never moved.
 */
export function RelocateDialog({ current, start, pickFolder, onCancel, onDone }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [choices, setChoices] = useState<OldChoice[] | null>(null);
  const [old, setOld] = useState<string | null>(start?.old ?? null);
  const [next, setNext] = useState<string | null>(start?.suggested ?? null);
  const [preview, setPreview] = useState<RelocationPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [options, setOptions] = useState<RelocateOptions>({ project_settings: true, memory: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<RelocateOutcome | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || el.open) return;
    // jsdom has no showModal: there, the attribute alone opens it.
    if (el.showModal) el.showModal();
    else el.setAttribute("open", "");
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([api.movedFolderCandidates(), api.recentFolders()]).then(
      ([moved, recent]) => live && setChoices(oldChoices(moved, recent)),
      () => live && setChoices([]),
    );
    return () => {
      live = false;
    };
  }, []);

  // What the move would find, for the places chosen. Read only.
  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    if (!old || !next) return;
    let live = true;
    api.relocationPreview(old, next).then(
      (found) => live && setPreview(found),
      (e) => live && setPreviewError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [old, next]);

  const confirm = () => {
    if (!old || !next) return;
    setBusy(true);
    setError(null);
    api.relocateFolder(old, next, options).then(
      (outcome) => {
        setBusy(false);
        setDone(outcome);
      },
      (e) => {
        setBusy(false);
        setError(String(e));
      },
    );
  };

  const choose = () => pickFolder().then((picked) => picked && setNext(picked));

  // A place from the notice that the list doesn't have (it was dismissed, say) is still the first choice.
  const listed: OldChoice[] = choices ?? [];
  const shown = old && start?.old === old && !listed.some((c) => c.path === old) ? [{ path: old, gone: true, suggested: start.suggested }, ...listed] : listed;
  const sameFolder = !!next && next === old;
  const ready = !!old && !!next && !!preview && !busy && !sameFolder;

  if (done && old && next) {
    return (
      <dialog ref={ref} className="revert-dialog relocate-dialog" aria-label="Relocate a folder" onCancel={(e) => e.preventDefault()}>
        <div className="revert-body">
          <div className="revert-title">Relocated</div>
          <p className="revert-text">
            {basename(next)} now has {count(preview?.sessions ?? 0, "past session", "past sessions")}, so they can be opened from it. Your old session files are copied, never moved or deleted.
          </p>
          <p className="revert-text" role="status">
            Carried over: {count(done.project_keys.length, "project setting", "project settings")}, {count(done.memory_files, "memory file", "memory files")}, {count(done.rules, "permission rule", "permission rules")}.
          </p>
          <div className="revert-actions">
            <button className="primary" onClick={() => onDone(old, next, done)}>
              Done
            </button>
          </div>
        </div>
      </dialog>
    );
  }

  return (
    <dialog
      ref={ref}
      className="revert-dialog relocate-dialog"
      aria-label="Relocate a folder"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <div className="revert-body">
        <div className="revert-title">Where was this folder?</div>
        {choices === null ? (
          <div className="menu-empty">Loading…</div>
        ) : shown.length === 0 ? (
          <p className="revert-text">There are no recent folders to choose from. Claude Code keeps the list; open the folder once and try again.</p>
        ) : (
          <ul className="menu-list" aria-label="Old locations">
            {shown.map((c) => (
              <li key={c.path}>
                <button className={`menu-row${c.path === old ? " current" : ""}`} aria-pressed={c.path === old} title={c.path} onClick={() => setOld(c.path)}>
                  <span className="menu-row-title">
                    {basename(c.path)}
                    <span className="menu-row-path">{dirOf(c.path)}</span>
                  </span>
                  <span className="menu-row-meta">{c.gone ? (c.suggested ? "Moved?" : "Gone") : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="revert-title">Where is it now?</div>
        <p className="revert-text" title={next ?? undefined}>
          {next ? next : "Not chosen yet."}
        </p>
        <div className="revert-actions">
          {current && current !== old && (
            <button onClick={() => setNext(current)} disabled={busy}>
              Use {basename(current)}
            </button>
          )}
          <button onClick={choose} disabled={busy}>
            Choose folder…
          </button>
        </div>
        {sameFolder && (
          <p className="revert-warning" role="note">
            That's the folder it was. Pick where it is now.
          </p>
        )}

        {old && next && !sameFolder && (
          <>
            {previewError && (
              <div className="revert-error" role="alert">
                {previewError}
              </div>
            )}
            {!previewError && !preview && <p className="revert-text">Looking at its history…</p>}
            {preview && (
              <>
                <p className="revert-text">
                  {count(preview.sessions, "past session", "past sessions")} ({megabytes(preview.bytes)}) found for {basename(old)}.
                  {preview.linked > 0 && ` ${count(preview.linked, "linked item is", "linked items are")} skipped: a link isn't copied.`}
                </p>
                <label className="relocate-option">
                  <input type="checkbox" checked={options.project_settings} disabled={busy} onChange={(e) => setOptions({ ...options, project_settings: e.target.checked })} />
                  Carry over project settings (MCP servers and permissions Claude Code keeps for this folder){!preview.project_entry && " — none found"}
                </label>
                <label className="relocate-option">
                  <input type="checkbox" checked={options.memory} disabled={busy} onChange={(e) => setOptions({ ...options, memory: e.target.checked })} />
                  Carry over its memory ({count(preview.memory_files, "file", "files")})
                </label>
                <p className="revert-text">Your old session files are copied, never moved or deleted.</p>
              </>
            )}
          </>
        )}
        {error && (
          <div className="revert-error" role="alert">
            {error}
          </div>
        )}
        <div className="revert-actions">
          <button onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={confirm} disabled={!ready}>
            {busy ? "Relocating…" : "Relocate"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
