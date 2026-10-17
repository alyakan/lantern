import { useEffect, useRef, useState } from "react";
import { lastStorageTab, rememberStorageTab, type StorageTabName } from "../lib/memory";
import type { StorageView } from "../types";
import { MemoryTab } from "./MemoryTab";
import { StorageTab } from "./StorageTab";

const TABS: { name: StorageTabName; label: string }[] = [
  { name: "disk", label: "Disk" },
  { name: "memory", label: "Memory" },
];

interface Props {
  open: boolean;
  onClose: () => void;
  view: StorageView | null;
  /** Asks Claude, in the chat on screen, to scan and suggest; null when there's no chat to ask. */
  onAsk: (() => void) | null;
  /** Claude is in the middle of a turn in that chat: a request sent meanwhile waits until it ends. */
  busy?: boolean;
}

/**
 * The disk scan, opened from the title bar's Storage button. A dialog like Settings: the same size, Escape or a press on
 * the backdrop closes it, and focus stays inside while it is open. Not tied to a chat or a folder. Two tabs: Disk (the scan) and
 * Memory (how the RAM is used, view only); the one last used is the one it opens on.
 */
export function StoragePanel({ open, onClose, view, onAsk, busy }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState(lastStorageTab);
  const pick = (next: StorageTabName) => {
    setTab(next);
    rememberStorageTab(next);
  };
  // Left and Right move between the tabs, as in any tab list.
  const arrow = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = TABS[(TABS.findIndex((t) => t.name === tab) + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length].name;
    pick(next);
    (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`#storage-tab-${next}`)?.focus();
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // jsdom has no showModal or close: there, the attribute alone opens and closes it.
    if (open) {
      if (el.open) return;
      if (el.showModal) el.showModal();
      else el.setAttribute("open", "");
    } else if (el.open) {
      if (el.close) el.close();
      else el.removeAttribute("open");
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="mode-guide storage-panel"
      aria-label="Storage"
      onClose={onClose}
      // Escape in the delete confirmation answers that question only (it cancels itself): the dialog's own Escape, which
      // would take the whole panel with it, is stopped while the question is up. Seen before the question removes itself.
      onKeyDownCapture={(e) => e.key === "Escape" && e.currentTarget.querySelector(".confirm-dialog") && e.preventDefault()}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      {open && (
        <div className="storage-panel-body">
          <header className="storage-panel-head">
            <h2>Storage</h2>
            <div className="spacer" />
            <button onClick={onClose}>Close</button>
          </header>
          <div className="storage-tabs">
            <div className="pane-tabs-track" role="tablist" aria-label="Storage view" onKeyDown={arrow}>
              {TABS.map((t) => (
                <button key={t.name} id={`storage-tab-${t.name}`} role="tab" aria-selected={tab === t.name} aria-controls="storage-tabpanel" tabIndex={tab === t.name ? 0 : -1} className={tab === t.name ? "active" : ""} onClick={() => pick(t.name)}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div id="storage-tabpanel" className="storage-tabpanel" role="tabpanel" aria-labelledby={`storage-tab-${tab}`}>
            {tab === "memory" ? <MemoryTab /> : <StorageTab view={view} onAsk={onAsk} busy={busy} />}
          </div>
        </div>
      )}
    </dialog>
  );
}
