import { useEffect, type KeyboardEvent, type RefObject } from "react";

/** The items a menu, listbox or tab list offers: what the arrow keys move between. */
const ITEMS = '[role="menuitem"], [role="menuitemradio"], [role="option"], [role="tab"]';

/**
 * Arrow keys (and Home/End) move focus through `items`, wrapping. Returns the index it moved to, or null for any
 * other key, which is left alone.
 */
export function moveFocus(e: KeyboardEvent<HTMLElement>, items: HTMLElement[]): number | null {
  const n = items.length;
  if (!n) return null;
  const i = items.indexOf(document.activeElement as HTMLElement);
  const to =
    e.key === "ArrowDown" || e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowUp" || e.key === "ArrowLeft" ? (i <= 0 ? n - 1 : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
  if (to === null) return null;
  e.preventDefault();
  items[to].focus();
  return to;
}

/**
 * A menu that opens from a button in `root`. When it opens, focus goes to its checked (or first) item; the arrow keys
 * move between items (put the returned onKeyDown on the menu); when it closes, focus goes back to the button, unless
 * it has gone somewhere else meanwhile (focus left on the page would be lost).
 */
export function useMenuKeys(open: boolean, root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const items = [...(root.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    (items.find((el) => el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true") ?? items[0])?.focus();
    return () => {
      const active = document.activeElement;
      if (!active || active === document.body) root.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
    };
  }, [open]);
  return {
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      moveFocus(e, [...e.currentTarget.querySelectorAll<HTMLElement>(ITEMS)]);
    },
  };
}
