import { useEffect, useRef, useState } from "react";
import type { RecentFolder } from "../types";
import { basename } from "../lib/diff";
import { FolderIcon } from "./icons";

interface Props {
  folder: string | null;
  loadRecent: () => Promise<RecentFolder[]>;
  onPick: (path: string) => void;
  onBrowse: () => void;
  disabled?: boolean;
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "/";
}

// The folder capsule above the composer: recent folders (from Claude Code's own projects), then "Open folder…",
// like the Local list in VS Code's project menu.
export function FolderPill({ folder, loadRecent, onPick, onBrowse, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<RecentFolder[] | null>(null);
  const root = useRef<HTMLDivElement>(null);

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
      {open && <FolderMenu folder={folder} recent={recent} onPick={onPick} onBrowse={onBrowse} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** The dropdown itself, shared by this capsule and the title bar's folder pill. `recent` is null while loading. */
export function FolderMenu({ folder, recent, onPick, onBrowse, onClose }: { folder: string | null; recent: RecentFolder[] | null; onPick: (path: string) => void; onBrowse: () => void; onClose: () => void }) {
  const choose = (act: () => void) => {
    onClose();
    act();
  };
  return (
    <div className="menu folder-menu" role="menu" aria-label="Folders">
      <div className="menu-heading">Recent</div>
      {recent === null ? (
        <div className="menu-empty">Loading…</div>
      ) : recent.length === 0 ? (
        <div className="menu-empty">No recent folders</div>
      ) : (
        <ul className="menu-list">
          {recent.map((r) => (
            <li key={r.path}>
              <button role="menuitem" className={`menu-row${r.path === folder ? " current" : ""}`} title={r.path} onClick={() => choose(() => r.path !== folder && onPick(r.path))}>
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
      <button role="menuitem" className="menu-row" onClick={() => choose(onBrowse)}>
        <span className="menu-row-title">Open folder…</span>
      </button>
    </div>
  );
}
