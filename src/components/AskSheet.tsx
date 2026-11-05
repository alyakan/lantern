import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * The Desk's Ask over the board. It takes focus when it opens (the message box, when it has one) and gives it back to what had it
 * when it closes; Tab stays inside it; Escape or a press behind it puts it away. From a dropdown inside it, Escape only leaves the
 * dropdown, so the next one puts the sheet away.
 */
export function AskSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const from = document.activeElement as HTMLElement | null;
    const box = dialog.current?.querySelector<HTMLElement>("textarea");
    (box ?? dialog.current)?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "SELECT") return target.blur();
      close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      from?.focus?.();
    };
  }, []);
  const trap = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Tab") return;
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (all.length === 0) return e.preventDefault();
    const at = all.indexOf(document.activeElement as HTMLElement);
    // From outside the controls (the sheet itself), Tab goes to the first and Shift+Tab to the last.
    const to = e.shiftKey ? (at <= 0 ? all.length - 1 : at - 1) : (at + 1) % all.length;
    e.preventDefault();
    all[to].focus();
  };
  return (
    <div
      className="desk-ask-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section ref={dialog} className="desk-ask-sheet" role="dialog" aria-modal="true" aria-label="Ask across projects" tabIndex={-1} onKeyDown={trap}>
        <button className="desk-ask-close" aria-label="Close Ask" onClick={onClose}>
          ×
        </button>
        {children}
      </section>
    </div>
  );
}
