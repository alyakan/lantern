import { useEffect, useState, type ReactNode } from "react";
import { basename } from "../lib/diff";
import { relativeTime } from "../lib/time";
import type { RecentFolder } from "../types";
import { ClaudeCheck } from "./ClaudeCheck";
import { FolderIcon } from "./icons";

/** How many recent projects the screen offers. */
export const RECENTS_SHOWN = 6;

const parentOf = (path: string) => {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "/";
};

/**
 * What's on screen until a folder is open: one button to open one, the projects used before as cards, and whether
 * claude is ready. Nothing else (no side panel, no empty chat) until then.
 * `skip`: folders to leave out (removed from the lists, or gone from where they were). `children` come above it all
 * (chats offered back from last time).
 */
export function Welcome({ claudePath, loadRecent, skip, onOpenFolder, onPick, children }: { children?: ReactNode; claudePath: string; loadRecent: () => Promise<RecentFolder[]>; skip: string[]; onOpenFolder: () => void; onPick: (path: string) => void }) {
  const [recent, setRecent] = useState<RecentFolder[]>([]);
  useEffect(() => {
    let live = true;
    loadRecent().then((found) => live && setRecent(found), () => {});
    return () => {
      live = false;
    };
  }, []);
  const shown = recent.filter((r) => !skip.includes(r.path)).slice(0, RECENTS_SHOWN);
  return (
    <div className="welcome">
      {children}
      <div className="welcome-body">
        <h1>Open a folder to start</h1>
        <p className="welcome-lead">Claude works inside the folder you pick: its files, its git history, its commands.</p>
        <button className="primary welcome-open" onClick={onOpenFolder}>
          <FolderIcon />
          Open folder…
          <kbd>⌘O</kbd>
        </button>
        {shown.length > 0 && (
          <section className="welcome-recents" aria-label="Recent projects">
            <h2>Recent projects</h2>
            <div className="welcome-cards">
              {shown.map((r) => (
                <button key={r.path} className="welcome-card" title={r.path} onClick={() => onPick(r.path)}>
                  <span className="welcome-card-name">{basename(r.path)}</span>
                  <span className="welcome-card-path">{parentOf(r.path)}</span>
                  <span className="welcome-card-when">Last used {relativeTime(r.updated_ms)}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
      <ClaudeCheck path={claudePath} />
    </div>
  );
}
