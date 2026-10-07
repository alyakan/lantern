import { basename } from "../lib/diff";
import type { SavedChat } from "../lib/restore";
import { ClockIcon } from "./icons";

/**
 * Above the chat box at launch: the chats that were open when Lantern last closed. All of them come back at once, or
 * one at a time from the list. It goes away when dismissed, once all are back, or with the first message sent instead.
 */
export function RestoreCard({ chats, folder, onRestoreAll, onRestore, onDismiss }: {
  chats: SavedChat[];
  /** The folder on screen: chats from another one name theirs. */
  folder: string | null;
  onRestoreAll: () => void;
  onRestore: (chat: SavedChat) => void;
  onDismiss: () => void;
}) {
  return (
    <section className="steps-intro restore-card" aria-label="Chats from last time">
      <div className="steps-intro-head">
        <span className="steps-intro-title">
          <ClockIcon />
          {chats.length === 1 ? "A chat was open when Lantern closed" : `${chats.length} chats were open when Lantern closed`}
        </span>
        <button className="hud-close restore-close" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
          ×
        </button>
      </div>
      <ul className="restore-list">
        {chats.map((c, i) => (
          <li key={c.sessionId ?? `draft-${i}`}>
            <button className="menu-row" title={`Restore “${c.title}”`} onClick={() => onRestore(c)}>
              <span className="menu-row-title">{c.title}</span>
              {c.draft && <span className="menu-row-meta">Unsent text</span>}
              {c.folder !== folder && <span className="menu-row-meta">{basename(c.folder)}</span>}
            </button>
          </li>
        ))}
      </ul>
      <div className="restore-actions">
        <button className="primary" onClick={onRestoreAll}>
          {chats.length === 1 ? "Restore" : "Restore all"}
        </button>
      </div>
    </section>
  );
}
