import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/** How far the pointer moves before a press becomes a drag (less is a click). */
export const DRAG_THRESHOLD = 4;
/** How close to the list's top or bottom edge the pointer scrolls it while dragging, and how fast at the edge. */
const EDGE = 36;
const EDGE_SPEED = 14;
/** How long the dropped item takes to settle into its slot, and the others to make room (none under Reduce Motion). */
export const SETTLE_MS = 160;

interface Drag {
  id: string;
  from: number;
  /** Each item's top (in the list's scrolled content) and height, measured when the drag began. */
  tops: number[];
  heights: number[];
  /** The space each item takes, the gap after it included (to the next one's top): what the others shift by to make room. */
  spans: number[];
  startY: number;
  startScroll: number;
  pointerY: number;
  dy: number;
  target: number;
  /** Following the pointer; settling into the target on drop; going back on Esc. */
  phase: "drag" | "settle" | "cancel";
}

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Where an item dragged from `from` and moved by `dy` lands: before the first other item whose middle it is above. */
export function dropIndex(tops: number[], heights: number[], from: number, dy: number): number {
  const middle = tops[from] + heights[from] / 2 + dy;
  let index = 0;
  for (let i = 0; i < tops.length; i++) if (i !== from && tops[i] + heights[i] / 2 < middle) index++;
  return index;
}

/** How far the item at `i` moves while `from` is over `target`: the ones it passed make room for it. */
export function shiftOf(i: number, from: number, target: number, span: number): number {
  if (from < target && i > from && i <= target) return -span;
  if (target < from && i >= target && i < from) return span;
  return 0;
}

/** Where the item from `from` ends up at `target`, from where it was: the top of the slot the others leave it. */
export function settleOf(tops: number[], spans: number[], from: number, target: number): number {
  if (target > from) return tops[target] + spans[target] - spans[from] - tops[from];
  if (target < from) return tops[target] - tops[from];
  return 0;
}

/**
 * Reordering a vertical list by dragging its items with the pointer: the item lifts and follows the pointer, the others
 * slide out of its way, the list scrolls near its edges, and on release it settles into its slot before `onMove` is told
 * (so the new order appears with nothing jumping). Esc puts it back. A press that doesn't move is still a click.
 *
 * Items are the elements in `list` with `data-reorder-id`, in `ids`' order.
 */
export function useReorder(ids: string[], list: RefObject<HTMLElement | null>, onMove: (id: string, index: number) => void) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const current = useRef<Drag | null>(null);
  current.current = drag;
  const press = useRef<{ id: string; y: number; pointer: number; target: HTMLElement } | null>(null);
  const justDragged = useRef(false);

  const update = (next: Partial<Drag>) => setDrag((d) => (d ? { ...d, ...next } : d));

  const follow = (pointerY: number) => {
    const d = current.current;
    const el = list.current;
    if (!d || !el || d.phase !== "drag") return;
    // It stays within the list's ends, so it never slides under the header or off the bottom.
    const last = d.tops.length - 1;
    const highest = -d.tops[d.from] + d.tops[0];
    const lowest = d.tops[last] + d.heights[last] - (d.tops[d.from] + d.heights[d.from]);
    const dy = Math.max(highest, Math.min(lowest, pointerY - d.startY + (el.scrollTop - d.startScroll)));
    update({ pointerY, dy, target: dropIndex(d.tops, d.heights, d.from, dy) });
  };

  const begin = (id: string, startY: number, pointerY: number) => {
    const el = list.current;
    const from = ids.indexOf(id);
    if (!el || from < 0) return;
    const base = el.getBoundingClientRect().top - el.scrollTop;
    const byId = new Map(Array.from(el.querySelectorAll<HTMLElement>("[data-reorder-id]")).map((item) => [item.dataset.reorderId, item]));
    const items = ids.map((i) => byId.get(i));
    if (items.some((i) => !i)) return;
    const rects = items.map((i) => i!.getBoundingClientRect());
    const tops = rects.map((r) => r.top - base);
    const heights = rects.map((r) => r.height);
    // To the next item's top, so a gap that differs after one item (a margin inside it) is counted as it is.
    const spans = tops.map((t, i) => (i + 1 < tops.length ? tops[i + 1] - t : heights[i] + parseFloat(getComputedStyle(items[i]!).marginBottom || "0")));
    setDrag({ id, from, tops, heights, spans, startY, startScroll: el.scrollTop, pointerY, dy: pointerY - startY, target: from, phase: "drag" });
  };

  const finish = (cancel: boolean) => {
    const d = current.current;
    if (!d || d.phase !== "drag") return;
    justDragged.current = true;
    setTimeout(() => (justDragged.current = false), 0);
    const target = cancel ? d.from : d.target;
    if (reducedMotion()) {
      if (target !== d.from) onMove(d.id, target);
      setDrag(null);
      return;
    }
    update({ phase: cancel ? "cancel" : "settle", target });
    setTimeout(() => {
      // The new order and the end of the drag in one render: the item is already where the new order puts it.
      if (target !== d.from) onMove(d.id, target);
      setDrag(null);
    }, SETTLE_MS);
  };

  // While dragging: the pointer anywhere in the window moves it, Esc puts it back, and the list scrolls near its edges.
  const dragging = drag?.phase === "drag";
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => follow(e.clientY);
    const up = () => finish(false);
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      finish(true);
    };
    let frame = requestAnimationFrame(function scroll() {
      const d = current.current;
      const el = list.current;
      if (d && el) {
        const r = el.getBoundingClientRect();
        const speed = d.pointerY < r.top + EDGE ? -EDGE_SPEED * Math.min(1, (r.top + EDGE - d.pointerY) / EDGE) : d.pointerY > r.bottom - EDGE ? EDGE_SPEED * Math.min(1, (d.pointerY - (r.bottom - EDGE)) / EDGE) : 0;
        if (speed !== 0) {
          const before = el.scrollTop;
          el.scrollTop += speed;
          if (el.scrollTop !== before) follow(d.pointerY);
        }
      }
      frame = requestAnimationFrame(scroll);
    });
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key, true);
    };
  }, [dragging]);

  /** On an item's handle (its header): a press that moves past the threshold starts dragging that item. */
  const handle = (id: string) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      // Only the main button, and not on the header's own buttons (+, ⋯), which are for clicking.
      if ((e.button ?? 0) !== 0 || (e.target as HTMLElement).closest("[data-no-drag]")) return;
      press.current = { id, y: e.clientY, pointer: e.pointerId, target: e.currentTarget };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const p = press.current;
      if (!p || current.current || Math.abs(e.clientY - p.y) < DRAG_THRESHOLD) return;
      press.current = null;
      p.target.setPointerCapture?.(p.pointer);
      begin(p.id, p.y, e.clientY);
    },
    onPointerUp: () => {
      press.current = null;
    },
  });

  /** On the list: the click that ends a drag isn't a click on what was dragged. */
  const onClickCapture = (e: ReactMouseEvent) => {
    if (!justDragged.current) return;
    e.preventDefault();
    e.stopPropagation();
  };

  /** Where each item is drawn while dragging (nothing otherwise). */
  const styleFor = (id: string): CSSProperties | undefined => {
    if (!drag) return undefined;
    const i = ids.indexOf(id);
    const ease = `transform ${SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1)`;
    if (id === drag.id) {
      const y = drag.phase === "drag" ? drag.dy : drag.phase === "settle" ? settleOf(drag.tops, drag.spans, drag.from, drag.target) : 0;
      return { transform: `translateY(${y}px)`, transition: drag.phase === "drag" ? "none" : ease, position: "relative", zIndex: 2 };
    }
    const shift = drag.phase === "cancel" ? 0 : shiftOf(i, drag.from, drag.target, drag.spans[drag.from]);
    return { transform: `translateY(${shift}px)`, transition: ease };
  };

  return { drag, handle, onClickCapture, styleFor, lifted: drag && drag.phase === "drag" ? drag.id : null };
}
