import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type TransitionEvent } from "react";
import { clampRatio } from "../lib/layout";

const MIN_LEFT = 320;
const MIN_RIGHT = 360;
const DURATION = 220; // keep in sync with .split-side.animating in styles.css

interface Props {
  left: ReactNode;
  right: ReactNode;
  ratio: number;
  collapsed: boolean;
  onRatio: (ratio: number) => void;
}

type Phase = "open" | "closing" | "closed" | "opening";

const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
const nextFrame = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(fn));

// Collapsing slides the review pane out: its outer wrapper animates its width while the pane inside keeps
// its size, so the diff is clipped rather than squeezed and re-laid-out on every frame.
export function SplitPane({ left, right, ratio, collapsed, onRatio }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const side = useRef<HTMLDivElement>(null);
  const leftPane = useRef<HTMLDivElement>(null);
  // While dragging, the ratio lives here and moves the panes directly; the app hears it once, on release. Telling the
  // app on every move re-rendered the whole window (every message in the chat) for each pixel.
  const dragRatio = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>(collapsed ? "closed" : "open");
  const [width, setWidth] = useState(0); // animated wrapper width
  const [inner, setInner] = useState(0); // fixed pane width while animating

  // Width the side (handle + pane) takes when open: whatever the left pane's ratio leaves.
  const openWidth = () => {
    const el = root.current;
    if (!el) return MIN_RIGHT;
    const cs = getComputedStyle(el);
    const content = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return Math.max(MIN_RIGHT, content * (1 - ratio));
  };

  useLayoutEffect(() => {
    if (collapsed && (phase === "open" || phase === "opening")) {
      if (prefersReducedMotion() || !side.current) return setPhase("closed");
      const current = side.current.getBoundingClientRect().width;
      setInner(phase === "opening" ? inner : current);
      setWidth(current);
      setPhase("closing");
      nextFrame(() => setWidth(0));
    } else if (!collapsed && (phase === "closed" || phase === "closing")) {
      if (prefersReducedMotion()) return setPhase("open");
      const target = openWidth();
      setInner(target);
      setWidth(phase === "closing" && side.current ? side.current.getBoundingClientRect().width : 0);
      setPhase("opening");
      nextFrame(() => setWidth(target));
    }
    // Only a change of `collapsed` starts an animation.
  }, [collapsed]);

  const finish = () => setPhase((p) => (p === "closing" ? "closed" : p === "opening" ? "open" : p));
  const animating = phase === "closing" || phase === "opening";

  // Fallback in case transitionend never fires (e.g. the element was hidden mid-animation).
  useEffect(() => {
    if (!animating) return;
    const t = setTimeout(finish, DURATION + 100);
    return () => clearTimeout(t);
  }, [animating, phase]);

  const onTransitionEnd = (e: TransitionEvent<HTMLDivElement>) => {
    if (e.target === side.current && e.propertyName === "width") finish();
  };

  const clamped = (next: number) => clampRatio(next, root.current?.getBoundingClientRect().width ?? 0, MIN_LEFT, MIN_RIGHT);
  const setFrom = (next: number) => onRatio(clamped(next));
  const endDrag = () => {
    if (dragRatio.current !== null) onRatio(dragRatio.current);
    dragRatio.current = null;
    setDragging(false);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging || !root.current) return;
    const r = root.current.getBoundingClientRect();
    const next = clamped((e.clientX - r.left) / r.width);
    dragRatio.current = next;
    if (leftPane.current) leftPane.current.style.flexBasis = `${next * 100}%`;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") setFrom(ratio - 0.02);
    else if (e.key === "ArrowRight") setFrom(ratio + 0.02);
  };

  return (
    <div ref={root} className={`split${dragging ? " dragging" : ""}`}>
      <div ref={leftPane} className={`split-left${phase === "open" ? "" : " fill"}`} style={phase === "open" ? { flexBasis: `${ratio * 100}%` } : undefined}>
        {left}
      </div>
      {phase !== "closed" && (
        <div ref={side} className={`split-side${animating ? " animating" : ""}`} style={animating ? { width } : undefined} onTransitionEnd={onTransitionEnd}>
          <div className="split-side-inner" style={animating ? { width: inner } : undefined}>
            <div
              className="split-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the review panel"
              aria-valuenow={Math.round(ratio * 100)}
              tabIndex={0}
              title="Drag to resize, double-click to reset"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onDoubleClick={() => onRatio(0.5)}
              onKeyDown={onKeyDown}
            />
            <div className="split-right">{right}</div>
          </div>
        </div>
      )}
    </div>
  );
}
