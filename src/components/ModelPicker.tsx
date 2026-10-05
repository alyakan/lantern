import { useEffect, useRef, useState } from "react";
import type { ModelOption } from "../types";
import { choiceName, MODEL_CHOICES, modelLabel } from "../lib/models";
import { SparkIcon } from "./icons";

/** claude lists its recommended picks first; everything after these is an older version. */
const PRIMARY = 5;

interface Props {
  /** The model claude says it is running, from its init message. */
  running: string | null;
  /** What the user picked; null = Claude Code's default. */
  chosen: string | null;
  /** The model claude ran with when nothing was chosen, if seen; names what "Default" means. */
  defaultModel?: string | null;
  /** Model ids claude reported for each alias, so rows can show versions. */
  ids?: Record<string, string>;
  /** The models claude offers (from its initialize reply); until they arrive, a built-in short list. */
  options?: ModelOption[];
  onChoose: (model: string | null) => void;
  disabled?: boolean;
}

interface Row {
  /** null = Default (no --model). */
  value: string | null;
  name: string;
  hint: string;
}

// The model chip in the composer footer; it opens a menu above it. A change applies from the next message.
export function ModelPicker({ running, chosen, defaultModel = null, ids = {}, options = [], onChoose, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [showOlder, setShowOlder] = useState(false);
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

  const resolvedDefault = (chosen === null && running) || options.find((o) => o.value === "default")?.resolved_model || defaultModel;
  const rows: Row[] = options.length
    ? options.map((o) =>
        o.value === "default"
          ? { value: null, name: choiceName(null, resolvedDefault), hint: "Claude Code's setting" }
          : { value: o.value, name: o.display_name || modelLabel(o.value), hint: o.description },
      )
    : MODEL_CHOICES.map((c) => ({ value: c.value, name: choiceName(c.value, resolvedDefault, ids), hint: c.hint }));

  // Until the next turn's init confirms a switch, show what was chosen rather than the model still running.
  const confirmed = running && chosen !== null && running.includes(chosen);
  const label = confirmed ? modelLabel(running) : (rows.find((r) => r.value === chosen)?.name ?? choiceName(chosen, resolvedDefault, ids));

  // Older versions stay folded away, unless the one in use is among them.
  const older = rows.slice(PRIMARY);
  const olderOpen = showOlder || older.some((r) => r.value === chosen);

  const row = (r: Row) => (
    <button
      key={r.value ?? "default"}
      role="menuitemradio"
      aria-checked={r.value === chosen}
      className={`menu-row${r.value === chosen ? " current" : ""}`}
      onClick={() => {
        setOpen(false);
        if (r.value !== chosen) onChoose(r.value);
      }}
    >
      <span className="menu-row-title">{r.name}</span>
      <span className="menu-row-meta">{r.hint}</span>
    </button>
  );

  return (
    <div className="model-picker" ref={root} onClick={(e) => e.stopPropagation()}>
      <button className="composer-item model-button" aria-haspopup="menu" aria-expanded={open} disabled={disabled} title="Model" onClick={() => setOpen(!open)}>
        <SparkIcon />
        {label}
        <span className="chev down" aria-hidden />
      </button>
      {open && (
        <div className="menu model-menu" role="menu" aria-label="Model">
          {rows.slice(0, PRIMARY).map(row)}
          {older.length > 0 && (
            <>
              <button className="menu-heading menu-toggle" aria-expanded={olderOpen} onClick={() => setShowOlder(!olderOpen)}>
                <span className="chev" aria-hidden />
                Older models
              </button>
              {olderOpen && older.map(row)}
            </>
          )}
        </div>
      )}
    </div>
  );
}
