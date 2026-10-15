import { useContext, useState } from "react";
import type { SessionSummary } from "../types";
import { relativeTime } from "../lib/time";
import { SessionActionsContext, pinnedFirst, resumeCommand } from "../lib/sessionActions";
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
  /** A worker of an orchestra: it is reached from its team's canvas, so the list of open chats leaves it out. */
  worker?: boolean;
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
  /** Sessions from places this folder was before that aren't brought over yet, and the way to bring them. */
  oldSessions?: { count: number; onOpen: () => void } | null;
}

// The dropdown under the title bar's History button: search, then the old sessions to bring over (when there are any),
// then the open chats (the one on screen first), then past sessions for this folder, pinned ones first and the rest
// newest first. Each past session has its own actions, when there's a folder to act in (see SessionActionsContext).
export function HistoryMenu({ sessions, currentId, onOpen, onClose, open = [], onSwitch, onCloseChat, oldSessions = null }: Props) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = (title: string) => !q || title.toLowerCase().includes(q);
  const openIds = new Set(open.map((c) => c.sessionId));
  const shownOpen = open.filter((c) => !c.worker && matches(c.title));
  // The chat on screen is open too: it leads the Open list rather than sitting among past sessions.
  const current = sessions?.find((s) => s.id === currentId && matches(s.title)) ?? null;
  const actions = useContext(SessionActionsContext);
  const listed = sessions?.filter((s) => s.id !== currentId && !openIds.has(s.id) && matches(s.title)) ?? null;
  const shown = listed && actions ? pinnedFirst(listed, actions.pinned) : listed;
  // Which session's actions are open, a name being typed for one, the names saved here, and the one just copied.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);

  return (
    <div className="menu history-menu" role="dialog" aria-label="Chat history">
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
      {(current || shownOpen.length > 0) && (
        <>
          <div className="menu-heading">Open chats</div>
          {/* Lists of buttons, not listboxes: a button can't sit inside an option, and these are Tab-through. */}
          <ul className="menu-list open-chats-list" aria-label="Open chats">
            {current && (
              <li>
                <button className="menu-row current" aria-current="true" title={current.title} onClick={onClose}>
                  <span className="menu-row-title">{current.title}</span>
                  <span className="menu-row-meta">Current</span>
                </button>
              </li>
            )}
            {shownOpen.map((c) => (
              <li key={c.slot} className={`open-chat${onCloseChat && (c.state === "done" || c.state === "draft") ? " closable" : ""}`}>
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
          <div className="menu-heading">Past chats</div>
        </>
      )}
      {shown === null ? (
        <div className="menu-empty">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="menu-empty">{q ? "No matching chats" : "No past chats in this folder"}</div>
      ) : (
        <ul className="menu-list" aria-label="Past chats">
          {shown.map((s) => {
            const title = names[s.id] ?? s.title;
            const pinned = !!actions?.pinned.includes(s.id);
            const editing = renaming?.id === s.id ? renaming : null;
            return (
              <li key={s.id}>
                {editing ? (
                  <form
                    className="session-rename"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const name = editing.text.trim();
                      if (!name || !actions) return;
                      setRenaming(null);
                      actions.onRename(s.id, name).then(() => setNames((all) => ({ ...all, [s.id]: name })), () => {});
                    }}
                  >
                    <input
                      aria-label="Name for this chat"
                      autoFocus
                      value={editing.text}
                      onChange={(e) => setRenaming({ id: s.id, text: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setRenaming(null);
                      }}
                    />
                    <button type="submit" className="link-button" disabled={!editing.text.trim()}>
                      Save
                    </button>
                  </form>
                ) : (
                  <div className="session-row">
                    <button className="menu-row" title={title} onClick={() => onOpen(s.id)}>
                      <span className="menu-row-title">{title}</span>
                      <span className="menu-row-meta">{pinned ? `Pinned · ${relativeTime(s.updated_ms)}` : relativeTime(s.updated_ms)}</span>
                    </button>
                    {actions && (
                      <button className="icon session-more" aria-label={`Actions for ${title}`} aria-expanded={menuFor === s.id} onClick={() => setMenuFor(menuFor === s.id ? null : s.id)}>
                        ⋯
                      </button>
                    )}
                  </div>
                )}
                {actions && menuFor === s.id && !editing && (
                  <div className="session-actions">
                    <button className="link-button" onClick={() => setRenaming({ id: s.id, text: title })}>
                      Rename
                    </button>
                    <button className="link-button" onClick={() => actions.onTogglePin(s.id)}>
                      {pinned ? "Unpin" : "Pin to top"}
                    </button>
                    <button className="link-button" onClick={() => actions.onExport(s.id, title)}>
                      Export as Markdown
                    </button>
                    <button
                      className="link-button"
                      title="The command that picks this chat up in a terminal"
                      onClick={() => navigator.clipboard?.writeText(resumeCommand(actions.folder, s.id)).then(() => setCopied(s.id), () => {})}
                    >
                      {copied === s.id ? "Copied" : "Copy resume command"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
