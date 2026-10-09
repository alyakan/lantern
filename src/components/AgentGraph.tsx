import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { LABEL_DEPTH, branchOf, branchView, fit, neighbor, trailTo, wholeView, zoomTarget, type Direction, type AgentGraph as Graph, type GraphEdge, type GraphNode, type View } from "../lib/agentGraph";

/** A dot travelling along an edge: down (handing work over) or up (handing it back), red when it failed. */
interface Pulse {
  key: number;
  edge: string;
  up: boolean;
  failed: boolean;
}

const PULSE_MS = 900;
const ZOOM_MS = 380;
const R = 19;
/** A workflow's box: its name, its phase under it. */
const WF_W = 124;
const WF_H = 40;
/** A tool leaf's box. */
const LEAF_W = 76;
/** How many characters fit across a box with 8px of room on each side, at an average character width. */
const fits = (width: number, perChar: number) => Math.floor((width - 2 * 8) / perChar);
const ARROWS: Record<string, Direction> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** The path an edge takes: a curve down the tree, or a straight line across to the advisor. */
function edgePath(e: GraphEdge, nodes: Map<string, GraphNode>): string {
  const a = nodes.get(e.from)!;
  const b = nodes.get(e.to)!;
  if (e.dashed) return `M ${a.x - R - 4} ${a.y} L ${b.x + R + 4} ${b.y}`;
  // From under the label and model, so the line doesn't cross them; a workflow's box holds its own.
  const y1 = a.y + (a.kind === "workflow" ? WF_H / 2 + 4 : LABEL_DEPTH);
  const y2 = b.y - (b.kind === "leaf" ? 14 : b.kind === "workflow" ? WF_H / 2 + 4 : R + 6);
  const mid = (y1 + y2) / 2;
  return `M ${a.x} ${y1} C ${a.x} ${mid}, ${b.x} ${mid}, ${b.x} ${y2}`;
}

/**
 * The latest turn as a live graph: each agent a node in its model's colour with a status ring, its kinds of tools as
 * leaves, and work travelling the edges as it happens. Hover or click a node for what it's doing.
 */
export function AgentGraph({ graph }: { graph: Graph }) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const seq = useRef(0);
  // Each step's status last time, to tell what just started or ended.
  const seen = useRef<Record<string, string> | null>(null);
  // Pulses are taken away when they've arrived, even if the graph changed meanwhile; only leaving stops that.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  useEffect(() => {
    const before = seen.current;
    seen.current = Object.fromEntries(Object.entries(graph.stepEdge).map(([id, s]) => [id, s.status]));
    // The first look (or a reopened session) has nothing to compare with: no motion for what already happened.
    if (!before || reducedMotion()) return;
    const add: Pulse[] = [];
    for (const [id, s] of Object.entries(graph.stepEdge)) {
      const was = before[id];
      if (was === undefined) {
        add.push({ key: ++seq.current, edge: s.edge, up: false, failed: false });
        if (s.via) add.push({ key: ++seq.current, edge: s.via, up: false, failed: false });
      } else if (was === "running" && s.status !== "running") {
        add.push({ key: ++seq.current, edge: s.edge, up: true, failed: s.status === "error" });
      }
    }
    if (add.length === 0) return;
    setPulses((p) => [...p, ...add]);
    const keys = new Set(add.map((p) => p.key));
    timers.current.push(setTimeout(() => setPulses((p) => p.filter((x) => !keys.has(x.key))), PULSE_MS + 100));
  }, [graph]);

  // Zoomed into a node's branch (null: the whole graph). A node that's gone (a new turn) zooms back out.
  const [focus, setFocus] = useState<string | null>(null);
  const focused = focus && nodes.has(focus) ? focus : null;
  const branch = focused ? branchOf(graph, focused) : null;
  const target = focused ? branchView(graph, focused) : wholeView(graph);
  // The view glides to its target; Reduce Motion jumps.
  const [view, setView] = useState<View>(target);
  const from = useRef<View>(target);
  const frame = useRef(0);
  const key = `${target.x},${target.y},${target.w},${target.h}`;
  useEffect(() => {
    cancelAnimationFrame(frame.current);
    const start = from.current;
    if (reducedMotion() || typeof requestAnimationFrame === "undefined") {
      from.current = target;
      setView(target);
      return;
    }
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ZOOM_MS);
      const ease = 1 - Math.pow(1 - k, 3);
      const v = { x: start.x + (target.x - start.x) * ease, y: start.y + (target.y - start.y) * ease, w: start.w + (target.w - start.w) * ease, h: start.h + (target.h - start.h) * ease };
      from.current = v;
      setView(v);
      if (k < 1) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame.current);
  }, [key]);

  // A click zooms into the node's branch (a tool leaf's: its agent's), and shows it below; again zooms back out.
  const choose = (id: string) => {
    const to = zoomTarget(graph, id);
    if (focused === to && pinned === id) {
      setFocus(null);
      setPinned(null);
    } else {
      setFocus(to === "main" ? null : to);
      setPinned(id);
    }
  };
  const zoomOut = () => {
    setFocus(null);
    setPinned(null);
  };

  // Arrow keys move between nodes (the panel follows, and a zoom follows out of its branch); Enter zooms, Esc out.
  const svg = useRef<SVGSVGElement>(null);
  const select = (id: string) => {
    setPinned(id);
    if (focused && !branchOf(graph, focused).has(id)) setFocus(zoomTarget(graph, id) === "main" ? null : zoomTarget(graph, id));
    svg.current?.querySelector<SVGGElement>(`[data-node=${JSON.stringify(id)}]`)?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    const dir = ARROWS[e.key];
    if (dir) {
      e.preventDefault();
      const from = pinned ?? hovered;
      const to = from ? neighbor(graph, from, dir) : "main";
      if (to) select(to);
    } else if (e.key === "Escape" && focused) {
      zoomOut();
    }
  };

  const shown = nodes.get(pinned ?? hovered ?? "") ?? null;
  const live = graph.nodes.some((n) => n.status === "running");
  return (
    <div className="agent-graph" onKeyDown={onKey}>
      <nav className="graph-trail" aria-label="Zoom">
        <button className={focused ? "" : "current"} onClick={zoomOut} disabled={!focused}>
          Whole graph
        </button>
        {focused &&
          trailTo(graph, focused).map((n) => (
            <span key={n.id} className="graph-trail-step">
              <span aria-hidden>›</span>
              <button className={n.id === focused ? "current" : ""} onClick={() => (n.id === "main" ? zoomOut() : setFocus(n.id))}>
                {n.label}
              </button>
            </span>
          ))}
      </nav>
      <svg ref={svg} viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Agent graph" tabIndex={-1}>
        {graph.edges.map((e) => (
          <path key={e.id} d={edgePath(e, nodes)} className={`graph-edge tone-${nodes.get(e.to)!.kind === "leaf" ? nodes.get(e.from)!.tone : nodes.get(e.to)!.tone}${e.active ? " active" : ""}${e.dashed ? " dashed" : ""}${live && !e.active ? " idle" : ""}${branch && !branch.has(e.to) ? " out" : ""}`} />
        ))}
        {pulses.map((p) => {
          const e = graph.edges.find((x) => x.id === p.edge);
          if (!e) return null;
          return (
            <circle key={p.key} r={4} className={`graph-pulse${p.failed ? " failed" : ""} tone-${nodes.get(e.to)!.kind === "leaf" ? nodes.get(e.from)!.tone : nodes.get(e.to)!.tone}`}>
              <animateMotion dur={`${PULSE_MS}ms`} fill="freeze" path={edgePath(e, nodes)} keyPoints={p.up ? "1;0" : "0;1"} keyTimes="0;1" calcMode="linear" />
            </circle>
          );
        })}
        {graph.nodes.map((n) => (
          <g
            key={n.id}
            className={`graph-node ${n.kind} ${n.status} tone-${n.tone}${shown?.id === n.id ? " selected" : ""}${branch && !branch.has(n.id) ? " out" : ""}`}
            style={{ transform: `translate(${n.x}px, ${n.y}px)` }}
            tabIndex={0}
            data-node={n.id}
            role="button"
            aria-label={`${n.label} ${n.sub}: ${n.status}`}
            onMouseEnter={() => setHovered(n.id)}
            onMouseLeave={() => setHovered(null)}
            onFocus={() => setHovered(n.id)}
            onBlur={() => setHovered(null)}
            onClick={() => choose(n.id)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), choose(n.id))}
          >
            {n.kind === "workflow" ? (
              <>
                <rect x={-WF_W / 2 - 4} y={-WF_H / 2 - 4} width={WF_W + 8} height={WF_H + 8} rx={14} className="graph-ring" />
                <rect x={-WF_W / 2} y={-WF_H / 2} width={WF_W} height={WF_H} rx={10} className="graph-workflow" />
                <title>{n.label}</title>
                <text className="graph-workflow-name" y={-2}>
                  {fit(n.label, fits(WF_W, 6.6))}
                </text>
                <text className="graph-workflow-phase" y={12}>
                  {fit(n.sub, fits(WF_W, 6.4))}
                </text>
              </>
            ) : n.kind === "leaf" ? (
              <>
                <title>{`${n.label} ${n.sub}`}</title>
                <rect x={-LEAF_W / 2} y={-13} width={LEAF_W} height={26} rx={13} className="graph-leaf" />
                <text className="graph-leaf-text" y={4}>
                  {fit(n.label, fits(LEAF_W, 5.6) - n.sub.length - 1)} <tspan className="graph-count">{n.sub}</tspan>
                </text>
              </>
            ) : (
              <>
                <circle r={R + 5} className="graph-ring" />
                <circle r={R} className="graph-dot" />
                <text className="graph-initial" y={5}>
                  {n.kind === "main" ? "M" : n.kind === "advisor" ? "A" : n.label.charAt(0).toUpperCase()}
                </text>
                <text className="graph-label" y={R + 22}>
                  {n.label.length > 16 ? `${n.label.slice(0, 15)}…` : n.label}
                </text>
                <text className="graph-model" y={R + 36}>
                  {n.sub}
                </text>
              </>
            )}
          </g>
        ))}
      </svg>
      <div className="graph-panel" aria-live="polite">
        {shown ? (
          <>
            <div className="graph-panel-title">
              <span className={`agents-model tone-${shown.tone}`}>{shown.label}</span> {shown.sub}
              <span className={`graph-panel-status ${shown.status}`}>{shown.status === "error" ? "failed" : shown.status}</span>
            </div>
            {shown.detail.map((d, i) => (
              <div key={i} className="graph-panel-line">
                {d}
              </div>
            ))}
          </>
        ) : (
          <div className="graph-panel-hint">Hover a node to see what it's doing; click it (or Enter) to zoom in. Arrow keys move between nodes.</div>
        )}
      </div>
    </div>
  );
}
