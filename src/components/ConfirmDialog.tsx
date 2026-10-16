import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";

/**
 * A question over the canvas for something that can't be undone. Opens on Cancel, so Enter or a stray press never confirms;
 * Escape or a press outside the box is Cancel too. An `alternative` is a third answer between the two ("Keep those"). Tab stays between the two buttons while it is open.
 */
export function ConfirmDialog({ title, children, confirmLabel, busyLabel, busy, onConfirm, onCancel, alternative }: { title: string; children: ReactNode; confirmLabel: string; busyLabel: string; busy: boolean; onConfirm: () => void; onCancel: () => void; alternative?: { label: string; onClick: () => void } }) {
  const id = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const from = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => from?.focus?.();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (!busy) onCancel();
    } else if (e.key === "Tab") {
      const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      if (buttons.length === 0) return e.preventDefault();
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const to = e.shiftKey ? (at <= 0 ? buttons.length - 1 : at - 1) : (at + 1) % buttons.length;
      e.preventDefault();
      buttons[to].focus();
    }
  };

  return (
    <div className="canvas-modal canvas-overlay" onPointerDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} onKeyDown={onKeyDown}>
        <h2 id={`${id}-title`}>{title}</h2>
        <div id={`${id}-body`} className="confirm-body">
          {children}
        </div>
        <div className="confirm-actions">
          <button ref={cancel} disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          {alternative && (
            <button disabled={busy} onClick={alternative.onClick}>
              {alternative.label}
            </button>
          )}
          <button className="danger" disabled={busy} onClick={onConfirm}>
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
