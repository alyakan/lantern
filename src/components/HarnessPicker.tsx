import { useEffect, useRef, useState } from "react";
import { DEFAULT_HARNESS, summary, type Harness } from "../lib/harness";

/** Three nodes, one above two: an agent and who it works with. */
function HarnessIcon() {
  return (
    <svg width="13" height="12" viewBox="0 0 13 12" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <circle cx="6.5" cy="2.4" r="1.6" />
      <circle cx="2.4" cy="9.6" r="1.6" />
      <circle cx="10.6" cy="9.6" r="1.6" />
      <path d="M5.6 3.8 3.3 8.2M7.4 3.8l2.3 4.4" />
    </svg>
  );
}

interface Props {
  presets: Harness[];
  chosen: string;
  onChoose: (id: string) => void;
  /** Opens Settings → Harness, to edit presets or make one. */
  onEdit?: () => void;
  disabled?: boolean;
}

// Beside model and effort: which models do what in this chat (main, advisor, subagents). Changing it restarts the
// chat's claude on the same session.
export function HarnessPicker({ presets, chosen, onChoose, onEdit, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const current = presets.find((h) => h.id === chosen) ?? presets[0];
  return (
    <div className="model-picker" ref={root} onClick={(e) => e.stopPropagation()}>
      <button className={`composer-item model-button${chosen === DEFAULT_HARNESS ? "" : " harness-on"}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled} title={`Harness: ${current.name} (${summary(current)})`} onClick={() => setOpen(!open)}>
        <HarnessIcon />
        {current.name}
        <span className="chev down" aria-hidden />
      </button>
      {open && (
        <div className="menu model-menu harness-menu" role="menu" aria-label="Harness">
          <div className="menu-heading">Harness: who does what</div>
          {presets.map((h) => (
            <button
              key={h.id}
              role="menuitemradio"
              aria-checked={h.id === chosen}
              className={`menu-row${h.id === chosen ? " current" : ""}`}
              onClick={() => {
                setOpen(false);
                if (h.id !== chosen) onChoose(h.id);
              }}
            >
              <span className="menu-row-title">{h.name}</span>
              <span className="menu-row-meta">{summary(h)}</span>
            </button>
          ))}
          {onEdit && (
            <button
              role="menuitem"
              className="menu-row harness-edit"
              onClick={() => {
                setOpen(false);
                onEdit();
              }}
            >
              <span className="menu-row-title">Edit presets…</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
