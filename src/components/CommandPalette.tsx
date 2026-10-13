import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { filterEntries, type PaletteEntry } from "../lib/palette";
import { scrollWithin } from "../lib/scrollWithin";

interface Props {
  /** Everything that can run now: enabled actions, modes, harnesses and Settings pages. */
  entries: PaletteEntry[];
  onClose: () => void;
}

/**
 * ⇧⌘P: a search over everything Lantern can do, with each one's shortcut. Typing narrows the list, the arrow keys
 * pick, Enter runs the pick and Escape (or a click outside) closes it.
 */
export function CommandPalette({ entries, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [pick, setPick] = useState(0);
  const shown = useMemo(() => filterEntries(entries, query), [entries, query]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // jsdom has no showModal: there, the attribute alone opens it (as in the mode guide).
    if (el.showModal) el.showModal();
    else el.setAttribute("open", "");
  }, []);
  // A new search starts at the top of what it finds.
  useEffect(() => setPick(0), [query]);
  useEffect(() => {
    const item = document.getElementById(`palette-${pick}`);
    if (list.current && item) scrollWithin(list.current, item, "nearest");
  }, [pick]);

  // Closing first, then running: the action may open something that should have the focus.
  const run = (entry: PaletteEntry) => {
    onClose();
    entry.run();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length) setPick((p) => (e.key === "ArrowDown" ? (p + 1) % shown.length : (p - 1 + shown.length) % shown.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[pick]) run(shown[pick]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <dialog ref={ref} className="palette" aria-label="Command palette" onClose={onClose} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette-body">
        <input
          className="menu-search palette-search"
          placeholder="Type a command…"
          aria-label="Search commands"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-activedescendant={shown[pick] ? `palette-${pick}` : undefined}
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {shown.length > 0 ? (
          <ul className="palette-list" id="palette-list" role="listbox" aria-label="Commands" ref={list}>
            {shown.map((entry, i) => (
              <li key={entry.id} id={`palette-${i}`} role="option" aria-selected={i === pick} className={`palette-row${i === pick ? " current" : ""}`} onMouseEnter={() => setPick(i)} onClick={() => run(entry)}>
                <span className="palette-title">{entry.title}</span>
                <span className="palette-group">{entry.group}</span>
                {entry.shortcut && <kbd className="palette-shortcut">{entry.shortcut}</kbd>}
              </li>
            ))}
          </ul>
        ) : (
          <div className="menu-empty">No command matches “{query}”.</div>
        )}
      </div>
    </dialog>
  );
}
