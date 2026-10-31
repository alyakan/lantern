import { useState } from "react";
import type { InboxRow, RowState } from "../lib/deskBoard";
import { elapsed } from "../lib/time";

export interface DeskInboxProps {
  rows: InboxRow[];
  now: number;
  /** The project picked in the table: only its chats are listed. */
  project: { folder: string; label: string } | null;
  onClearProject: () => void;
  onOpen: (slot: string) => void;
}

const STATE: Record<RowState, string | null> = { working: "working", waiting: "needs you", done: null, asleep: "asleep" };

const when = (now: number, at: number) => {
  const d = new Date(at);
  if (now - at < 60_000) return "now";
  if (now - at < 12 * 60 * 60_000) return now - at < 60 * 60_000 ? elapsed(now - at) : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { weekday: "short" });
};

/**
 * Every chat on the Desk, as an inbox: a row each with its last message, newest first. One that finished while you were
 * elsewhere and that you haven't opened since is bold, with a dot. A click opens the chat, which marks it read.
 */
export function DeskInbox({ rows, now, project, onClearProject, onOpen }: DeskInboxProps) {
  const [onlyUnread, setOnlyUnread] = useState(false);
  const mine = project ? rows.filter((r) => r.folder === project.folder) : rows;
  const unread = mine.filter((r) => r.unread).length;
  const shown = onlyUnread ? mine.filter((r) => r.unread) : mine;
  return (
    <aside className="desk-inbox" aria-label="Inbox">
      <div className="desk-inbox-head">
        <h2 className="desk-h">{project ? `${project.label} inbox` : "Inbox"}</h2>
        {unread > 0 && <span className="desk-unread-count">{unread} unread</span>}
        {project && (
          <button className="desk-crumb" onClick={onClearProject} title="List every project's chats again">
            All projects
          </button>
        )}
      </div>
      <div className="desk-filter" role="group" aria-label="Show">
        <button aria-pressed={!onlyUnread} onClick={() => setOnlyUnread(false)}>
          All
        </button>
        <button aria-pressed={onlyUnread} onClick={() => setOnlyUnread(true)}>
          Unread
        </button>
      </div>
      <div className="desk-msgs">
        {shown.length === 0 && <p className="desk-inbox-empty muted">{onlyUnread ? "Nothing unread." : "No chat open here."}</p>}
        {shown.map((r) => (
          <button key={r.slot} className={`desk-msg ${r.state}${r.unread ? " unread" : ""}`} aria-label={`${r.title}${r.unread ? ", unread" : ""}`} onClick={() => onOpen(r.slot)}>
            <span className="desk-msg-top">
              {r.unread && <span className="desk-unread-dot" aria-hidden />}
              <span className="desk-msg-title">{r.title}</span>
              {r.at !== null && <time className="desk-time">{when(now, r.at)}</time>}
            </span>
            <span className="desk-msg-meta">
              {project ? r.workflow : `${r.where} · ${r.workflow}`}
              {STATE[r.state] && <span className={`desk-state ${r.state}`}>{STATE[r.state]}</span>}
            </span>
            {r.line && <span className="desk-msg-line">{r.line}</span>}
          </button>
        ))}
      </div>
    </aside>
  );
}
