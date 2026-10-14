import { useEffect, useRef, type KeyboardEvent } from "react";
import { useDismiss } from "../lib/useDismiss";

export interface AgentMenuItem {
  key: string;
  label: string;
  /** One line under the label saying what it does (or why it can't now). */
  hint: string;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
}

const ITEM = '[role="menuitem"]:not(:disabled)';

/**
 * The menu of an agent's card (right-click): what the user can do with that agent without going through the main agent.
 * Opens on its first item; the arrow keys move between items, Enter chooses, Escape or a press elsewhere closes it, and
 * focus goes back to where it was.
 */
export function AgentMenu({ name, items, x, y, onDismiss }: { name: string; items: AgentMenuItem[]; x: number; y: number; onDismiss: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useDismiss(true, box, onDismiss);
  useEffect(() => {
    const from = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>(ITEM)?.focus();
    return () => from?.focus?.();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const enabled = [...(box.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])];
    const at = enabled.indexOf(document.activeElement as HTMLElement);
    const n = enabled.length;
    const to = e.key === "ArrowDown" ? (at + 1) % n : e.key === "ArrowUp" ? (at - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (to !== null && n > 0) {
      e.preventDefault();
      enabled[to].focus();
    } else if (e.key === "Tab") {
      e.preventDefault();
      onDismiss();
    }
  };

  return (
    <div className="canvas-menu canvas-overlay" role="menu" aria-label={`${name} actions`} ref={box} style={{ left: x, top: y }} onKeyDown={onKeyDown} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it) => (
        <button key={it.key} role="menuitem" className={it.danger ? "danger" : undefined} disabled={it.disabled} onClick={it.run}>
          <span className="menu-label">{it.label}</span>
          <span className="menu-hint">{it.hint}</span>
        </button>
      ))}
    </div>
  );
}
