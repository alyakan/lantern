import { useEffect, useRef } from "react";
import { ACTIONS, shortcutLabel, type ActionGroup } from "../lib/actions";

/** The groups in the order the sheet lists them. */
const GROUPS: ActionGroup[] = ["File", "View", "Search", "Work", "Chat", "Help"];

interface Props {
  /** The actions that can run now; the others are listed too, dimmed. */
  available: string[];
  onClose: () => void;
}

/**
 * ⌘/ and Help ▸ Keyboard Shortcuts: every shortcut Lantern has, read from the same list the menu bar and the palette run
 * from, so it can't go stale. It only shows them (there's no rebinding).
 */
export function ShortcutSheet({ available, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // jsdom has no showModal: there, the attribute alone opens it (as in the mode guide).
    if (el.showModal) el.showModal();
    else el.setAttribute("open", "");
  }, []);
  const shortcuts = ACTIONS.filter((a) => a.key);
  return (
    <dialog ref={ref} className="shortcuts" aria-labelledby="shortcuts-title" onClose={onClose} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="shortcuts-body">
        <div className="settings-head">
          <div>
            <h2 className="mode-guide-title" id="shortcuts-title">
              Keyboard Shortcuts
            </h2>
            <p className="mode-guide-summary">The shortcuts that work in Lantern. Some are dimmed: they can't be used right now.</p>
          </div>
        </div>
        <div className="shortcuts-groups">
          {GROUPS.map((group) => {
            const rows = shortcuts.filter((a) => a.group === group);
            if (rows.length === 0) return null;
            return (
              <section key={group} className="shortcuts-group" aria-label={group}>
                <h3 className="shortcuts-group-title">{group}</h3>
                <ul className="shortcuts-list">
                  {rows.map((a) => {
                    const off = !available.includes(a.id);
                    return (
                      <li key={a.id} className={`shortcuts-row${off ? " off" : ""}`} title={off ? "Not available right now" : undefined}>
                        <span className="shortcuts-title">{a.title}</span>
                        <kbd className="shortcuts-key">{shortcutLabel(a)}</kbd>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
        <div className="mode-guide-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </dialog>
  );
}
