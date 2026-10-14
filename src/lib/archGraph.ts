import dagre from "@dagrejs/dagre";

/**
 * Architecture's Overview, as Claude writes it: a fenced ```architecture block of JSON, the boxes and the arrows between
 * them (see STEPS_PROMPT). Lantern checks it, lays it out and draws it itself, in the app's own style.
 *
 *   {"nodes": [{"id": "client", "label": "fetchJson", "change": "changed", "note": "the one function every caller uses"}],
 *    "edges": [{"from": "caller", "to": "client", "label": "calls"}]}
 */
export type Change = "new" | "changed" | "removed";

export interface ArchNode {
  id: string;
  label: string;
  change: Change | null;
  /** One line on what it does. */
  note: string;
}

export interface ArchEdge {
  from: string;
  to: string;
  label: string;
}

export interface ArchSpec {
  nodes: ArchNode[];
  edges: ArchEdge[];
}

const MAX_NODES = 40;
const MAX_EDGES = 80;
const ID = /^[A-Za-z][\w-]{0,40}$/;
const CHANGES: Change[] = ["new", "changed", "removed"];

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The first ```architecture block of some markdown, or null. */
export function architectureBlock(markdown: string): string | null {
  const m = /^```architecture[^\n]*\n([\s\S]*?)^```/m.exec(markdown);
  return m ? m[1].trim() : null;
}

/** The block read as boxes and arrows, or what is wrong with it (in a sentence the page can show). */
export function parseArchitecture(text: string): { spec: ArchSpec } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: "It isn't valid JSON." };
  }
  const o = raw as { nodes?: unknown; edges?: unknown };
  if (!o || typeof o !== "object" || !Array.isArray(o.nodes) || o.nodes.length === 0) return { error: "It has no nodes." };
  if (o.nodes.length > MAX_NODES) return { error: `It has ${o.nodes.length} nodes; the most it can draw is ${MAX_NODES}.` };
  const nodes: ArchNode[] = [];
  const seen = new Set<string>();
  for (const n of o.nodes as Record<string, unknown>[]) {
    const id = str(n?.id);
    if (!ID.test(id)) return { error: `A node's id ${JSON.stringify(id)} isn't a short name of letters and digits.` };
    if (seen.has(id)) return { error: `Two nodes have the id ${JSON.stringify(id)}.` };
    seen.add(id);
    const change = str(n.change).toLowerCase();
    nodes.push({ id, label: clip(str(n.label) || id, 60), change: CHANGES.includes(change as Change) ? (change as Change) : null, note: clip(str(n.note), 240) });
  }
  const edges: ArchEdge[] = [];
  for (const e of (Array.isArray(o.edges) ? o.edges : []).slice(0, MAX_EDGES) as Record<string, unknown>[]) {
    const from = str(e?.from);
    const to = str(e?.to);
    // An arrow to a box that isn't there can't be drawn: it is left out rather than failing the whole map.
    if (seen.has(from) && seen.has(to)) edges.push({ from, to, label: clip(str(e.label), 40) });
  }
  return { spec: { nodes, edges } };
}

export interface Point {
  x: number;
  y: number;
}

export interface PlacedNode extends ArchNode {
  /** Its centre. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedEdge extends ArchEdge {
  key: string;
  points: Point[];
  /** Where its label goes, if it has one. */
  labelAt: Point | null;
}

export interface ArchLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
}

export const NODE_H = 44;
/** A box is as wide as its label, within these. */
const NODE_W = { min: 104, max: 220, perChar: 7.1, pad: 34 };
const nodeWidth = (label: string) => Math.round(Math.min(NODE_W.max, Math.max(NODE_W.min, label.length * NODE_W.perChar + NODE_W.pad)));
/** How many characters of a label fit in a box this wide. */
export const labelFits = (w: number) => Math.floor((w - NODE_W.pad + 6) / NODE_W.perChar);

/**
 * The boxes placed in the order the arrows go, left to right ("LR") or top to bottom ("TB"), and each arrow's route
 * between them.
 */
export function layoutArchitecture(spec: ArchSpec, direction: "LR" | "TB" = "LR"): ArchLayout {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: direction, nodesep: direction === "LR" ? 20 : 28, ranksep: direction === "LR" ? 46 : 34, edgesep: 12, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of spec.nodes) g.setNode(n.id, { width: nodeWidth(n.label), height: NODE_H });
  spec.edges.forEach((e, i) => {
    // A label takes room on its route, so the boxes are spaced for it.
    const label = e.label ? { width: Math.min(160, e.label.length * 6.2 + 12), height: 16, labelpos: "c" } : {};
    g.setEdge(e.from, e.to, label, `e${i}`);
  });
  dagre.layout(g);
  const nodes = spec.nodes.map((n) => {
    const p = g.node(n.id);
    return { ...n, x: p.x, y: p.y, w: p.width, h: p.height };
  });
  const edges = spec.edges.map((e, i) => {
    const p = g.edge({ v: e.from, w: e.to, name: `e${i}` }) as { points?: Point[]; x?: number; y?: number };
    return { ...e, key: `e${i}`, points: p.points ?? [], labelAt: e.label && p.x !== undefined && p.y !== undefined ? { x: p.x, y: p.y } : null };
  });
  const box = g.graph() as { width?: number; height?: number };
  return { nodes, edges, width: Math.max(box.width ?? 0, 1), height: Math.max(box.height ?? 0, 1) };
}

/** How big Fit can show a layout in a room this size (what to compare the two directions by). */
export const fitScale = (l: ArchLayout, room: { w: number; h: number }) => Math.min(room.w / l.width, room.h / l.height);

/** An arrow's route as a smooth path through its points: straight runs, rounded at each bend. */
export function routePath(points: Point[]): string {
  if (points.length === 0) return "";
  const f = (p: Point) => `${Math.round(p.x * 10) / 10} ${Math.round(p.y * 10) / 10}`;
  if (points.length < 3) return `M ${points.map(f).join(" L ")}`;
  let d = `M ${f(points[0])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const mid = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
    d += ` Q ${f(points[i])} ${f(mid)}`;
  }
  return `${d} L ${f(points[points.length - 1])}`;
}

/** The box next to `from` in a direction, by where they sit: for the arrow keys. */
export function nearest(nodes: PlacedNode[], from: string, dir: "up" | "down" | "left" | "right"): string | null {
  const a = nodes.find((n) => n.id === from);
  if (!a) return nodes[0]?.id ?? null;
  let best: { id: string; score: number } | null = null;
  for (const b of nodes) {
    if (b.id === from) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const along = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
    const across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 1) continue;
    // Straight ahead counts for more than off to the side.
    const score = along + across * 2;
    if (!best || score < best.score) best = { id: b.id, score };
  }
  return best?.id ?? null;
}
