import { useLayoutEffect, type RefObject } from "react";

/** Room kept between a dropdown and the window's edge. */
const MARGIN = 12;
/** The gap between a dropdown and what it opens from (the menus' `calc(100% + 6px)`). */
const GAP = 6;

/**
 * Keeps a dropdown inside the window, whichever way it opens as styled. When it doesn't fit that way and there's more
 * room the other way, it opens there instead, and either way it's never taller than the room it has (its list
 * scrolls). Measured again when `deps` change (its contents loaded) and when the window is resized.
 */
export function useFitMenu(menu: RefObject<HTMLElement | null>, deps: unknown[] = []) {
  useLayoutEffect(() => {
    const el = menu.current;
    if (!el) return;
    const fit = () => {
      el.style.maxHeight = "";
      el.style.top = "";
      el.style.bottom = "";
      const r = el.getBoundingClientRect();
      const from = (el.offsetParent ?? el.parentElement)?.getBoundingClientRect();
      // Above, the room ends at the title bar (drawn over the window's top), not at the window's edge.
      const ceiling = document.querySelector(".app-body")?.getBoundingClientRect().top ?? 0;
      const opensUp = !!from && r.bottom <= from.top + 1;
      if (opensUp) {
        // Styled to open upward (the menus under the chat box): it fits while its top is below the title bar.
        if (r.top >= ceiling + MARGIN) return;
        const above = from.top - GAP - MARGIN - ceiling;
        const below = window.innerHeight - from.bottom - GAP - MARGIN;
        if (below > above) {
          el.style.top = `calc(100% + ${GAP}px)`;
          el.style.bottom = "auto";
          el.style.maxHeight = `${Math.floor(below)}px`;
        } else {
          el.style.maxHeight = `${Math.floor(above)}px`;
        }
        return;
      }
      const below = window.innerHeight - r.top - MARGIN;
      if (r.height <= below) return;
      const above = (from?.top ?? r.top) - GAP - MARGIN - ceiling;
      if (above > below) {
        el.style.top = "auto";
        el.style.bottom = `calc(100% + ${GAP}px)`;
        el.style.maxHeight = `${Math.floor(above)}px`;
      } else {
        el.style.maxHeight = `${Math.floor(below)}px`;
      }
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, deps);
}
