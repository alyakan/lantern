import { memo, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  bounds,
  centerOn,
  clampZoom,
  firstBox,
  fitView,
  GAP,
  moveBox,
  panBy,
  placeWorker,
  resizeBox,
  SUMMARY_ZOOM,
  tether,
  zoomAt,
  type Box,
  type Size,
  type View,
} from "../lib/canvas";
import { useChatState, useChatStates, useNodeActions } from "../lib/canvasContext";
import { money, nodeStatus, readyToMerge, STATUS_LABEL, summaryLine, type NodeStatus, type OrchestraNode } from "../lib/orchestraView";
import { totalCost, type State } from "../store";
import { NodeBody } from "./NodeBody";
import { BranchIcon, ChevronIcon, OpenOutIcon } from "./icons";

/** Where agents sit and how the canvas is framed. The app keeps it, so leaving the canvas and coming back finds it as it was. */
export interface CanvasLayout {
  boxes: Record<string, Box>;
  view: View | null;
  /** The user has moved the view themselves, so new agents no longer re-frame it. */
  touched: boolean;
  /** Agents folded to their title bar. */
  collapsed: Record<string, boolean>;
  /** Agents back to front. */
  order: string[];
}

export const newLayout = (): CanvasLayout => ({ boxes: {}, view: null, touched: false, collapsed: {}, order: [] });

/** Gives every agent a place (new ones go beside their main agent, in free space) and forgets agents that are gone. */
export function placeNodes(layout: CanvasLayout, nodes: { slot: string; role: "main" | "worker"; parent: string | null }[]): void {
  const live = new Set(nodes.map((n) => n.slot));
  for (const slot of Object.keys(layout.boxes)) if (!live.has(slot)) delete layout.boxes[slot];
  for (const n of nodes) {
    if (layout.boxes[n.slot]) continue;
    const all = Object.values(layout.boxes);
    const parent = n.parent ? layout.boxes[n.parent] : undefined;
    if (n.role === "worker" && parent) {
      layout.boxes[n.slot] = placeWorker(all, parent);
    } else {
      // A main agent (or a worker whose main agent is gone) goes below whatever is already there.
      const b = bounds(all);
      layout.boxes[n.slot] = b ? { ...firstBox(), x: b.x, y: b.y + b.h + GAP * 2 } : firstBox();
    }
  }
  layout.order = [...layout.order.filter((s) => live.has(s)), ...nodes.map((n) => n.slot).filter((s) => !layout.order.includes(s))];
}

/** A folded agent shows its title bar only. */
const COLLAPSED_HEIGHT = 52;
const MODE_LABEL = { ask: "Ask", auto: "Auto", steps: "Step by step" } as const;

interface Props {
  nodes: OrchestraNode[];
  layout: CanvasLayout;
  /** The agent whose chat the rest of the app treats as current. */
  activeSlot: string;
  /** Agents waiting on the user, in canvas order. */
  attention: string[];
  onFocus: (slot: string) => void;
  /** Shows one agent full size, in the chat view. */
  onOpen: (slot: string) => void;
}

interface FrameProps {
  slot: string;
  /** The main agent a worker reports to. */
  parent: string | null;
  role: "main" | "worker";
  name: string;
  branch: string | null;
  box: Box;
  z: number;
  focused: boolean;
  /** Zoomed out too far to read a chat: a card with the agent's latest words instead. */
  summary: boolean;
  collapsed: boolean;
  onGrab: (e: ReactPointerEvent<HTMLElement>, slot: string, kind: "move" | "resize") => void;
  onDrag: (e: ReactPointerEvent<HTMLElement>) => void;
  onRelease: (e: ReactPointerEvent<HTMLElement>) => void;
  onToggle: (slot: string) => void;
  onOpen: (slot: string) => void;
  onPress: (slot: string) => void;
  /** A card was clicked: zoom in on that agent. */
  onZoomTo: (slot: string) => void;
}

/** The agent's latest words and state, for the card that stands in for its chat when zoomed out or folded. */
function SummaryBody({ slot }: { slot: string }) {
  const state = useChatState(slot);
  if (!state) return null;
  const open = state.proposals.filter((p) => p.status === "open").length;
  return (
    <div className="node-summary">
      <p className="node-summary-line">{summaryLine(state, 220)}</p>
      {open > 0 && <p className="node-summary-note">{open === 1 ? "A merge is waiting for you" : `${open} merges are waiting for you`}</p>}
    </div>
  );
}

const Frame = memo(function Frame({ slot, parent, role, name, branch, box, z, focused, summary, collapsed, onGrab, onDrag, onRelease, onToggle, onOpen, onPress, onZoomTo }: FrameProps) {
  const state = useChatState(slot);
  const owner = useChatState(parent ?? slot);
  const status: NodeStatus = state ? nodeStatus(state) : "ended";
  const folded = collapsed;
  // A worker whose branch the main agent has asked the user to merge: that is what it is waiting on, and it's theirs to answer.
  const ready = !!parent && !!owner?.proposals.some((p) => p.worker === slot && p.status === "open");
  const label = ready && status === "idle" ? "Ready to merge" : STATUS_LABEL[status];
  const spent = state ? money(totalCost(state)) : "";
  return (
    <section
      className={`canvas-node ${role} ${status}${ready ? " ready" : ""}${focused ? " focused" : ""}${folded ? " folded" : ""}`}
      data-node={slot}
      aria-label={`${role === "main" ? "Main agent" : "Worker"} ${name}, ${label}`}
      style={{ transform: `translate(${box.x}px, ${box.y}px)`, width: box.w, height: folded ? COLLAPSED_HEIGHT : box.h, zIndex: z }}
      onPointerDownCapture={() => onPress(slot)}
    >
      <header className="node-head" onPointerDown={(e) => onGrab(e, slot, "move")} onPointerMove={onDrag} onPointerUp={onRelease} onPointerCancel={onRelease} onDoubleClick={() => onToggle(slot)}>
        <span className={`node-dot ${status}`} aria-hidden />
        <span className="node-titles">
          <span className="node-name" title={name}>
            {name}
          </span>
          <span className="node-meta" title={branch ?? undefined}>
            {branch && <BranchIcon />}
            {[role === "main" ? "Runs the team" : branch ? branch.replace(/^lantern\//, "") : "Shared folder", state ? MODE_LABEL[state.mode] : null, spent || null].filter(Boolean).join(" · ")}
          </span>
        </span>
        <span className="node-status">{label}</span>
        <button className="icon" aria-label={folded ? `Expand ${name}` : `Collapse ${name}`} title={folded ? "Expand" : "Collapse to its title"} onClick={() => onToggle(slot)}>
          <ChevronIcon up={!folded} />
        </button>
        <button className="icon" aria-label={`Open ${name} full size`} title="Open full size" onClick={() => onOpen(slot)}>
          <OpenOutIcon />
        </button>
      </header>
      {!folded && (
        <div className="node-body" onClick={summary ? () => onZoomTo(slot) : undefined} title={summary ? "Zoom in on this agent" : undefined}>
          {summary ? <SummaryBody slot={slot} /> : <NodeBody slot={slot} parent={parent} />}
        </div>
      )}
      {!folded && <div className="node-resize" aria-hidden onPointerDown={(e) => onGrab(e, slot, "resize")} onPointerMove={onDrag} onPointerUp={onRelease} onPointerCancel={onRelease} />}
    </section>
  );
});

/** A tether from a main agent to one of its workers: it flows while the worker works, and pulses when it needs you. */
const TetherLine = memo(function TetherLine({ slot, d }: { slot: string; d: string }) {
  const state = useChatState(slot);
  const status: NodeStatus = state ? nodeStatus(state) : "ended";
  return <path className={`tether ${status}`} data-tether={slot} d={d} />;
});

/**
 * Everyone on the team at a glance: who is doing what, what each has said last, and what the team has cost so far. A row
 * takes you to that agent. The team's cost counts every agent, however far off the canvas it is.
 */
/** What "Ask for an update" asks the main agent: a status report a person can read without knowing the code. */
export const UPDATE_REQUEST =
  "Give me a short status report in plain language: for each worker, what it has done, what it is doing now, and anything blocked or waiting for my decision. Look at each worker's latest work first if you need to. No code unless I ask.";

function Team({ nodes, onGoTo }: { nodes: OrchestraNode[]; onGoTo: (slot: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const actions = useNodeActions();
  const states = useChatStates(nodes.map((n) => n.slot));
  const bySlot: Record<string, State> = {};
  nodes.forEach((n, i) => {
    if (states[i]) bySlot[n.slot] = states[i]!;
  });
  const ready = readyToMerge(nodes, bySlot);
  const total = money(Object.values(bySlot).reduce((sum, s) => sum + totalCost(s), 0));
  const main = nodes.find((n) => n.role === "main");
  const mainState = main ? bySlot[main.slot] : undefined;
  const canAsk = !!main && !!mainState && (mainState.status === "idle" || mainState.status === "running") && nodes.some((n) => n.role === "worker");
  // Sent now when the main agent is free, and queued behind what it is doing when it isn't (like anything typed to it).
  const askForUpdate = () => {
    if (!main || !mainState) return;
    if (mainState.status === "running") actions.queue(main.slot, [...mainState.queued, UPDATE_REQUEST]);
    else actions.send(main.slot, UPDATE_REQUEST);
    setOpen(false);
    onGoTo(main.slot);
  };

  // Closes when you click anywhere else or press Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="canvas-team" ref={box}>
      {open && (
        <div className="canvas-team-list" role="dialog" aria-label="Team">
          <ul>
            {nodes.map((n) => {
              const s = bySlot[n.slot];
              if (!s) return null;
              const status = nodeStatus(s);
              const label = ready.has(n.slot) && status === "idle" ? "Ready to merge" : STATUS_LABEL[status];
              const spent = money(totalCost(s));
              return (
                <li key={n.slot}>
                  <button
                    onClick={() => {
                      setOpen(false);
                      onGoTo(n.slot);
                    }}
                  >
                    <span className={`node-dot ${status}`} aria-hidden />
                    <span className="team-text">
                      <span className="team-name">{n.name}</span>
                      <span className="team-line">{summaryLine(s, 90)}</span>
                    </span>
                    <span className="team-state">
                      {label}
                      {spent && <span className="team-cost">{spent}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {canAsk && (
            <button className="team-ask" onClick={askForUpdate} title="The main agent writes up where everything stands, in plain language">
              Ask the main agent for an update
            </button>
          )}
        </div>
      )}
      <button className="canvas-fit" aria-expanded={open} aria-label="Team" title="Everyone on the team, and what it has cost" onClick={() => setOpen(!open)}>
        Team{total ? ` · ${total}` : ""}
      </button>
    </div>
  );
}

function Controls({ zoom, attention, nodes, onZoom, onFit, onNext, onGoTo }: { zoom: number; attention: number; nodes: OrchestraNode[]; onZoom: (factor: number) => void; onFit: () => void; onNext: () => void; onGoTo: (slot: string) => void }) {
  return (
    <>
      {attention > 0 && (
        <button className="canvas-attention" onClick={onNext} title="Go to the next agent waiting for you">
          <span className="node-dot waiting" aria-hidden />
          {attention === 1 ? "1 agent needs you" : `${attention} agents need you`}
        </button>
      )}
      <div className="canvas-controls" role="group" aria-label="Canvas view">
        <button className="icon" aria-label="Zoom out" title="Zoom out" onClick={() => onZoom(1 / 1.25)}>
          −
        </button>
        <span className="canvas-zoom" aria-live="off">
          {Math.round(zoom * 100)}%
        </span>
        <button className="icon" aria-label="Zoom in" title="Zoom in" onClick={() => onZoom(1.25)}>
          +
        </button>
        <button className="canvas-fit" aria-label="Fit everything" title="Fit everything in view" onClick={onFit}>
          Fit
        </button>
        <Team nodes={nodes} onGoTo={onGoTo} />
      </div>
    </>
  );
}

const sameSize = (a: Size, b: Size) => a.w === b.w && a.h === b.h;

/**
 * The orchestra's canvas: each agent a floating chat, tethered to the main agent it works for. Drag a title to move one,
 * its corner to resize it, the background to pan, pinch or ⌘-scroll to zoom. Gestures are painted straight onto the
 * elements and only committed to React when they end, so nothing redraws a chat while you move around.
 */
export function Canvas({ nodes, layout, activeSlot, attention, onFocus, onOpen }: Props) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const size = useRef<Size>({ w: 0, h: 0 });
  const view = useRef<View>(layout.view ?? { x: 0, y: 0, zoom: 1 });
  const [zoomPct, setZoomPct] = useState(view.current.zoom);
  const [summary, setSummary] = useState(view.current.zoom < SUMMARY_ZOOM);
  const nextAttention = useRef(0);

  placeNodes(layout, nodes);

  /** Frames the canvas at `v`: straight onto the elements (no React), animated when it's a jump rather than a gesture. */
  const apply = useCallback((v: View, animate = false) => {
    view.current = v;
    layout.view = v;
    const w = world.current;
    const vp = viewport.current;
    if (w) {
      w.classList.toggle("animating", animate);
      w.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
      if (animate) window.setTimeout(() => w.classList.remove("animating"), 320);
    }
    if (vp) {
      vp.style.setProperty("--zoom", String(v.zoom));
      vp.style.setProperty("--vx", `${v.x}px`);
      vp.style.setProperty("--vy", `${v.y}px`);
    }
    // Only these two things in React depend on the zoom: the label, and whether agents are cards. Both are cheap.
    setSummary((prev) => (prev === v.zoom < SUMMARY_ZOOM ? prev : v.zoom < SUMMARY_ZOOM));
    setZoomPct((prev) => (Math.round(prev * 100) === Math.round(v.zoom * 100) ? prev : v.zoom));
  }, [layout]);

  const fit = useCallback((animate: boolean) => {
    const boxes = Object.values(layout.boxes);
    if (size.current.w === 0 || boxes.length === 0) return;
    apply(fitView(boxes, size.current), animate);
  }, [apply, layout]);

  // Track the canvas's size; the first time it is known (and whenever the user hasn't framed it themselves), frame the agents.
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const measure = () => {
      const next = { w: el.clientWidth, h: el.clientHeight };
      if (sameSize(size.current, next)) return;
      const first = size.current.w === 0;
      size.current = next;
      if (first && !layout.view) fit(false);
      else if (first) apply(layout.view!, false);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [apply, fit, layout]);

  // A new agent appears: until the user has framed the canvas, bring everyone into view.
  const slotKey = nodes.map((n) => n.slot).join(",");
  useEffect(() => {
    if (!layout.touched) fit(true);
  }, [slotKey, fit, layout]);

  const touch = () => {
    layout.touched = true;
  };

  // Wheel and pinch. Native listeners, because React's wheel handlers can't cancel the page's own zoom.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const rect = el.getBoundingClientRect();
      const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        touch();
        apply(zoomAt(view.current, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.004)), at));
        return;
      }
      // Over an agent the wheel scrolls its chat; anywhere else it pans.
      if ((e.target as Element).closest(".node-body")) return;
      e.preventDefault();
      touch();
      apply(panBy(view.current, -e.deltaX, -e.deltaY));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    // WebKit (the app's web view) sends a pinch as gesture events rather than ctrl+wheel.
    let last = 1;
    const at = (e: Event) => {
      const rect = el.getBoundingClientRect();
      const g = e as Event & { clientX: number; clientY: number };
      return { x: g.clientX - rect.left, y: g.clientY - rect.top };
    };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      last = 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const scale = (e as Event & { scale: number }).scale;
      touch();
      apply(zoomAt(view.current, scale / last, at(e)));
      last = scale;
    };
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
    };
  }, [apply, layout]);

  // Panning: drag the background.
  const pan = useRef<{ id: number; x: number; y: number } | null>(null);
  const onBackgroundDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (e.button !== 0 || !(t === e.currentTarget || t.classList.contains("canvas-world") || t.closest("svg.canvas-tethers"))) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pan.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    e.currentTarget.classList.add("panning");
    touch();
  };
  const onBackgroundMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    if (!p || p.id !== e.pointerId) return;
    apply(panBy(view.current, e.clientX - p.x, e.clientY - p.y));
    p.x = e.clientX;
    p.y = e.clientY;
  };
  const onBackgroundUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (pan.current?.id !== e.pointerId) return;
    pan.current = null;
    e.currentTarget.classList.remove("panning");
  };

  // Moving and resizing agents: painted onto the elements each frame, committed when released.
  const drag = useRef<{ id: number; kind: "move" | "resize"; slot: string; x: number; y: number; box: Box } | null>(null);
  const frame = useRef(0);
  const paint = useCallback(() => {
    frame.current = 0;
    const w = world.current;
    if (!w) return;
    for (const n of nodes) {
      const box = layout.boxes[n.slot];
      const el = w.querySelector<HTMLElement>(`[data-node="${n.slot}"]`);
      if (!box || !el) continue;
      el.style.transform = `translate(${box.x}px, ${box.y}px)`;
      el.style.width = `${box.w}px`;
      if (!layout.collapsed[n.slot]) el.style.height = `${box.h}px`;
      const parent = n.parent ? layout.boxes[n.parent] : undefined;
      const line = parent && w.querySelector(`[data-tether="${n.slot}"]`);
      if (parent && line) line.setAttribute("d", tether(parent, box).d);
    }
  }, [layout, nodes]);

  const bringToFront = useCallback((slot: string) => {
    if (layout.order[layout.order.length - 1] === slot) return;
    layout.order = [...layout.order.filter((s) => s !== slot), slot];
    redraw();
  }, [layout]);

  const onPress = useCallback((slot: string) => {
    onFocus(slot);
    bringToFront(slot);
  }, [onFocus, bringToFront]);

  const onGrab = useCallback((e: ReactPointerEvent<HTMLElement>, slot: string, kind: "move" | "resize") => {
    if (e.button !== 0 || (e.target as Element).closest("button")) return;
    // No text selection while dragging.
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { id: e.pointerId, kind, slot, x: e.clientX, y: e.clientY, box: { ...layout.boxes[slot] } };
  }, [layout]);

  const onDrag = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    layout.boxes[d.slot] = d.kind === "move" ? moveBox(d.box, dx, dy, view.current.zoom) : resizeBox(d.box, dx, dy, view.current.zoom);
    if (!frame.current) frame.current = requestAnimationFrame(paint);
  }, [layout, paint]);

  const onRelease = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    if (frame.current) cancelAnimationFrame(frame.current);
    paint();
    redraw();
  }, [paint]);

  const onToggle = useCallback((slot: string) => {
    layout.collapsed[slot] = !layout.collapsed[slot];
    redraw();
  }, [layout]);

  const zoomBy = (factor: number) => {
    touch();
    apply(zoomAt(view.current, factor, { x: size.current.w / 2, y: size.current.h / 2 }), true);
  };

  /** Brings one agent to the middle of the canvas, zoomed in far enough to read its chat. */
  const goTo = useCallback((slot: string) => {
    const box = layout.boxes[slot];
    if (!box) return;
    layout.touched = true;
    // Big enough to read, but never past what fits: an agent taller than the canvas is shown whole.
    const fits = Math.min(1, (size.current.w - 48) / box.w, (size.current.h - 48) / box.h);
    apply(centerOn(box, size.current, clampZoom(Math.max(view.current.zoom, SUMMARY_ZOOM + 0.2, Math.min(1, fits)))), true);
    onFocus(slot);
    bringToFront(slot);
  }, [layout, apply, onFocus, bringToFront]);
  const next = () => {
    if (attention.length === 0) return;
    goTo(attention[nextAttention.current++ % attention.length]);
  };

  const initial = view.current;
  return (
    <div
      className={`canvas${summary ? " summary" : ""}`}
      ref={viewport}
      data-testid="canvas"
      style={{ "--zoom": initial.zoom, "--vx": `${initial.x}px`, "--vy": `${initial.y}px` } as CSSProperties}
      onPointerDown={onBackgroundDown}
      onPointerMove={onBackgroundMove}
      onPointerUp={onBackgroundUp}
      onPointerCancel={onBackgroundUp}
    >
      <div className="canvas-world" ref={world} style={{ transform: `translate(${initial.x}px, ${initial.y}px) scale(${initial.zoom})` }}>
        <svg className="canvas-tethers" aria-hidden>
          {nodes.map((n) => {
            const parent = n.parent ? layout.boxes[n.parent] : undefined;
            const box = layout.boxes[n.slot];
            return parent && box ? <TetherLine key={n.slot} slot={n.slot} d={tether(parent, box).d} /> : null;
          })}
        </svg>
        {nodes.map((n) => (
          <Frame
            key={n.slot}
            slot={n.slot}
            parent={n.parent}
            role={n.role}
            name={n.name}
            branch={n.branch}
            box={layout.boxes[n.slot]}
            z={layout.order.indexOf(n.slot) + 1}
            focused={n.slot === activeSlot}
            summary={summary}
            collapsed={!!layout.collapsed[n.slot]}
            onGrab={onGrab}
            onDrag={onDrag}
            onRelease={onRelease}
            onToggle={onToggle}
            onOpen={onOpen}
            onPress={onPress}
            onZoomTo={goTo}
          />
        ))}
      </div>
      <Controls zoom={zoomPct} attention={attention.length} nodes={nodes} onZoom={zoomBy} onFit={() => { layout.touched = false; fit(true); }} onNext={next} onGoTo={goTo} />
    </div>
  );
}
