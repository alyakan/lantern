import { useEffect, useRef, type RefObject } from "react";

/** Calls `close` when the user presses outside `box` or presses Escape, for as long as `open`. */
export function useDismiss(open: boolean, box: RefObject<HTMLElement | null>, close: () => void) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && latest.current();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && latest.current();
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open, box]);
}
