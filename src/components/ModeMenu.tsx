import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Mode } from "../types";
import { useModeGuide } from "../lib/modeGuide";
import { BoltIcon, BugIcon, InfoIcon, PlanIcon, ShieldIcon, StepsIcon } from "./icons";
import { modeName } from "./ModeGuide";

const MODES: { value: Mode; label: string; hint: string; icon: ReactNode }[] = [
  { value: "ask", label: "Ask before actions", hint: "Edits apply; commands and other actions ask you first", icon: <ShieldIcon /> },
  { value: "auto", label: "Auto-approve", hint: "A classifier approves most actions; you're rarely asked", icon: <BoltIcon /> },
  { value: "plan", label: "Plan first", hint: "Claude researches and proposes a plan; nothing changes until you approve it", icon: <PlanIcon /> },
  { value: "debug", label: "Debug", hint: "Claude adds temporary logs, has you reproduce the bug, then fixes the root cause", icon: <BugIcon /> },
  { value: "steps", label: "Step by step", hint: "Claude plans and builds one step at a time, shown as pages; Next approves each", icon: <StepsIcon /> },
];

// Learn ("teach") and Review are Step by step's other flavours (switched in its view), so the menu shows them as one.
const shown = (mode: Mode): Mode => (mode === "teach" || mode === "review" ? "steps" : mode);

// Under the chat box: how much Claude may do on its own. It opens a menu upwards, like the model chip.
export function ModeMenu({ mode, onChange, disabled }: { mode: Mode; onChange: (mode: Mode) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const guide = useModeGuide();
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

  const current = MODES.find((m) => m.value === shown(mode)) ?? MODES[0];
  return (
    <div className="model-picker mode-menu-anchor" ref={root}>
      <button className="meta-item mode-chip" aria-haspopup="menu" aria-expanded={open} disabled={disabled} title={current.hint} onClick={() => setOpen(!open)}>
        {current.icon}
        {modeName(mode)}
        <span className="chev down" aria-hidden />
      </button>
      {open && (
        <div className="menu model-menu mode-menu" role="menu" aria-label="Permission mode">
          {MODES.map((m) => (
            <button
              key={m.value}
              role="menuitemradio"
              aria-checked={m.value === shown(mode)}
              className={`menu-row${m.value === shown(mode) ? " current" : ""}`}
              onClick={() => {
                setOpen(false);
                if (m.value !== shown(mode)) onChange(m.value);
              }}
            >
              <span className="mode-icon">{m.icon}</span>
              <span className="mode-text">
                <span className="menu-row-title">{m.label}</span>
                <span className="mode-hint">{m.hint}</span>
              </span>
            </button>
          ))}
          {guide && (
            <>
              <div className="menu-sep" role="separator" />
              <button
                role="menuitem"
                className="menu-row mode-menu-more"
                onClick={() => {
                  setOpen(false);
                  guide(mode);
                }}
              >
                <span className="mode-icon">
                  <InfoIcon />
                </span>
                <span className="menu-row-title">How the modes work…</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
