import { useEffect, useRef, useState } from "react";
import { LABEL_DEPTH, type AgentGraph as Graph, type GraphEdge, type GraphNode } from "../lib/agentGraph";

/** A dot travelling along an edge: down (handing work over) or up (handing it back), red when it failed. */
interface Pulse {
  key: number;
  edge: string;
  up: boolean;
  failed: boolean;
}

const PULSE_MS = 900;
const R = 19;

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** The path an edge takes: a curve down the tree, or a straight line across to the advisor. */
function edgePath(e: GraphEdge, nodes: Map<string, GraphNode>): string {
  const a = nodes.get(e.from)!;
  const b = nodes.get(e.to)!;
  if (e.dashed) return `M ${a.x - R - 4} ${a.y} L ${b.x + R + 4} ${b.y}`;
  // From under the label and model, so the line doesn't cross them.
  const y1 = a.y + LABEL_DEPTH;
  const y2 = b.y - (b.kind === "leaf" ? 14 : R + 6);
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

  const shown = nodes.get(pinned ?? hovered ?? "") ?? null;
  const live = graph.nodes.some((n) => n.status === "running");
  return (
    <div className="agent-graph">
      <svg viewBox={`0 0 ${graph.width} ${graph.height}`} preserveAspectRatio="xMidYMin meet" role="img" aria-label="Agent graph">
        {graph.edges.map((e) => (
          <path key={e.id} d={edgePath(e, nodes)} className={`graph-edge tone-${nodes.get(e.to)!.kind === "leaf" ? nodes.get(e.from)!.tone : nodes.get(e.to)!.tone}${e.active ? " active" : ""}${e.dashed ? " dashed" : ""}${live && !e.active ? " idle" : ""}`} />
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
            className={`graph-node ${n.kind} ${n.status} tone-${n.tone}${shown?.id === n.id ? " selected" : ""}`}
            style={{ transform: `translate(${n.x}px, ${n.y}px)` }}
            tabIndex={0}
            role="button"
            aria-label={`${n.label} ${n.sub}: ${n.status}`}
            onMouseEnter={() => setHovered(n.id)}
            onMouseLeave={() => setHovered(null)}
            onFocus={() => setHovered(n.id)}
            onBlur={() => setHovered(null)}
            onClick={() => setPinned(pinned === n.id ? null : n.id)}
          >
            {n.kind === "leaf" ? (
              <>
                <rect x={-38} y={-13} width={76} height={26} rx={13} className="graph-leaf" />
                <text className="graph-leaf-text" y={4}>
                  {n.label} <tspan className="graph-count">{n.sub}</tspan>
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
          <div className="graph-panel-hint">Hover or click a node to see what it's doing.</div>
        )}
      </div>
    </div>
  );
}
