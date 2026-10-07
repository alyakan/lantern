import { useState } from "react";
import type { SessionSummary } from "../types";
import { relativeTime } from "../lib/time";
import { FolderIcon } from "./icons";

/** A chat that's open in the background: running, waiting for you, or finished and kept open until you close it. */
export interface OpenChat {
  slot: string;
  title: string;
  /** Working, waiting for a permission answer, holding unsent text, or finished. */
  state: "running" | "waiting" | "draft" | "done";
  /** It finished while you were elsewhere and you haven't opened it since. */
  unread?: boolean;
  /** How many tasks it still runs in the background. */
  background?: number;
  /** Claude's session id once it has one, so the same session isn't listed twice. */
  sessionId: string | null;
  /** The chat's folder name, when it's not the folder on screen. */
  elsewhere: string | null;
}

interface Props {
  /** null while loading */
  sessions: SessionSummary[] | null;
  currentId: string | null;
  onOpen: (id: string) => void;
  onClose: () => void;
  open?: OpenChat[];
  onSwitch?: (slot: string) => void;
  /** Closes an open chat. Not offered while it's working or waiting for you: stop it or answer first. */
  onCloseChat?: (slot: string) => void;
}

// The dropdown under the title bar's History button: search, then the open chats (the one on screen first), then past
// sessions for this folder, newest first.
export function HistoryMenu({ sessions, currentId, onOpen, onClose, open = [], onSwitch, onCloseChat }: Props) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = (title: string) => !q || title.toLowerCase().includes(q);
  const openIds = new Set(open.map((c) => c.sessionId));
  const shownOpen = open.filter((c) => matches(c.title));
  // The chat on screen is open too: it leads the Open list rather than sitting among past sessions.
  const current = sessions?.find((s) => s.id === currentId && matches(s.title)) ?? null;
  const shown = sessions?.filter((s) => s.id !== currentId && !openIds.has(s.id) && matches(s.title)) ?? null;

  return (
    <div className="menu history-menu" role="dialog" aria-label="Session history">
      <input
        className="menu-search"
        autoCapitalize="off"
        autoCorrect="off"
        autoFocus
        placeholder="Search sessions"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      />
      {(current || shownOpen.length > 0) && (
        <>
          <div className="menu-heading">Open</div>
          <ul className="menu-list open-chats-list" role="listbox" aria-label="Open chats">
            {current && (
              <li role="option" aria-selected>
                <button className="menu-row current" title={current.title} onClick={onClose}>
                  <span className="menu-row-title">{current.title}</span>
                  <span className="menu-row-meta">Current</span>
                </button>
              </li>
            )}
            {shownOpen.map((c) => (
              <li key={c.slot} role="option" aria-selected={false} className={`open-chat${onCloseChat && (c.state === "done" || c.state === "draft") ? " closable" : ""}`}>
                <button className="menu-row" title={c.elsewhere ? `${c.title}\nIn ${c.elsewhere}` : c.title} onClick={() => onSwitch?.(c.slot)}>
                  <span className={`open-chat-unread${c.unread && c.state === "done" ? " on" : ""}`} aria-label={c.unread && c.state === "done" ? "Unread" : undefined} />
                  <span className="menu-row-title">{c.title}</span>
                  {/* Its own label, not part of the title: a long title would cut it off. */}
                  {c.elsewhere && (
                    <span className="open-chat-project" aria-label={`in ${c.elsewhere}`}>
                      <FolderIcon />
                      {c.elsewhere}
                    </span>
                  )}
                  <span className="menu-row-meta">
                    {(c.state === "running" || (c.state === "done" && !!c.background)) && <span className="spinner" aria-hidden />}
                    {c.state === "done" && c.background ? `${c.background} in background` : { running: "Running", waiting: "Needs you", draft: "Draft", done: "Done" }[c.state]}
                  </span>
                </button>
                {onCloseChat && (c.state === "done" || c.state === "draft") && (
                  <button className="icon open-chat-close" aria-label={`Close ${c.title}`} title={c.state === "draft" ? "Close (discards the unsent text)" : "Close"} onClick={() => onCloseChat(c.slot)}>
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="menu-heading">Past sessions</div>
        </>
      )}
      {shown === null ? (
        <div className="menu-empty">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="menu-empty">{q ? "No matching sessions" : "No past sessions in this folder"}</div>
      ) : (
        <ul className="menu-list" role="listbox" aria-label="Past sessions">
          {shown.map((s) => (
            <li key={s.id} role="option" aria-selected={false}>
              <button className="menu-row" title={s.title} onClick={() => onOpen(s.id)}>
                <span className="menu-row-title">{s.title}</span>
                <span className="menu-row-meta">{relativeTime(s.updated_ms)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
