import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { MovedFolder, RecentFolder } from "../types";
import { basename } from "../lib/diff";
import { FolderIcon } from "./icons";
import { useMenuKeys } from "./useMenuKeys";

/** The folder menu's relocation parts: the folders that seem to have moved, and what to do about them. */
export interface RelocateMenu {
  /** Folders whose path is gone and that aren't dismissed (see App). */
  moved: MovedFolder[];
  /** Relocate one of them (from it), or any folder (null). */
  onRelocate: (from: MovedFolder | null) => void;
  onDismiss: (old: string) => void;
}

interface Props {
  folder: string | null;
  loadRecent: () => Promise<RecentFolder[]>;
  onPick: (path: string) => void;
  onBrowse: () => void;
  disabled?: boolean;
  relocate?: RelocateMenu;
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "/";
}

// The folder capsule above the composer: recent folders (from Claude Code's own projects), then "Open folder…",
// like the Local list in VS Code's project menu.
export function FolderPill({ folder, loadRecent, onPick, onBrowse, disabled, relocate }: Props) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<RecentFolder[] | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // The keys wait for the list: focus goes to the first recent folder once it has loaded.
  const keys = useMenuKeys(open && recent !== null, root);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    if (open) return setOpen(false);
    setRecent(null);
    setOpen(true);
    loadRecent().then(setRecent, () => setRecent([]));
  };

  return (
    <div className="pill-anchor" ref={root}>
      <button className="pill" aria-haspopup="menu" aria-expanded={open} disabled={disabled} title={folder ?? "Open a folder for Claude to work in"} onClick={toggle}>
        <FolderIcon />
        <span>{folder ? basename(folder) : "Open folder"}</span>
        <span className="chev down" aria-hidden />
      </button>
      {open && <FolderMenu folder={folder} recent={recent} onPick={onPick} onBrowse={onBrowse} onClose={() => setOpen(false)} onKeyDown={keys.onKeyDown} relocate={relocate} />}
    </div>
  );
}

/**
 * The dropdown itself, shared by this capsule and the title bar's folder pill. `recent` is null while loading, and
 * undefined for a menu with no list of folders (the title bar's: the sidebar lists them). The arrow keys are the caller's
 * (`onKeyDown`), since focus goes back to whichever button opened the menu.
 */
export function FolderMenu({ folder, recent, onPick, onBrowse, onClose, onKeyDown, relocate }: { folder: string | null; recent?: RecentFolder[] | null; onPick?: (path: string) => void; onBrowse: () => void; onClose: () => void; onKeyDown?: (e: ReactKeyboardEvent<HTMLElement>) => void; relocate?: RelocateMenu }) {
  const choose = (act: () => void) => {
    onClose();
    act();
  };
  return (
    <div className="menu folder-menu" role="menu" aria-label="Folders" onKeyDown={onKeyDown}>
      {recent !== undefined && relocate && relocate.moved.length > 0 && (
        <>
          <div className="menu-heading">Moved?</div>
          <ul className="menu-list moved-folders" aria-label="Folders that may have moved">
            {relocate.moved.map((m) => (
              <li key={m.old} className="moved-folder">
                <button role="menuitem" className="menu-row" title={m.old} onClick={() => choose(() => relocate.onRelocate(m))}>
                  <FolderIcon />
                  <span className="menu-row-title">
                    {`${basename(m.old)} was moved? Bring its chats to ${m.suggested ? basename(m.suggested) : "a folder"}…`}
                    <span className="menu-row-path">{m.suggested ?? `Was in ${parentOf(m.old)}`}</span>
                  </span>
                </button>
                <button className="icon moved-folder-dismiss" aria-label={`Dismiss the moved notice for ${basename(m.old)}`} title="Dismiss" onClick={() => relocate.onDismiss(m.old)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          <div className="menu-sep" />
        </>
      )}
      {recent !== undefined && (
        <>
          <div className="menu-heading">Recent</div>
          {recent === null ? (
            <div className="menu-empty">Loading…</div>
          ) : recent.length === 0 ? (
            <div className="menu-empty">No recent folders</div>
          ) : (
            <ul className="menu-list">
              {recent.map((r) => (
                <li key={r.path}>
                  <button role="menuitem" className={`menu-row${r.path === folder ? " current" : ""}`} title={r.path} onClick={() => choose(() => r.path !== folder && onPick?.(r.path))}>
                    <FolderIcon />
                    <span className="menu-row-title">
                      {basename(r.path)}
                      <span className="menu-row-path">{parentOf(r.path)}</span>
                    </span>
                    {r.path === folder && <span className="menu-row-meta">Current</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="menu-sep" />
        </>
      )}
      <button role="menuitem" className="menu-row" onClick={() => choose(onBrowse)}>
        <span className="menu-row-title">Open folder…</span>
      </button>
      {relocate && (
        <button role="menuitem" className="menu-row" onClick={() => choose(() => relocate.onRelocate(null))}>
          <span className="menu-row-title">Bring old chats here…</span>
        </button>
      )}
    </div>
  );
}
