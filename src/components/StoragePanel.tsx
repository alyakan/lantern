import { useEffect, useRef } from "react";
import type { StorageView } from "../types";
import { StorageTab } from "./StorageTab";

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
 * the backdrop closes it, and focus stays inside while it is open. Not tied to a chat or a folder.
 */
export function StoragePanel({ open, onClose, view, onAsk, busy }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
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
          <StorageTab view={view} onAsk={onAsk} busy={busy} />
        </div>
      )}
    </dialog>
  );
}
