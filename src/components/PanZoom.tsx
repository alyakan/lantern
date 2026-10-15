import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { clampZoom, panBy, zoomAt, type View } from "../lib/canvas";

/** How far Fit zooms in on something small: enough to fill the room, not so far that a two-box map looks blown up. */
const FIT_MAX = 1.3;
const FIT_PAD = 20;

/** A rectangle in the content's own units. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Pans a PanZoom just far enough that `rect` is in view, for what moves focus inside it (the arrow keys between boxes). Null outside one. */
export const PanZoomReveal = createContext<((rect: Rect) => void) | null>(null);
export const useReveal = () => useContext(PanZoomReveal);

interface Props {
  /** The content's own size, in its units: what Fit frames. */
  width: number;
  height: number;
  label: string;
  /** When this changes the view frames the content again (new content); a resize does too, until you pan or zoom. */
  fitKey?: string;
  children: ReactNode;
}

/**
 * Something too big or too small to read where it sits, on a surface you can move: the wheel pans, pinch or ⌘-scroll
 * zooms around the pointer, dragging pans, and the buttons zoom or fit it back. A press that doesn't move is still a click
 * on what's under it.
 */
export function PanZoom({ width, height, label, fitKey = "", children }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 });
  const current = useRef(view);
  current.current = view;
  // Once you've moved it yourself, a resize leaves it where you put it.
  const touched = useRef(false);

  const fit = useCallback((animate = false) => {
    const el = box.current;
    if (!el) return;
    if (animate) {
      touched.current = false;
      const moving = world.current;
      moving?.classList.add("animating");
      window.clearTimeout(eased.current);
      eased.current = window.setTimeout(() => moving?.classList.remove("animating"), 320);
    }
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w <= 0 || h <= 0) return setView({ x: 0, y: 0, zoom: 1 });
    // The whole thing, centred, as big as the room allows.
    const zoom = clampZoom(Math.min(FIT_MAX, (w - 2 * FIT_PAD) / width, (h - 2 * FIT_PAD) / height));
    const next = { zoom, x: (w - width * zoom) / 2, y: (h - height * zoom) / 2 };
    setView(next);
  }, [width, height]);
  useLayoutEffect(() => {
    touched.current = false;
    fit();
  }, [fitKey, fit]);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => !touched.current && fit());
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);

  const apply = (v: View) => {
    world.current?.classList.remove("animating");
    touched.current = true;
    setView(v);
  };
  // A jump (a button, the lit box coming into view) eases like the canvas's; a gesture follows the pointer, so it must not.
  const world = useRef<HTMLDivElement>(null);
  const eased = useRef(0);
  const ease = (v: View) => {
    const el = world.current;
    el?.classList.add("animating");
    window.clearTimeout(eased.current);
    eased.current = window.setTimeout(() => el?.classList.remove("animating"), 320);
    touched.current = true;
    setView(v);
  };
  /** Just far enough that `r` is inside the room, with a margin: not at all when it already is. */
  const reveal = useCallback((r: Rect) => {
    const el = box.current;
    if (!el) return;
    const v = current.current;
    const pad = 24;
    const left = r.x * v.zoom + v.x;
    const top = r.y * v.zoom + v.y;
    const shift = (from: number, size: number, room: number) => (from < pad ? pad - from : from + size > room - pad ? Math.min(0, room - pad - (from + size)) : 0) ;
    // Wider than the room: its start is what is wanted.
    const dx = r.w * v.zoom > el.clientWidth - 2 * pad ? pad - left : shift(left, r.w * v.zoom, el.clientWidth);
    const dy = r.h * v.zoom > el.clientHeight - 2 * pad ? pad - top : shift(top, r.h * v.zoom, el.clientHeight);
    if (dx !== 0 || dy !== 0) ease(panBy(v, dx, dy));
  }, []);
  const centre = () => ({ x: (box.current?.clientWidth ?? 0) / 2, y: (box.current?.clientHeight ?? 0) / 2 });

  // Native listeners, because React's wheel handlers can't cancel the page's own zoom. WebKit sends a pinch as gestures.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const at = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) apply(zoomAt(current.current, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.004)), at(e)));
      else apply(panBy(current.current, -e.deltaX, -e.deltaY));
    };
    let last = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      last = 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      apply(zoomAt(current.current, g.scale / last, at(g)));
      last = g.scale;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
    };
  }, []);

  // Dragging pans. The pointer isn't captured until it has moved, so a press that stays put clicks what's under it.
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) e.currentTarget.setPointerCapture?.(e.pointerId);
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    apply(panBy(current.current, dx, dy));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    // A drag that ends over a box isn't a click on it.
    if (d?.moved) {
      const swallow = (c: MouseEvent) => (c.stopPropagation(), c.preventDefault());
      e.currentTarget.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => box.current?.removeEventListener("click", swallow, { capture: true }), 0);
    }
  };

  return (
    <div className="pz">
      <div ref={box} className={`pz-surface${drag.current?.moved ? " dragging" : ""}`} role="group" aria-label={label} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => (drag.current = null)}>
        <div ref={world} className="pz-world" style={{ width, height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
          <PanZoomReveal.Provider value={reveal}>{children}</PanZoomReveal.Provider>
        </div>
      </div>
      <div className="pz-tools" role="group" aria-label="Zoom">
        <button aria-label="Zoom out" title="Zoom out (or pinch, or ⌘-scroll)" onClick={() => ease(zoomAt(view, 1 / 1.25, centre()))}>
          −
        </button>
        <span className="pz-level" aria-label="Zoom level">
          {Math.round(view.zoom * 100)}%
        </span>
        <button aria-label="Zoom in" title="Zoom in (or pinch, or ⌘-scroll)" onClick={() => ease(zoomAt(view, 1.25, centre()))}>
          +
        </button>
        <button aria-label="Fit" title="Fit the whole map in view" onClick={() => fit(true)}>
          Fit
        </button>
      </div>
    </div>
  );
}
