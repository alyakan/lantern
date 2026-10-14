import dagre from "@dagrejs/dagre";

/**
 * Architecture's Overview, as Claude writes it: a fenced ```architecture block of JSON, the boxes and the arrows between
 * them (see STEPS_PROMPT). Lantern checks it, lays it out and draws it itself, in the app's own style.
 *
 *   {"layers": [{"id": "ui", "label": "UI"}, {"id": "logic", "label": "Business logic"}],
 *    "nodes": [{"id": "field", "label": "Sensor field", "layer": "ui", "status": "planned", "note": "…", "issue": "…"}],
 *    "edges": [{"from": "field", "to": "gate", "label": "asks", "issue": "…"}]}
 *
 * `layers` are the architecture's boundaries, outermost first; each node sits in one. `status` is how far it is built,
 * `change` what a pull request does to it, and `issue` a problem with it, as Claude found it.
 */
export type Change = "new" | "changed" | "removed";
export type Status = "done" | "in-progress" | "planned";

export interface ArchLayer {
  id: string;
  label: string;
}

export interface ArchNode {
  id: string;
  label: string;
  change: Change | null;
  status: Status | null;
  /** The layer it sits in (one of the spec's), or null. */
  layer: string | null;
  /** One line on what it does. */
  note: string;
  /** A problem with it, as Claude found it ("" for none). */
  issue: string;
}

export interface ArchEdge {
  from: string;
  to: string;
  label: string;
  issue: string;
}

export interface ArchSpec {
  layers: ArchLayer[];
  nodes: ArchNode[];
  edges: ArchEdge[];
}

const MAX_NODES = 40;
const MAX_EDGES = 80;
const MAX_LAYERS = 10;
const ID = /^[A-Za-z][\w-]{0,40}$/;
const CHANGES: Change[] = ["new", "changed", "removed"];
// The words Claude may use for how far something is built, as the three statuses.
const STATUS: Record<string, Status> = { done: "done", built: "done", complete: "done", completed: "done", "in-progress": "in-progress", "in progress": "in-progress", inprogress: "in-progress", wip: "in-progress", planned: "planned", proposed: "planned", todo: "planned" };

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The first ```architecture block of some markdown, or null. */
export function architectureBlock(markdown: string): string | null {
  const m = /^```architecture[^\n]*\n([\s\S]*?)^```/m.exec(markdown);
  return m ? m[1].trim() : null;
}

/** The block read as layers, boxes and arrows, or what is wrong with it (in a sentence the page can show). */
export function parseArchitecture(text: string): { spec: ArchSpec } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: "It isn't valid JSON." };
  }
  const o = raw as { nodes?: unknown; edges?: unknown; layers?: unknown };
  if (!o || typeof o !== "object" || !Array.isArray(o.nodes) || o.nodes.length === 0) return { error: "It has no nodes." };
  if (o.nodes.length > MAX_NODES) return { error: `It has ${o.nodes.length} nodes; the most it can draw is ${MAX_NODES}.` };
  const layers: ArchLayer[] = [];
  for (const l of (Array.isArray(o.layers) ? o.layers : []).slice(0, MAX_LAYERS) as Record<string, unknown>[]) {
    const id = str(l?.id);
    if (ID.test(id) && !layers.some((x) => x.id === id)) layers.push({ id, label: clip(str(l.label) || id, 40) });
  }
  const nodes: ArchNode[] = [];
  const seen = new Set<string>();
  for (const n of o.nodes as Record<string, unknown>[]) {
    const id = str(n?.id);
    if (!ID.test(id)) return { error: `A node's id ${JSON.stringify(id)} isn't a short name of letters and digits.` };
    if (seen.has(id)) return { error: `Two nodes have the id ${JSON.stringify(id)}.` };
    seen.add(id);
    const change = str(n.change).toLowerCase();
    const layer = str(n.layer);
    nodes.push({
      id,
      label: clip(str(n.label) || id, 80),
      change: CHANGES.includes(change as Change) ? (change as Change) : null,
      status: STATUS[str(n.status).toLowerCase()] ?? null,
      layer: layers.some((l) => l.id === layer) ? layer : null,
      note: clip(str(n.note), 240),
      issue: clip(str(n.issue), 240),
    });
  }
  const edges: ArchEdge[] = [];
  for (const e of (Array.isArray(o.edges) ? o.edges : []).slice(0, MAX_EDGES) as Record<string, unknown>[]) {
    const from = str(e?.from);
    const to = str(e?.to);
    // An arrow to a box that isn't there can't be drawn: it is left out rather than failing the whole map.
    if (seen.has(from) && seen.has(to)) edges.push({ from, to, label: clip(str(e.label), 40), issue: clip(str(e.issue), 240) });
  }
  return { spec: { layers, nodes, edges } };
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
  /** Its label, wrapped to fit. */
  lines: string[];
}

export interface PlacedEdge extends ArchEdge {
  key: string;
  points: Point[];
  /** Its route, when the layout drew a curve of its own (layered maps); otherwise routePath(points). */
  path?: string;
  /** Where its label goes, if it has one. */
  labelAt: Point | null;
  /** Where it crosses from one layer into the next. */
  crossings: Point[];
  /**
   * The layers it goes around: ones it passes through although its two ends are also connected through a box in them
   * (UI straight to an implementation, past the protocol both are joined to). Passing through a layer the two have nothing
   * to do with isn't going around it.
   */
  skips: string[];
  /** For each layer it goes around, the box in it that the two ends are both connected to. */
  via: string[];
}

/** A layer's band across the map. */
export interface Band {
  id: string;
  label: string;
  y: number;
  h: number;
}

export interface ArchLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
  /** The layers, top to bottom (empty when the map has none). */
  bands: Band[];
  /** Where the boxes start: the room the bands' names take on the left. */
  gutter: number;
}

/** A label's lines: words kept whole where they fit, at most three lines (the last one cut short if it must be). */
export function wrapLabel(label: string, perLine = 22, maxLines = 3): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of label.split(/\s+/).filter(Boolean)) {
    const pieces = word.length > perLine ? (word.match(new RegExp(`.{1,${perLine}}`, "g")) ?? [word]) : [word];
    for (const piece of pieces) {
      if (!line) line = piece;
      else if (line.length + 1 + piece.length <= perLine) line += ` ${piece}`;
      else {
        lines.push(line);
        line = piece;
      }
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines.length ? lines : [""];
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = clip(`${kept[maxLines - 1]} ${lines.slice(maxLines).join(" ")}`, perLine);
  return kept;
}

const CHAR_W = 7.1;
const PAD_X = 34;
const LINE_H = 16;
/** The room a status's caption takes under the label ("Planned", "Done ✓"). */
const CAPTION_H = 14;
export const NODE_H = 44;

/** A box's size: as wide as its longest line, as tall as its lines (and caption). */
function boxOf(n: ArchNode): { w: number; h: number; lines: string[] } {
  const lines = wrapLabel(n.label);
  const longest = Math.max(...lines.map((l) => l.length));
  const w = Math.round(Math.min(240, Math.max(112, longest * CHAR_W + PAD_X)));
  const h = NODE_H + LINE_H * (lines.length - 1) + (n.status ? CAPTION_H : 0);
  return { w, h, lines };
}

/** How many characters of a label fit in a box this wide (for a box drawn without its own lines). */
export const labelFits = (w: number) => Math.floor((w - PAD_X + 6) / CHAR_W);

/**
 * The boxes placed in the order the arrows go, left to right ("LR") or top to bottom ("TB"), and each arrow's route
 * between them. A map with layers is laid out by them instead: each layer a band, outermost at the top.
 */
export function layoutArchitecture(spec: ArchSpec, direction: "LR" | "TB" = "LR"): ArchLayout {
  if (spec.layers.length > 0) return layeredLayout(spec);
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: direction, nodesep: direction === "LR" ? 20 : 28, ranksep: direction === "LR" ? 46 : 34, edgesep: 12, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  const boxes = new Map(spec.nodes.map((n) => [n.id, boxOf(n)]));
  for (const n of spec.nodes) g.setNode(n.id, { width: boxes.get(n.id)!.w, height: boxes.get(n.id)!.h });
  spec.edges.forEach((e, i) => {
    // A label takes room on its route, so the boxes are spaced for it.
    const label = e.label ? { width: Math.min(160, e.label.length * 6.2 + 12), height: 16, labelpos: "c" } : {};
    g.setEdge(e.from, e.to, label, `e${i}`);
  });
  dagre.layout(g);
  const nodes = spec.nodes.map((n) => {
    const p = g.node(n.id);
    return { ...n, x: p.x, y: p.y, w: p.width, h: p.height, lines: boxes.get(n.id)!.lines };
  });
  const edges = spec.edges.map((e, i) => {
    const p = g.edge({ v: e.from, w: e.to, name: `e${i}` }) as { points?: Point[]; x?: number; y?: number };
    return { ...e, key: `e${i}`, points: p.points ?? [], labelAt: e.label && p.x !== undefined && p.y !== undefined ? { x: p.x, y: p.y } : null, crossings: [], skips: [], via: [] };
  });
  const box = g.graph() as { width?: number; height?: number };
  return { nodes, edges, width: Math.max(box.width ?? 0, 1), height: Math.max(box.height ?? 0, 1), bands: [], gutter: 0 };
}

// The layered layout's measures.
const GUTTER = 150;
const BAND_PAD = 22;
const ROW_GAP = 26;
const NODE_GAP = 30;
const ROW_MAX = 5;
const SIDE = 24;

/** A cubic curve's point at t. */
function cubic(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * A map with layers: each layer a band across the map, outermost at the top, its boxes in rows inside it (a crowded
 * band takes two rows or more). Boxes in a band are ordered by where their neighbours in other bands are, so arrows
 * cross each other less. An arrow between bands runs from one box's edge to the other's; one within a row arcs over it.
 */
function layeredLayout(spec: ArchSpec): ArchLayout {
  const layers = [...spec.layers];
  if (spec.nodes.some((n) => n.layer === null)) layers.push({ id: "__other", label: "Other" });
  const bandIndex = new Map(layers.map((l, i) => [l.id, i]));
  const bandOfNode = new Map(spec.nodes.map((n) => [n.id, bandIndex.get(n.layer ?? "__other")!]));
  const boxes = new Map(spec.nodes.map((n) => [n.id, boxOf(n)]));
  const members: string[][] = layers.map((l) => spec.nodes.filter((n) => (n.layer ?? "__other") === l.id).map((n) => n.id));
  const neighbours = new Map<string, string[]>(spec.nodes.map((n) => [n.id, []]));
  for (const e of spec.edges) {
    if (e.from === e.to) continue;
    neighbours.get(e.from)!.push(e.to);
    neighbours.get(e.to)!.push(e.from);
  }

  // Where each box would sit with its band in one row, centred: the guess the ordering improves on.
  const xs = new Map<string, number>();
  const placeRow = (ids: string[], centre: number) => {
    const total = ids.reduce((s, id) => s + boxes.get(id)!.w, 0) + NODE_GAP * Math.max(0, ids.length - 1);
    let x = centre - total / 2;
    for (const id of ids) {
      const w = boxes.get(id)!.w;
      xs.set(id, x + w / 2);
      x += w + NODE_GAP;
    }
  };
  for (const ids of members) placeRow(ids, 0);
  // A few sweeps down and up: each band sorted by its boxes' neighbours' average place in the other bands.
  for (let sweep = 0; sweep < 4; sweep++) {
    const order = sweep % 2 === 0 ? members.map((_, i) => i) : members.map((_, i) => members.length - 1 - i);
    for (const b of order) {
      const at = (id: string) => {
        const others = neighbours.get(id)!.filter((o) => bandOfNode.get(o) !== b);
        return others.length ? others.reduce((s, o) => s + xs.get(o)!, 0) / others.length : xs.get(id)!;
      };
      const sorted = [...members[b]].map((id, i) => ({ id, at: at(id), i })).sort((p, q) => p.at - q.at || p.i - q.i).map((p) => p.id);
      members[b] = sorted;
      placeRow(sorted, 0);
    }
  }

  // Each band's rows, as evenly filled as its size allows.
  const rows: string[][][] = members.map((ids) => {
    if (ids.length === 0) return [];
    const count = Math.ceil(ids.length / ROW_MAX);
    const per = Math.ceil(ids.length / count);
    return Array.from({ length: count }, (_, r) => ids.slice(r * per, (r + 1) * per));
  });
  const rowWidth = (ids: string[]) => ids.reduce((s, id) => s + boxes.get(id)!.w, 0) + NODE_GAP * Math.max(0, ids.length - 1);
  const content = Math.max(320, ...rows.flat().map(rowWidth));
  const centre = GUTTER + SIDE + content / 2;

  const placed = new Map<string, { x: number; y: number }>();
  const bands: Band[] = [];
  let y = 0;
  layers.forEach((layer, b) => {
    const top = y;
    let rowTop = top + BAND_PAD;
    for (const row of rows[b]) {
      const h = Math.max(...row.map((id) => boxes.get(id)!.h));
      placeRow(row, centre);
      for (const id of row) placed.set(id, { x: xs.get(id)!, y: rowTop + h / 2 });
      rowTop += h + ROW_GAP;
    }
    // A band with no boxes keeps a little room, so its boundary still shows.
    const bottom = rows[b].length ? rowTop - ROW_GAP + BAND_PAD : top + 2 * BAND_PAD;
    bands.push({ id: layer.id, label: layer.label, y: top, h: bottom - top });
    y = bottom;
  });

  const nodes: PlacedNode[] = spec.nodes.map((n) => ({ ...n, ...placed.get(n.id)!, w: boxes.get(n.id)!.w, h: boxes.get(n.id)!.h, lines: boxes.get(n.id)!.lines }));
  const at = new Map(nodes.map((n) => [n.id, n]));
  const pairs = new Set(spec.edges.map((e) => `${e.from}>${e.to}`));
  const edges: PlacedEdge[] = spec.edges.map((e, i) => {
    const a = at.get(e.from)!;
    const z = at.get(e.to)!;
    // Two arrows between the same boxes, one each way: drawn side by side rather than on top of each other.
    const shift = pairs.has(`${e.to}>${e.from}`) ? (e.from < e.to ? -7 : 7) : 0;
    let p0: Point, p1: Point, p2: Point, p3: Point;
    if (Math.abs(a.y - z.y) < 1 && e.from !== e.to) {
      // In one row: over the top, so it doesn't run through the boxes between.
      const lift = Math.min(a.y - a.h / 2, z.y - z.h / 2) - 26;
      p0 = { x: a.x + shift, y: a.y - a.h / 2 };
      p3 = { x: z.x + shift, y: z.y - z.h / 2 };
      p1 = { x: p0.x, y: lift };
      p2 = { x: p3.x, y: lift };
    } else {
      const down = z.y > a.y;
      p0 = { x: a.x + shift, y: down ? a.y + a.h / 2 : a.y - a.h / 2 };
      p3 = { x: z.x + shift, y: down ? z.y - z.h / 2 : z.y + z.h / 2 };
      const pull = Math.max(30, Math.abs(p3.y - p0.y) * 0.45);
      p1 = { x: p0.x, y: p0.y + (down ? pull : -pull) };
      p2 = { x: p3.x, y: p3.y + (down ? -pull : pull) };
    }
    const path = `M ${round(p0.x)} ${round(p0.y)} C ${round(p1.x)} ${round(p1.y)}, ${round(p2.x)} ${round(p2.y)}, ${round(p3.x)} ${round(p3.y)}`;
    // Where it crosses each boundary between its two bands, found along the curve.
    const ba = bandOfNode.get(e.from)!;
    const bz = bandOfNode.get(e.to)!;
    const crossings: Point[] = [];
    for (let k = Math.min(ba, bz) + 1; k <= Math.max(ba, bz); k++) {
      const line = bands[k].y;
      let prev = cubic(p0, p1, p2, p3, 0);
      for (let s = 1; s <= 60; s++) {
        const cur = cubic(p0, p1, p2, p3, s / 60);
        if ((prev.y - line) * (cur.y - line) <= 0 && prev.y !== cur.y) {
          const t = (line - prev.y) / (cur.y - prev.y);
          crossings.push({ x: round(prev.x + (cur.x - prev.x) * t), y: line });
          break;
        }
        prev = cur;
      }
    }
    // A layer between the two that they're both connected to a box in: the arrow goes around that boundary.
    const skips: string[] = [];
    const via: string[] = [];
    for (let k = Math.min(ba, bz) + 1; k < Math.max(ba, bz); k++) {
      const shared = members[k].find((m) => neighbours.get(m)!.includes(e.from) && neighbours.get(m)!.includes(e.to));
      if (shared) {
        skips.push(layers[k].label);
        via.push(at.get(shared)!.label);
      }
    }
    return { ...e, key: `e${i}`, points: [p0, p3], path, labelAt: e.label ? cubic(p0, p1, p2, p3, 0.5) : null, crossings, skips, via };
  });
  return { nodes, edges, width: GUTTER + SIDE + content + SIDE, height: Math.max(y, 1), bands, gutter: GUTTER };
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

/** Everything wrong on the map: what Claude marked on boxes and arrows, and arrows that go around a layer. */
export interface MapIssue {
  key: string;
  /** The box it's about, or the arrow's two ends. */
  node: string | null;
  edge: string | null;
  text: string;
  /** Found by Lantern from the layers, rather than written by Claude. */
  found: boolean;
}

export function issuesOf(layout: ArchLayout): MapIssue[] {
  const label = new Map(layout.nodes.map((n) => [n.id, n.label]));
  const out: MapIssue[] = [];
  for (const n of layout.nodes) if (n.issue) out.push({ key: `n:${n.id}`, node: n.id, edge: null, text: `${n.label}: ${n.issue}`, found: false });
  for (const e of layout.edges) {
    const ends = `${label.get(e.from)} → ${label.get(e.to)}`;
    if (e.issue) out.push({ key: `e:${e.key}`, node: null, edge: e.key, text: `${ends}: ${e.issue}`, found: false });
    if (e.skips.length) out.push({ key: `s:${e.key}`, node: null, edge: e.key, text: `${ends} goes around ${e.skips.join(" and ")}: both are connected through ${e.via.join(" and ")}, but this arrow skips ${e.via.length === 1 ? "it" : "them"}.`, found: true });
  }
  return out;
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
