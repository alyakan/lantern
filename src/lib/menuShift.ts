import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

const MARGIN = 8;

/**
 * How far along the x-axis to nudge a menu so it sits within `bounds`, keeping `margin` px clear of each edge. Returns 0
 * when it already fits. A menu wider than the region can't fit either way, so the left edge wins (callers cap the width
 * so that doesn't happen).
 */
export function menuShift(rect: { left: number; right: number }, bounds: { left: number; right: number }, margin = MARGIN): number {
  if (rect.left < bounds.left + margin) return bounds.left + margin - rect.left;
  if (rect.right > bounds.right - margin) return bounds.right - margin - rect.right;
  return 0;
}

/** The nearest ancestor that clips horizontal overflow (the menu must stay inside it), or null for the viewport. */
function clipEl(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (getComputedStyle(p).overflowX !== "visible") return p;
  }
  return null;
}

const boundsOf = (clip: Element | null) => {
  if (!clip) return { left: 0, right: window.innerWidth };
  const r = clip.getBoundingClientRect();
  return { left: r.left, right: r.right };
};

/**
 * Keeps an open dropdown menu on screen. Returns a ref for the menu element and a style to spread on it: while open it
 * caps the menu's width to its clipping ancestor (or the window) and nudges it horizontally so it stays inside, both
 * recomputed as that region resizes, and again when `deps` change (the menu's contents or width did).
 */
export function useMenuShift(open: boolean, deps: unknown[] = []) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>();
  useLayoutEffect(() => {
    if (!open) {
      setStyle(undefined);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const clip = clipEl(el);
    const reclamp = () => {
      const bounds = boundsOf(clip);
      const maxWidth = Math.max(0, bounds.right - bounds.left - 2 * MARGIN);
      // Natural left from the offset parent (a transform on the menu itself doesn't move these), so clamping never feeds
      // on its own previous shift.
      const parent = el.offsetParent as HTMLElement | null;
      const left = (parent ? parent.getBoundingClientRect().left : 0) + el.offsetLeft;
      const width = Math.min(el.offsetWidth, maxWidth);
      const shift = menuShift({ left, right: left + width }, bounds);
      setStyle({ maxWidth, transform: shift ? `translateX(${shift}px)` : undefined });
    };
    reclamp();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reclamp);
    observer.observe(clip ?? document.documentElement);
    return () => observer.disconnect();
  }, [open, ...deps]);
  return { ref, style };
}
