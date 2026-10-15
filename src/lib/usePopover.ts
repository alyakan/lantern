import { useEffect, useId, useRef } from "react";
import { useDismiss } from "./useDismiss";

/**
 * What a popover opened by a button needs: it closes on a press elsewhere or Escape (and Escape puts focus back on the
 * button), focus moves to its first control when it opens (`focusFirst`: unless it places focus itself), and the button
 * and the popover are tied together by `id` (aria-controls). Put the popover after its button in the page.
 */
export function usePopover(open: boolean, close: () => void, focusFirst = true) {
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  useDismiss(open, box, close);
  useEffect(() => {
    if (open && focusFirst) list.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, [open, focusFirst]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && button.current?.focus();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [open]);
  return { box, button, list, id };
}
