import { useState } from "react";
import type { SessionSummary } from "../types";
import { relativeTime } from "../lib/time";
import { resumeCommand, type SessionActions } from "../lib/sessionActions";

interface Props {
  /** The list's name for screen readers. */
  label: string;
  /** In the order to show them. */
  sessions: SessionSummary[];
  /** What to do to a session of this list (its folder's), or none where there's no folder to act in. */
  actions: SessionActions | null;
  onOpen: (id: string) => void;
}

/**
 * Past chats of one folder as History lists them: each with how long ago (and Pinned), and a ⋯ with Rename, Pin to top,
 * Export as Markdown and Copy resume command.
 */
export function SessionList({ label, sessions, actions, onOpen }: Props) {
  // Which session's actions are open, a name being typed for one, the names saved here, and the one just copied.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);

  return (
    <ul className="menu-list" aria-label={label}>
      {sessions.map((s) => {
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
  );
}
