import { useContext, useState } from "react";
import { useMenuInside } from "../lib/useMenuInside";
import type { SessionSummary } from "../types";
import { relativeTime } from "../lib/time";
import { moveFocus } from "./useMenuKeys";
import { SessionActionsContext, pinnedFirst, resumeCommand } from "../lib/sessionActions";

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
  // Which session's actions are open, a name being typed for one, the names saved here, and the one just copied.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  // Opened from the chat box at the bottom of the window, it opens upward when it doesn't fit below.
  // The chat column clips what sticks out of it, so it also stays inside that column sideways.
  const { ref: root, style } = useMenuInside(true, [sessions === null, shown?.length ?? 0, !!oldSessions]);

  return (
    <div
      className="menu history-menu"
      role="dialog"
      aria-label="Chat history"
      ref={root}
      style={style}
      onKeyDown={(e) => {
        // Escape closes from anywhere in it (a name being typed takes its own Escape first); ↑ ↓ walk the search box and the chats.
        if (e.key === "Escape") onClose();
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") moveFocus(e, [...e.currentTarget.querySelectorAll<HTMLElement>(".menu-search, .session-row .menu-row")]);
      }}
    >
      <input
        className="menu-search"
        autoCapitalize="off"
        autoCorrect="off"
        autoFocus
        placeholder="Search chats"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
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
                        if (e.key === "Escape") {
                          e.stopPropagation();
                          setRenaming(null);
                        }
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
