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
  /** Its route as a polyline, fine enough to test against (crossings, where its label can go). */
  poly: Point[];
  /** Its label's pill, if it has a label: where it goes, its words (cut short if long) and whether it fits on the map or is left for hover. */
  pill: (PlacedLabel & { text: string }) | null;
  /** The pill's centre when it is placed, else null. */
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

// ---- The labels on the arrows ("pills"): small, placed where they hide nothing else ----

export const PILL_H = 16;
/** The most characters a pill shows; a longer label is cut short there, and shown whole when the arrow is looked at. */
export const PILL_CHARS = 18;
const PILL_CH = 6.4;
const PILL_PAD = 10;

/** A rectangle by its top-left corner. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A pill's words: the label, cut short past PILL_CHARS (with the full text kept for the tooltip). */
export const pillText = (label: string) => (label.length > PILL_CHARS ? `${label.slice(0, PILL_CHARS - 1).trimEnd()}…` : label);
/** A pill's width for `chars` characters (a ⚠ counts as two). */
export const pillWidth = (chars: number) => Math.round(chars * PILL_CH + PILL_PAD);

export interface LabelInput {
  key: string;
  /** What is written on the pill (already cut short). */
  text: string;
  /** Extra characters on the pill beyond `text` (the ⚠ of an arrow with a problem). */
  extra?: number;
  /** The arrow's route, as a polyline. */
  poly: Point[];
}

export interface PlacedLabel {
  key: string;
  /** The pill's centre and size. For one that isn't `placed` it is where its arrow's middle is: the spot for its marker, and where the full pill shows on hover. */
  x: number;
  y: number;
  w: number;
  h: number;
  placed: boolean;
}

const CANDIDATE_T = [0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78, 0.14, 0.86];
/** A pill that would sit on this many lines of other arrows is left off the map (shown when its arrow is looked at). */
const MAX_LINE_HITS = 3;
const HARD = 1000;

interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

const polyLength = (poly: Point[]) => poly.reduce((s, p, i) => (i ? s + Math.hypot(p.x - poly[i - 1].x, p.y - poly[i - 1].y) : 0), 0);

/** The point `t` of the way along a polyline (by length), and which way it is heading there. */
function along(poly: Point[], t: number): { p: Point; dx: number; dy: number } {
  const total = polyLength(poly);
  let want = total * t;
  for (let i = 1; i < poly.length; i++) {
    const len = Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y);
    if (want <= len || i === poly.length - 1) {
      const f = len ? Math.min(1, want / len) : 0;
      return { p: { x: poly[i - 1].x + (poly[i].x - poly[i - 1].x) * f, y: poly[i - 1].y + (poly[i].y - poly[i - 1].y) * f }, dx: poly[i].x - poly[i - 1].x, dy: poly[i].y - poly[i - 1].y };
    }
    want -= len;
  }
  return { p: poly[0] ?? { x: 0, y: 0 }, dx: 0, dy: 1 };
}

/** Whether a segment touches a rectangle (Liang–Barsky). */
function segHitsRect(s: Seg, x0: number, y0: number, x1: number, y1: number): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, s.ax - x0) && clip(dx, x1 - s.ax) && clip(-dy, s.ay - y0) && clip(dy, y1 - s.ay);
}

const overlapArea = (a: { x0: number; y0: number; x1: number; y1: number }, b: { x0: number; y0: number; x1: number; y1: number }) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/**
 * Where each arrow's label goes. Every label tries spots along its own arrow (a quarter, two fifths, the middle, … of the
 * way, and to either side of the line), and takes the one that sits on least: other pills and boxes are never allowed, and
 * other arrows' lines cost a little each. The crowded arrows choose first; a few rounds then let each label move to a better
 * spot now that the others are down. A label that can't go anywhere without covering a box or another pill (or too many
 * lines) isn't `placed`: it is left off, and shown when its arrow is looked at. Pure: no DOM, so it is tested alone.
 */
export function placeLabels(inputs: LabelInput[], obstacles: Rect[], size: { w: number; h: number }): PlacedLabel[] {
  const n = inputs.length;
  const dims = inputs.map((l) => ({ w: pillWidth(l.text.length + (l.extra ?? 0)), h: PILL_H }));
  const segs: Seg[][] = inputs.map((l) => l.poly.slice(1).map((p, i) => ({ ax: l.poly[i].x, ay: l.poly[i].y, bx: p.x, by: p.y })));
  const mids = inputs.map((l) => along(l.poly, 0.5).p);
  // The more other arrows pass near an arrow's middle, the sooner it chooses.
  const crowd = inputs.map((_, i) => segs.reduce((s, other, j) => (j !== i && other.some((g) => Math.abs(g.ax - mids[i].x) < 70 && Math.abs(g.ay - mids[i].y) < 40) ? s + 1 : s), 0));
  const order = inputs.map((_, i) => i).sort((a, b) => crowd[b] - crowd[a] || polyLength(inputs[b].poly) - polyLength(inputs[a].poly));
  const candidates = inputs.map((l, i) => {
    const { w, h } = dims[i];
    const out: { x: number; y: number; pref: number }[] = [];
    for (const t of CANDIDATE_T) {
      const { p, dx, dy } = along(l.poly, t);
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      // Beside the line, far enough that the pill clears it.
      const gap = Math.abs(nx) * (w / 2) + Math.abs(ny) * (h / 2) + 3;
      const base = Math.abs(t - 0.5) * 24 + (t < 0.2 || t > 0.8 ? 6 : 0);
      out.push({ x: p.x, y: p.y, pref: base });
      out.push({ x: p.x + nx * gap, y: p.y + ny * gap, pref: base + 5 });
      out.push({ x: p.x - nx * gap, y: p.y - ny * gap, pref: base + 5 });
    }
    return out;
  });
  const placed: ({ x: number; y: number; w: number; h: number } | null)[] = inputs.map(() => null);
  const rectOf = (c: { x: number; y: number }, i: number) => ({ x0: c.x - dims[i].w / 2, y0: c.y - dims[i].h / 2, x1: c.x + dims[i].w / 2, y1: c.y + dims[i].h / 2 });
  const costOf = (c: { x: number; y: number; pref: number }, i: number) => {
    const r = rectOf(c, i);
    let cost = c.pref;
    if (r.x0 < 0 || r.y0 < 0 || r.x1 > size.w || r.y1 > size.h) cost += HARD;
    for (const o of obstacles) cost += overlapArea(r, { x0: o.x - 2, y0: o.y - 2, x1: o.x + o.w + 2, y1: o.y + o.h + 2 }) > 0 ? HARD : 0;
    for (let j = 0; j < n; j++) {
      const q = placed[j];
      if (j === i || !q) continue;
      if (overlapArea(r, { x0: q.x - q.w / 2 - 2, y0: q.y - q.h / 2 - 2, x1: q.x + q.w / 2 + 2, y1: q.y + q.h / 2 + 2 }) > 0) cost += HARD;
    }
    let hits = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      for (const g of segs[j]) {
        if (Math.max(g.ax, g.bx) < r.x0 || Math.min(g.ax, g.bx) > r.x1 || Math.max(g.ay, g.by) < r.y0 || Math.min(g.ay, g.by) > r.y1) continue;
        if (segHitsRect(g, r.x0, r.y0, r.x1, r.y1)) hits++;
      }
    }
    return cost + hits * 7 + (hits > MAX_LINE_HITS ? HARD : 0);
  };
  const best = (i: number) => {
    let top: { x: number; y: number; cost: number } | null = null;
    for (const c of candidates[i]) {
      const cost = costOf(c, i);
      if (!top || cost < top.cost) top = { x: c.x, y: c.y, cost };
    }
    return top && top.cost < HARD ? top : null;
  };
  const cost = inputs.map(() => Infinity);
  for (const i of order) {
    const b = best(i);
    if (b) {
      placed[i] = { x: b.x, y: b.y, ...dims[i] };
      cost[i] = b.cost;
    }
  }
  for (let round = 0; round < 3; round++) {
    let moved = false;
    for (const i of order) {
      const was = placed[i];
      placed[i] = null;
      const b = best(i);
      if (b && b.cost < cost[i] - 0.5) {
        placed[i] = { x: b.x, y: b.y, ...dims[i] };
        cost[i] = b.cost;
        moved = true;
      } else placed[i] = was;
    }
    if (!moved) break;
  }
  return inputs.map((l, i) => {
    const p = placed[i];
    return p ? { key: l.key, ...p, placed: true } : { key: l.key, x: mids[i].x, y: mids[i].y, ...dims[i], placed: false };
  });
}

// ---- Crossings, counted ----

const orient = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const cross = (a: Point, b: Point, c: Point, d: Point) => orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;

/** How many pairs of arrows cross each other (arrows that share a box meet there, and aren't counted). */
export function edgeCrossings(edges: { from: string; to: string; poly: Point[] }[]): number {
  let count = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i];
      const b = edges[j];
      if (a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to) continue;
      let hit = false;
      for (let p = 1; p < a.poly.length && !hit; p++) {
        for (let q = 1; q < b.poly.length && !hit; q++) hit = cross(a.poly[p - 1], a.poly[p], b.poly[q - 1], b.poly[q]);
      }
      if (hit) count++;
    }
  }
  return count;
}

/** How many (arrow, box) pairs have the arrow running through a box that isn't one of its two ends. */
export function edgesThroughBoxes(edges: { from: string; to: string; poly: Point[] }[], nodes: { id: string; x: number; y: number; w: number; h: number }[]): number {
  let count = 0;
  for (const e of edges) {
    const segs = e.poly.slice(1).map((p, i) => ({ ax: e.poly[i].x, ay: e.poly[i].y, bx: p.x, by: p.y }));
    for (const n of nodes) {
      if (n.id === e.from || n.id === e.to) continue;
      if (segs.some((s) => segHitsRect(s, n.x - n.w / 2 + 1, n.y - n.h / 2 + 1, n.x + n.w / 2 - 1, n.y + n.h / 2 - 1))) count++;
    }
  }
  return count;
}

/** How bad a layout's arrows are: crossings, and running through boxes, which is worse. */
const roughness = (l: { edges: { from: string; to: string; poly: Point[] }[]; nodes: PlacedNode[] }) => edgeCrossings(l.edges) + 3 * edgesThroughBoxes(l.edges, l.nodes);

/** A polyline's first crossing of a horizontal line, or null. */
function crossingAt(poly: Point[], line: number): Point | null {
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    if ((a.y - line) * (b.y - line) <= 0 && a.y !== b.y) return { x: round(a.x + ((b.x - a.x) * (line - a.y)) / (b.y - a.y)), y: line };
  }
  return null;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Pills for every labelled arrow of a layout, placed against its boxes and its other arrows. */
function withPills(edges: Omit<PlacedEdge, "pill" | "labelAt">[], nodes: PlacedNode[], gutter: number, size: { w: number; h: number }): PlacedEdge[] {
  const marked = (e: { issue: string; skips: string[] }) => !!e.issue || e.skips.length > 0;
  const inputs = edges.filter((e) => e.label).map((e): LabelInput => ({ key: e.key, text: pillText(e.label), extra: marked(e) ? 2 : 0, poly: e.poly }));
  const obstacles: Rect[] = nodes.map((n) => ({ x: n.x - n.w / 2, y: n.y - n.h / 2, w: n.w, h: n.h }));
  if (gutter > 0) obstacles.push({ x: 0, y: 0, w: gutter, h: size.h });
  const done = new Map(placeLabels(inputs, obstacles, size).map((p) => [p.key, p]));
  return edges.map((e) => {
    const p = done.get(e.key);
    return { ...e, pill: p ? { ...p, text: pillText(e.label) } : null, labelAt: p?.placed ? { x: p.x, y: p.y } : null };
  });
}

// ---- The layouts ----

/**
 * The boxes placed in the order the arrows go, left to right ("LR") or top to bottom ("TB"), and each arrow's route
 * between them. A map with layers is laid out by them instead: each layer a band, outermost at the top. `rowMax` is the
 * most boxes a band has in a row (a narrow room wants fewer, more rows).
 */
export function layoutArchitecture(spec: ArchSpec, direction: "LR" | "TB" = "LR", rowMax = ROW_MAX): ArchLayout {
  if (spec.layers.length > 0) return layeredLayout(spec, rowMax);
  const boxes = new Map(spec.nodes.map((n) => [n.id, boxOf(n)]));
  const labelled = spec.edges.filter((e) => e.label).length;
  // A map full of labels is spaced for them.
  const crowd = Math.min(1, labelled / Math.max(1, spec.nodes.length));
  let best: ArchLayout | null = null;
  let bestScore = Infinity;
  // Dagre's rankers give different pictures: the one with fewest crossings is kept.
  for (const ranker of ["network-simplex", "tight-tree", "longest-path"]) {
    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ rankdir: direction, ranker, nodesep: (direction === "LR" ? 20 : 28) + 14 * crowd, ranksep: (direction === "LR" ? 46 : 34) + 24 * crowd, edgesep: 12 + 8 * crowd, marginx: 16, marginy: 16 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of spec.nodes) g.setNode(n.id, { width: boxes.get(n.id)!.w, height: boxes.get(n.id)!.h });
    spec.edges.forEach((e, i) => {
      // A label takes room on its route, so the boxes are spaced for it.
      const label = e.label ? { width: pillWidth(Math.min(PILL_CHARS, e.label.length)), height: PILL_H, labelpos: "c" } : {};
      g.setEdge(e.from, e.to, label, `e${i}`);
    });
    dagre.layout(g);
    const nodes: PlacedNode[] = spec.nodes.map((n) => {
      const p = g.node(n.id);
      return { ...n, x: p.x, y: p.y, w: p.width, h: p.height, lines: boxes.get(n.id)!.lines };
    });
    const edges = spec.edges.map((e, i) => {
      const p = g.edge({ v: e.from, w: e.to, name: `e${i}` }) as { points?: Point[] };
      const points = p.points ?? [];
      return { ...e, key: `e${i}`, points, poly: points, crossings: [] as Point[], skips: [] as string[], via: [] as string[] };
    });
    const score = roughness({ edges, nodes });
    if (score < bestScore) {
      const box = g.graph() as { width?: number; height?: number };
      const width = Math.max(box.width ?? 0, 1);
      const height = Math.max(box.height ?? 0, 1);
      best = { nodes, edges: withPills(edges, nodes, 0, { w: width, h: height }), width, height, bands: [], gutter: 0 };
      bestScore = score;
    }
  }
  return best!;
}

/**
 * How many boxes a band should have in a row to be drawn at a readable size in a room this wide (a narrow pane wants
 * fewer, so more rows; the most is ROW_MAX). A room of no size gets the most.
 */
export function rowMaxFor(spec: ArchSpec, roomWidth: number, zoom = 0.75): number {
  if (roomWidth <= 0 || spec.nodes.length === 0) return ROW_MAX;
  const mean = spec.nodes.reduce((s, n) => s + boxOf(n).w, 0) / spec.nodes.length;
  const gap = 40;
  const available = (roomWidth - 16) / zoom - GUTTER_MAX * 0.8 - 2 * SIDE;
  return Math.max(2, Math.min(ROW_MAX, Math.floor((available + gap) / (mean + gap))));
}

// The layered layout's measures.
const GUTTER_MAX = 150;
const GUTTER_MIN = 84;
const BAND_PAD = 22;
const ROW_GAP = 26;
const NODE_GAP = 30;
export const ROW_MAX = 5;
const SIDE = 32;
/** How much more room a strip between two rows gets for each arrow that crosses it (they have pills to carry too). */
const STRIP_PER_EDGE = 1.5;
const STRIP_EXTRA_MAX = 36;
/** How far apart arrows are drawn where they leave or enter the same side of a box. */
const PORT_GAP = 14;
/** The room an arc over a row takes for each level of arc. */
const ARC_LEVEL = 9;
const CORRIDOR_MARGIN = 9;

/** A cubic curve's points, as a polyline. */
function cubicPoly(p0: Point, p1: Point, p2: Point, p3: Point, steps = 10): Point[] {
  const out: Point[] = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const u = 1 - t;
    out.push({ x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x, y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y });
  }
  return out;
}

/** A route through stations that run straight down a column and swing across in the space between rows: path and polyline. */
function viaStations(st: Point[]): { path: string; poly: Point[] } {
  let path = `M ${round(st[0].x)} ${round(st[0].y)}`;
  const poly: Point[] = [st[0]];
  for (let i = 1; i < st.length; i++) {
    const a = st[i - 1];
    const b = st[i];
    if (Math.abs(a.x - b.x) < 0.5) {
      path += ` L ${round(b.x)} ${round(b.y)}`;
      poly.push(b);
    } else {
      const m = (a.y + b.y) / 2;
      path += ` C ${round(a.x)} ${round(m)}, ${round(b.x)} ${round(m)}, ${round(b.x)} ${round(b.y)}`;
      poly.push(...cubicPoly(a, { x: a.x, y: m }, { x: b.x, y: m }, b).slice(1));
    }
  }
  return { path, poly };
}

/**
 * A map with layers: each layer a band across the map, outermost at the top, its boxes in rows inside it (a crowded
 * band takes two rows or more). Boxes in a band are ordered by where their neighbours in other bands are, so arrows
 * cross each other less. An arrow between rows runs down from one box's edge, swings across in the space between rows, and
 * goes straight down past the rows it crosses through a gap between their boxes (never through one); arrows leave a box
 * side by side. One within a row arcs over it. Several orders are tried, and the one with the fewest crossings is drawn.
 */
function layeredLayout(spec: ArchSpec, rowMax: number): ArchLayout {
  const trials = Array.from({ length: 14 }, (_, seed) => layoutLayers(spec, rowMax, seed));
  let best = trials[0];
  let bestScore = roughness(best);
  for (const t of trials.slice(1)) {
    const s = roughness(t);
    if (s < bestScore) {
      best = t;
      bestScore = s;
    }
  }
  const size = { w: best.width, h: best.height };
  return { ...best, edges: withPills(best.edges, best.nodes, best.gutter, size) };
}

type Routed = Omit<PlacedEdge, "pill" | "labelAt">;
type Bare = Omit<ArchLayout, "edges"> & { edges: Routed[] };

function layoutLayers(spec: ArchSpec, rowMax: number, seed: number): Bare {
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
  // A map with many arrows keeps its boxes further apart, so there are gaps for them to pass through.
  const density = spec.edges.length / Math.max(1, spec.nodes.length);
  const nodeGap = NODE_GAP + Math.round(Math.min(20, Math.max(0, density - 1) * 20));
  const gutter = Math.round(Math.min(GUTTER_MAX, Math.max(GUTTER_MIN, Math.max(...layers.map((l) => l.label.length)) * 7.2 + 30)));

  // Where each box would sit with its band in one row, centred: the guess the ordering improves on.
  const xs = new Map<string, number>();
  const placeRow = (ids: string[], centre: number) => {
    const total = ids.reduce((s, id) => s + boxes.get(id)!.w, 0) + nodeGap * Math.max(0, ids.length - 1);
    let x = centre - total / 2;
    for (const id of ids) {
      const w = boxes.get(id)!.w;
      xs.set(id, x + w / 2);
      x += w + nodeGap;
    }
  };
  // Each trial starts from another order, so the sweeps settle in another place.
  let rnd = seed * 2654435761 + 1;
  const next = () => ((rnd = (rnd * 1664525 + 1013904223) >>> 0) / 4294967296);
  members.forEach((ids, b) => {
    if (seed === 0) return;
    // The first trial keeps Claude's order; the others shuffle (the same way each time, so a map always draws the same).
    const shuffled = [...ids];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    members[b] = shuffled;
  });
  for (const ids of members) placeRow(ids, 0);
  // A few sweeps down and up: each band sorted by its boxes' neighbours' average place in the other bands.
  for (let sweep = 0; sweep < 8; sweep++) {
    const order = sweep % 2 === 0 ? members.map((_, i) => i) : members.map((_, i) => members.length - 1 - i);
    for (const b of order) {
      const at = (id: string) => {
        const others = neighbours.get(id)!.filter((o) => bandOfNode.get(o) !== b).map((o) => xs.get(o)!).sort((p, q) => p - q);
        if (!others.length) return xs.get(id)!;
        // The middle one rather than the average, in the odd trials: it is another order where the two disagree.
        return seed % 2 === 1 ? others[Math.floor(others.length / 2)] : others.reduce((s, o) => s + o, 0) / others.length;
      };
      const sorted = [...members[b]].map((id, i) => ({ id, at: at(id), i })).sort((p, q) => p.at - q.at || p.i - q.i).map((p) => p.id);
      members[b] = sorted;
      placeRow(sorted, 0);
    }
  }

  // Each band's rows, as evenly filled as its size allows. A band with two rows or more puts the boxes that are joined to
  // layers above in its first row and the ones joined below in its last.
  const rows: string[][][] = members.map((ids, b) => {
    if (ids.length === 0) return [];
    const count = Math.ceil(ids.length / rowMax);
    const per = Math.ceil(ids.length / count);
    if (count === 1) return [ids];
    const lean = (id: string) => {
      const o = neighbours.get(id)!.map((x) => bandOfNode.get(x)! - b).filter((d) => d !== 0);
      return o.length ? o.reduce((s, d) => s + Math.sign(d), 0) / o.length : 0;
    };
    const split = [...ids].map((id, i) => ({ id, i, lean: lean(id) })).sort((p, q) => p.lean - q.lean || p.i - q.i).map((p) => p.id);
    return Array.from({ length: count }, (_, r) => split.slice(r * per, (r + 1) * per)).map((row) => row.sort((p, q) => xs.get(p)! - xs.get(q)!));
  });
  // Swapping neighbours in a row, and moving a box to another row of its band, while that lowers the crossings of arrows
  // drawn straight between the boxes' places (a quick stand-in for the real routes).
  const straight = () => {
    const at = new Map<string, Point>();
    let y = 0;
    for (const band of rows) {
      for (const row of band) {
        placeRow(row, 0);
        for (const id of row) at.set(id, { x: xs.get(id)!, y });
        y++;
      }
    }
    const lines = spec.edges.filter((e) => e.from !== e.to && at.get(e.from)!.y !== at.get(e.to)!.y).map((e) => ({ e, a: at.get(e.from)!, z: at.get(e.to)! }));
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        const p = lines[i];
        const q = lines[j];
        if (p.e.from === q.e.from || p.e.from === q.e.to || p.e.to === q.e.from || p.e.to === q.e.to) continue;
        if (cross(p.a, p.z, q.a, q.z)) count++;
      }
    }
    return count;
  };
  let now = straight();
  for (let pass = 0; pass < 8 && now > 0; pass++) {
    let better = false;
    for (const band of rows) {
      for (const [r, row] of band.entries()) {
        for (let i = 0; i + 1 < row.length; i++) {
          [row[i], row[i + 1]] = [row[i + 1], row[i]];
          const c = straight();
          if (c < now) {
            now = c;
            better = true;
          } else [row[i], row[i + 1]] = [row[i + 1], row[i]];
        }
        const cap = Math.max(...band.map((x) => x.length));
        for (const [o, other] of band.entries()) {
          if (o === r || row.length < 2) continue;
          for (let i = 0; i < row.length; i++) {
            if (other.length >= cap) break;
            const [id] = row.splice(i, 1);
            other.push(id);
            const c = straight();
            if (c < now) {
              now = c;
              better = true;
              break;
            }
            other.pop();
            row.splice(i, 0, id);
          }
        }
      }
    }
    if (!better) break;
  }
  const rowWidth = (ids: string[]) => ids.reduce((s, id) => s + boxes.get(id)!.w, 0) + nodeGap * Math.max(0, ids.length - 1);
  const content = Math.max(320, ...rows.flat().map(rowWidth));
  const centre = gutter + SIDE + content / 2;
  const width = gutter + SIDE + content + SIDE;

  // Every row in order down the map (a band with no boxes is a row of nothing, to keep the room for its band).
  const flat: { band: number; ids: string[]; h: number; top: number }[] = [];
  layers.forEach((_, b) => {
    if (rows[b].length === 0) flat.push({ band: b, ids: [], h: 0, top: 0 });
    for (const ids of rows[b]) flat.push({ band: b, ids, h: Math.max(...ids.map((id) => boxes.get(id)!.h)), top: 0 });
  });
  const rowOf = new Map<string, number>();
  flat.forEach((r, k) => r.ids.forEach((id) => rowOf.set(id, k)));
  for (const r of flat) if (r.ids.length) placeRow(r.ids, centre);

  // Arrows over a row (both ends in it) and the room they take above it: one level for each that would overlap another.
  const arcLevel = new Map<number, number>();
  const rowLevels = flat.map(() => 0);
  flat.forEach((_, k) => {
    const arcs = spec.edges.map((e, i) => ({ e, i })).filter(({ e }) => e.from !== e.to && rowOf.get(e.from) === k && rowOf.get(e.to) === k);
    const span = (e: ArchEdge) => [Math.min(xs.get(e.from)!, xs.get(e.to)!), Math.max(xs.get(e.from)!, xs.get(e.to)!)];
    const levels: number[][][] = [];
    for (const { e, i } of arcs.sort((p, q) => span(p.e)[1] - span(p.e)[0] - (span(q.e)[1] - span(q.e)[0]) || p.i - q.i)) {
      const [lo, hi] = span(e);
      let level = levels.findIndex((taken) => taken.every(([a, b]) => hi < a - 4 || lo > b + 4));
      if (level < 0) level = levels.push([]) - 1;
      levels[level].push([lo, hi]);
      arcLevel.set(i, level);
    }
    rowLevels[k] = levels.length;
  });
  // How many arrows run through the space between row k and the next.
  const through = flat.map((_, k) => spec.edges.filter((e) => e.from !== e.to && rowOf.get(e.from)! !== rowOf.get(e.to)! && Math.min(rowOf.get(e.from)!, rowOf.get(e.to)!) <= k && k < Math.max(rowOf.get(e.from)!, rowOf.get(e.to)!)).length);
  const strip = (k: number) => {
    // The space above row k (k = 0 is the top of the map; k = flat.length the bottom).
    const arcs = k < flat.length && rowLevels[k] ? rowLevels[k] * ARC_LEVEL + 8 : 0;
    if (k === 0) return BAND_PAD + arcs;
    if (k === flat.length) return BAND_PAD;
    return (flat[k - 1].band === flat[k].band ? ROW_GAP : 2 * BAND_PAD) + Math.min(STRIP_EXTRA_MAX, through[k - 1] * STRIP_PER_EDGE) + arcs;
  };
  const strips = Array.from({ length: flat.length + 1 }, (_, k) => strip(k));
  let y = 0;
  flat.forEach((r, k) => {
    y += strips[k];
    r.top = y;
    y += r.h;
  });
  y += strips[flat.length];
  const total = y;

  // The bands: each boundary in the middle of the space between its two rows.
  const firstRow = layers.map((_, b) => flat.findIndex((r) => r.band === b));
  const bands: Band[] = [];
  layers.forEach((layer, b) => {
    // The arcs over a row take the bottom of the space above it; the boundary is in the middle of the rest.
    const edgeY = (k: number) => (k <= 0 ? 0 : k >= flat.length ? total : flat[k - 1].top + flat[k - 1].h + (strips[k] - (rowLevels[k] ? rowLevels[k] * ARC_LEVEL + 8 : 0)) / 2);
    const top = edgeY(firstRow[b]);
    const bottom = b + 1 < layers.length ? edgeY(firstRow[b + 1]) : total;
    bands.push({ id: layer.id, label: layer.label, y: top, h: bottom - top });
  });

  const placed = new Map<string, { x: number; y: number }>();
  flat.forEach((r) => {
    for (const id of r.ids) placed.set(id, { x: xs.get(id)!, y: r.top + r.h / 2 });
  });
  const nodes: PlacedNode[] = spec.nodes.map((n) => ({ ...n, ...placed.get(n.id)!, w: boxes.get(n.id)!.w, h: boxes.get(n.id)!.h, lines: boxes.get(n.id)!.lines }));
  const at = new Map(nodes.map((n) => [n.id, n]));

  // Where an arrow passes down through a row it crosses: a gap between that row's boxes (or beside them) near the straight line.
  const lo = gutter + 4;
  const hi = width - 4;
  const free = (k: number): [number, number][] => {
    const spans = flat[k].ids.map((id) => at.get(id)!).map((n): [number, number] => [n.x - n.w / 2 - CORRIDOR_MARGIN, n.x + n.w / 2 + CORRIDOR_MARGIN]).sort((p, q) => p[0] - q[0]);
    const out: [number, number][] = [];
    let from = lo;
    for (const [a, b] of spans) {
      if (a > from + 6) out.push([from, a]);
      from = Math.max(from, b);
    }
    if (hi > from + 6) out.push([from, hi]);
    return out;
  };
  const corridor: Map<number, number>[] = spec.edges.map(() => new Map());
  const wanted: { edge: number; row: number; ideal: number; span: [number, number] }[] = [];
  spec.edges.forEach((e, i) => {
    const ra = rowOf.get(e.from)!;
    const rz = rowOf.get(e.to)!;
    if (e.from === e.to || Math.abs(ra - rz) < 2) return;
    const a = at.get(e.from)!;
    const z = at.get(e.to)!;
    for (let k = Math.min(ra, rz) + 1; k < Math.max(ra, rz); k++) {
      const mid = flat[k].top + flat[k].h / 2;
      const f = (mid - a.y) / (z.y - a.y);
      const ideal = a.x + (z.x - a.x) * f;
      const spans = free(k);
      const clear = spans.find(([s, t]) => ideal >= s + 2 && ideal <= t - 2);
      if (clear) {
        corridor[i].set(k, ideal);
        continue;
      }
      // The nearest gap to where it would have gone.
      const near = spans.reduce<[number, number] | null>((b, s) => (!b || Math.min(Math.abs(ideal - s[0]), Math.abs(ideal - s[1])) < Math.min(Math.abs(ideal - b[0]), Math.abs(ideal - b[1])) ? s : b), null);
      wanted.push({ edge: i, row: k, ideal, span: near ?? [lo, hi] });
    }
  });
  // Arrows sent to the same gap run side by side in it.
  const byGap = new Map<string, typeof wanted>();
  for (const w of wanted) byGap.set(`${w.row}:${w.span[0]}`, [...(byGap.get(`${w.row}:${w.span[0]}`) ?? []), w]);
  for (const group of byGap.values()) {
    group.sort((p, q) => p.ideal - q.ideal || p.edge - q.edge);
    const [s, t] = group[0].span;
    const gap = Math.min(9, (t - s - 4) / group.length);
    const mean = group.reduce((m, w) => m + Math.min(t - 2, Math.max(s + 2, w.ideal)), 0) / group.length;
    const start = Math.min(t - 2 - gap * (group.length - 1), Math.max(s + 2, mean - (gap * (group.length - 1)) / 2));
    group.forEach((w, n) => corridor[w.edge].set(w.row, start + gap * n));
  }

  // Ports: where arrows meet a box's top or bottom, side by side, in the order their other ends lie.
  type Port = { edge: number; end: "from" | "to"; sort: number };
  const ports = new Map<string, Port[]>();
  const sideOf = (id: string, other: string) => (rowOf.get(other)! < rowOf.get(id)! ? "top" : rowOf.get(other)! > rowOf.get(id)! ? "bottom" : "top");
  spec.edges.forEach((e, i) => {
    if (e.from === e.to) return;
    const c = [...corridor[i].entries()].sort((p, q) => p[0] - q[0]).map((p) => p[1]);
    const down = rowOf.get(e.from)! < rowOf.get(e.to)!;
    const nearFrom = c.length ? c[down ? 0 : c.length - 1] : at.get(e.to)!.x;
    const nearTo = c.length ? c[down ? c.length - 1 : 0] : at.get(e.from)!.x;
    const add = (id: string, other: string, end: "from" | "to", sort: number) => {
      const key = `${id}:${sideOf(id, other)}`;
      ports.set(key, [...(ports.get(key) ?? []), { edge: i, end, sort }]);
    };
    add(e.from, e.to, "from", nearFrom);
    add(e.to, e.from, "to", nearTo);
  });
  const portX = new Map<string, number>();
  for (const [key, list] of ports) {
    const node = at.get(key.slice(0, key.lastIndexOf(":")))!;
    list.sort((p, q) => p.sort - q.sort || p.edge - q.edge || (p.end === "from" ? -1 : 1));
    const gap = Math.min(PORT_GAP, (node.w - 24) / Math.max(1, list.length - 1));
    list.forEach((p, n) => portX.set(`${p.edge}:${p.end}`, node.x + (n - (list.length - 1) / 2) * gap));
  }

  const edges: Routed[] = spec.edges.map((e, i) => {
    const a = at.get(e.from)!;
    const z = at.get(e.to)!;
    const ra = rowOf.get(e.from)!;
    const rz = rowOf.get(e.to)!;
    let route: { path: string; poly: Point[] };
    if (e.from === e.to) {
      // A box to itself: a loop out of its right side.
      const x = a.x + a.w / 2;
      const p0 = { x, y: a.y - 6 };
      const p3 = { x, y: a.y + 6 };
      const c1 = { x: x + 34, y: a.y - 20 };
      const c2 = { x: x + 34, y: a.y + 20 };
      route = { path: `M ${round(p0.x)} ${round(p0.y)} C ${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${round(p3.x)} ${round(p3.y)}`, poly: cubicPoly(p0, c1, c2, p3) };
    } else if (ra === rz) {
      // In one row: over the top, so it doesn't run through the boxes between.
      const lift = flat[ra].top - 10 - ARC_LEVEL * (arcLevel.get(i) ?? 0);
      const p0 = { x: portX.get(`${i}:from`)!, y: a.y - a.h / 2 };
      const p3 = { x: portX.get(`${i}:to`)!, y: z.y - z.h / 2 };
      const c1 = { x: p0.x, y: lift };
      const c2 = { x: p3.x, y: lift };
      route = { path: `M ${round(p0.x)} ${round(p0.y)} C ${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${round(p3.x)} ${round(p3.y)}`, poly: cubicPoly(p0, c1, c2, p3, 16) };
    } else {
      const down = rz > ra;
      const px = portX.get(`${i}:from`)!;
      const qx = portX.get(`${i}:to`)!;
      const rowEdge = (k: number, leaving: boolean) => (down === leaving ? flat[k].top + flat[k].h : flat[k].top);
      const st: Point[] = [{ x: px, y: down ? a.y + a.h / 2 : a.y - a.h / 2 }, { x: px, y: rowEdge(ra, true) }];
      for (let k = ra + (down ? 1 : -1); k !== rz; k += down ? 1 : -1) {
        const x = corridor[i].get(k)!;
        st.push({ x, y: rowEdge(k, false) }, { x, y: rowEdge(k, true) });
      }
      st.push({ x: qx, y: rowEdge(rz, false) }, { x: qx, y: down ? z.y - z.h / 2 : z.y + z.h / 2 });
      route = viaStations(st);
    }
    // Where it crosses each boundary between its two bands.
    const ba = bandOfNode.get(e.from)!;
    const bz = bandOfNode.get(e.to)!;
    const crossings: Point[] = [];
    for (let k = Math.min(ba, bz) + 1; k <= Math.max(ba, bz); k++) {
      const c = crossingAt(route.poly, bands[k].y);
      if (c) crossings.push(c);
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
    return { ...e, key: `e${i}`, points: [route.poly[0], route.poly[route.poly.length - 1]], path: route.path, poly: route.poly, crossings, skips, via };
  });
  return { nodes, edges, width, height: Math.max(total, 1), bands, gutter };
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
