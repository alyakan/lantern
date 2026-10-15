import { useContext, useRef, useState } from "react";
import { useFitMenu } from "../lib/useFitMenu";
import type { SessionSummary } from "../types";
import { SessionActionsContext, pinnedFirst } from "../lib/sessionActions";
import { SessionList } from "./SessionList";

interface Props {
  /** null while loading */
  sessions: SessionSummary[] | null;
  /** Claude's session ids of the chats that are open: they live in the sidebar, so History leaves them out. */
  exclude?: string[];
  /** The project's name, said above the list. */
  project?: string;
  onOpen: (id: string) => void;
  onClose: () => void;
  /** Sessions from places this folder was before that aren't brought over yet, and the way to bring them. */
  oldSessions?: { count: number; onOpen: () => void } | null;
}

// A folder's past chats: search, then the old sessions to bring over (when there are any), then the sessions, pinned ones
// first and the rest newest first. Chats that are open are in the sidebar, not here. Each session has its own actions,
// when there's a folder to act in (see SessionActionsContext).
export function HistoryMenu({ sessions, exclude = [], project, onOpen, onClose, oldSessions = null }: Props) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = (title: string) => !q || title.toLowerCase().includes(q);
  const actions = useContext(SessionActionsContext);
  const listed = sessions?.filter((s) => !exclude.includes(s.id) && matches(s.title)) ?? null;
  const shown = listed && actions ? pinnedFirst(listed, actions.pinned) : listed;
  // Opened from the chat box at the bottom of the window, it opens upward when it doesn't fit below.
  const root = useRef<HTMLDivElement>(null);
  useFitMenu(root, [sessions === null, shown?.length ?? 0, !!oldSessions]);

  return (
    <div className="menu history-menu" role="dialog" aria-label="Chat history" ref={root}>
      <input
        className="menu-search"
        autoCapitalize="off"
        autoCorrect="off"
        autoFocus
        placeholder="Search chats"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      />
      {oldSessions && oldSessions.count > 0 && (
        <button className="menu-row bring-old" onClick={oldSessions.onOpen}>
          <span className="menu-row-title">{`${oldSessions.count} ${oldSessions.count === 1 ? "chat" : "chats"} from before you moved this project: Bring them here`}</span>
        </button>
      )}
      {project && <div className="menu-heading">{`Past chats in ${project}`}</div>}
      {shown === null ? (
        <div className="menu-empty">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="menu-empty">{q ? "No matching chats" : "No past chats in this folder"}</div>
      ) : (
        <SessionList label="Past chats" sessions={shown} actions={actions} onOpen={onOpen} />
      )}
    </div>
  );
}
