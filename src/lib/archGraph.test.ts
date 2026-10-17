import { describe, expect, it } from "vitest";
import { architectureBlock, edgeCrossings, edgesThroughBoxes, issuesOf, layoutArchitecture, nearest, parseArchitecture, pillText, pillWidth, placeLabels, PILL_CHARS, PILL_H, bestRows, routePath, wrapLabel, type ArchLayout, type ArchSpec, type LabelInput, type Rect } from "./archGraph";
import { DENSE_MAP } from "./denseMap";
import { TESTO_MAP } from "./testoMap";

const SPEC = {
  nodes: [
    { id: "caller", label: "Callers" },
    { id: "client", label: "fetchJson", change: "changed", note: "the front door" },
    { id: "policy", label: "Retry policy", change: "new" },
    { id: "legacy", label: "Old wrapper", change: "removed" },
  ],
  edges: [
    { from: "caller", to: "client", label: "calls" },
    { from: "client", to: "policy", label: "asks" },
    { from: "legacy", to: "client" },
  ],
};
const spec = (): ArchSpec => {
  const read = parseArchitecture(JSON.stringify(SPEC));
  if (!("spec" in read)) throw new Error(read.error);
  return read.spec;
};

describe("architectureBlock", () => {
  it("is the first architecture block of a message", () => {
    expect(architectureBlock("Intro\n\n```architecture\n{\"nodes\": []}\n```\n\nMore")).toBe('{"nodes": []}');
    expect(architectureBlock("```mermaid\nflowchart LR\n```")).toBeNull();
  });
});

describe("parseArchitecture", () => {
  it("reads the boxes and arrows, with what the change does to each box", () => {
    const s = spec();
    expect(s.nodes.map((n) => [n.id, n.change])).toEqual([["caller", null], ["client", "changed"], ["policy", "new"], ["legacy", "removed"]]);
    expect(s.nodes[1].note).toBe("the front door");
    expect(s.edges).toEqual([{ from: "caller", to: "client", label: "calls", issue: "" }, { from: "client", to: "policy", label: "asks", issue: "" }, { from: "legacy", to: "client", label: "", issue: "" }]);
  });

  it("says what is wrong with a block it can't draw", () => {
    expect(parseArchitecture("{nodes: [")).toEqual({ error: "It isn't valid JSON." });
    expect(parseArchitecture('{"nodes": []}')).toEqual({ error: "It has no nodes." });
    expect(parseArchitecture('{"nodes": [{"id": "a b"}]}')).toMatchObject({ error: expect.stringContaining("isn't a short name") });
    expect(parseArchitecture('{"nodes": [{"id": "a"}, {"id": "a"}]}')).toEqual({ error: 'Two nodes have the id "a".' });
  });

  it("leaves out an arrow to a box that isn't there, and ignores a change it doesn't know", () => {
    const read = parseArchitecture('{"nodes": [{"id": "a", "change": "moved"}], "edges": [{"from": "a", "to": "ghost"}]}');
    expect(read).toEqual({ spec: { layers: [], nodes: [{ id: "a", label: "a", change: null, status: null, layer: null, note: "", issue: "" }], edges: [] } });
  });
});

describe("layoutArchitecture", () => {
  it("places the boxes left to right in the order the arrows go, each as wide as its label", () => {
    const l = layoutArchitecture(spec());
    const at = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
    expect(at.caller.x).toBeLessThan(at.client.x);
    expect(at.client.x).toBeLessThan(at.policy.x);
    expect(at.legacy.x).toBeLessThan(at.client.x);
    expect(at.policy.w).toBeGreaterThan(at.caller.w);
    // Everything fits in the size it reports.
    for (const n of l.nodes) {
      expect(n.x - n.w / 2).toBeGreaterThanOrEqual(0);
      expect(n.x + n.w / 2).toBeLessThanOrEqual(l.width);
      expect(n.y + n.h / 2).toBeLessThanOrEqual(l.height);
    }
    // Every arrow has a route, and a labelled one a place for its label.
    expect(l.edges.every((e) => e.points.length >= 2)).toBe(true);
    expect(l.edges.find((e) => e.label === "calls")!.labelAt).not.toBeNull();
    expect(l.edges.find((e) => e.label === "calls")!.pill).toMatchObject({ text: "calls", placed: true });
    expect(l.edges.find((e) => e.from === "legacy")!.labelAt).toBeNull();
  });
});

describe("routePath", () => {
  it("is straight for two points and rounded at the bends of more", () => {
    expect(routePath([{ x: 0, y: 0 }, { x: 10, y: 5 }])).toBe("M 0 0 L 10 5");
    expect(routePath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])).toBe("M 0 0 Q 10 0 10 5 L 10 10");
    expect(routePath([])).toBe("");
  });
});

describe("nearest", () => {
  it("is the box next to this one in a direction, for the arrow keys", () => {
    const l = layoutArchitecture(spec());
    expect(nearest(l.nodes, "client", "right")).toBe("policy");
    expect(["caller", "legacy"]).toContain(nearest(l.nodes, "client", "left"));
    expect(nearest(l.nodes, "policy", "right")).toBeNull();
  });
});

const testo = (): ArchSpec => {
  const read = parseArchitecture(JSON.stringify(TESTO_MAP));
  if (!("spec" in read)) throw new Error(read.error);
  return read.spec;
};

describe("a map with layers", () => {
  it("reads the layers, each box's layer and how far it's built, and the issues Claude marked", () => {
    const s = testo();
    expect(s.layers.map((l) => l.label)).toEqual(["UI", "Business logic", "Device boundary", "Testo implementation", "External"]);
    const field = s.nodes.find((n) => n.id === "field")!;
    expect([field.layer, field.status]).toEqual(["ui", "planned"]);
    expect(s.nodes.find((n) => n.id === "window")!.status).toBe("in-progress");
    expect(s.nodes.find((n) => n.id === "window")!.issue).toContain("two jobs");
    expect(s.edges.find((e) => e.from === "cred" && e.to === "api")!.issue).toContain("no expiry");
    // The words Claude may use for a status, and a layer that isn't one of the map's.
    const read = parseArchitecture('{"layers": [{"id": "a"}], "nodes": [{"id": "x", "status": "Built", "layer": "nope"}, {"id": "y", "status": "proposed"}, {"id": "z", "status": "someday"}]}');
    expect("spec" in read && read.spec.nodes.map((n) => [n.status, n.layer])).toEqual([["done", null], ["planned", null], [null, null]]);
  });

  it("puts each layer in a band, top to bottom in order, with every box inside its own", () => {
    const l = layoutArchitecture(testo());
    expect(l.bands.map((b) => b.label)).toEqual(["UI", "Business logic", "Device boundary", "Testo implementation", "External"]);
    for (let i = 1; i < l.bands.length; i++) expect(l.bands[i].y).toBe(l.bands[i - 1].y + l.bands[i - 1].h);
    for (const n of l.nodes) {
      const band = l.bands.find((b) => b.id === n.layer)!;
      expect(n.y - n.h / 2).toBeGreaterThanOrEqual(band.y);
      expect(n.y + n.h / 2).toBeLessThanOrEqual(band.y + band.h);
      expect(n.x - n.w / 2).toBeGreaterThanOrEqual(l.gutter);
      expect(n.x + n.w / 2).toBeLessThanOrEqual(l.width);
    }
    // No two boxes overlap.
    for (const a of l.nodes)
      for (const b of l.nodes) if (a !== b) expect(Math.abs(a.x - b.x) >= (a.w + b.w) / 2 || Math.abs(a.y - b.y) >= (a.h + b.h) / 2).toBe(true);
    // A crowded band wraps: the implementation layer's six boxes take two rows.
    expect(new Set(l.nodes.filter((n) => n.layer === "impl").map((n) => n.y)).size).toBe(2);
  });

  it("marks where each arrow crosses a boundary, and finds the one that goes around a layer", () => {
    const l = layoutArchitecture(testo());
    const edge = (from: string, to: string) => l.edges.find((e) => e.from === from && e.to === to)!;
    expect(edge("field", "sheet").crossings).toEqual([]);
    expect(edge("field", "boundary").crossings).toHaveLength(2);
    expect(edge("field", "boundary").crossings.map((c) => c.y)).toEqual([l.bands[1].y, l.bands[2].y]);
    expect(edge("tdev", "boundary").crossings).toHaveLength(1);
    // UI straight to the Testo device, past the device protocols both are joined to: the crossing Lantern flags.
    expect(edge("field", "tdev").skips).toEqual(["Device boundary"]);
    expect(edge("field", "tdev").via).toEqual(["MeasuringDevice protocols"]);
    // Passing through a layer the two have nothing to do with isn't going around it.
    expect(edge("field", "boundary").skips).toEqual([]);
    expect(edge("answer", "api").skips).toEqual([]);
    expect(edge("tdev", "parse").skips).toEqual([]);
    const issues = issuesOf(l);
    expect(issues.filter((i) => !i.found).map((i) => i.key)).toEqual(["n:window", `e:${edge("cred", "api").key}`]);
    expect(issues.filter((i) => i.found).map((i) => i.text)).toEqual(["Sensor field and view model → TestoMeasuringDevice goes around Device boundary: both are connected through MeasuringDevice protocols, but this arrow skips it."]);
    expect(issues.find((i) => i.key === "n:window")!.text).toMatch(/^Window events and expected quantities: holds/);
  });

  it("fits each label in its box, wrapping it rather than cutting it short", () => {
    expect(wrapLabel("Window events and expected quantities")).toEqual(["Window events and", "expected quantities"]);
    expect(wrapLabel("Gating")).toEqual(["Gating"]);
    // A word longer than a line is split; a fourth line folds into the third, cut short.
    expect(wrapLabel("a verylongidentifierwithoutanyspacesatallhere")).toEqual(["a", "verylongidentifierwith", "outanyspacesatallhere"]);
    expect(wrapLabel("one two three four five six seven eight nine ten eleven twelve thirteen fourteen", 10)).toHaveLength(3);
    const l = layoutArchitecture(testo());
    const win = l.nodes.find((n) => n.id === "window")!;
    expect(win.lines).toEqual(["Window events and", "expected quantities"]);
    const gate = l.nodes.find((n) => n.id === "gate")!;
    expect(win.h).toBeGreaterThan(gate.h);
    // Every line fits the box's width (at the label's character width).
    for (const n of l.nodes) for (const line of n.lines) expect(line.length * 7.1 + 34).toBeLessThanOrEqual(n.w + 0.5);
  });

  it("keeps a map without layers laid out as before", () => {
    const l = layoutArchitecture(spec());
    expect(l.bands).toEqual([]);
    expect(l.edges.every((e) => e.crossings.length === 0 && e.skips.length === 0)).toBe(true);
  });
});


const dense = (): ArchSpec => {
  const read = parseArchitecture(JSON.stringify(DENSE_MAP));
  if (!("spec" in read)) throw new Error(read.error);
  return read.spec;
};
const boxOf = (n: { x: number; y: number; w: number; h: number }): Rect => ({ x: n.x - n.w / 2, y: n.y - n.h / 2, w: n.w, h: n.h });
const pillBox = (p: { x: number; y: number; w: number; h: number }): Rect => ({ x: p.x - p.w / 2, y: p.y - p.h / 2, w: p.w, h: p.h });
const distToSegment = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => {
  const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
};
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("the labels on the arrows (pills)", () => {
  const l: ArchLayout = layoutArchitecture(dense());
  const pills = l.edges.filter((e) => e.pill).map((e) => ({ e, p: e.pill! }));

  it("gives every labelled arrow a pill that is placed or flagged for hover, and none to an arrow without a label", () => {
    expect(pills).toHaveLength(DENSE_MAP.edges.filter((e) => "label" in e && e.label).length);
    expect(l.edges.filter((e) => !e.label).every((e) => e.pill === null && e.labelAt === null)).toBe(true);
    for (const { e, p } of pills) {
      expect(typeof p.placed).toBe("boolean");
      expect(e.labelAt === null).toBe(!p.placed);
    }
    // A crowded map still puts nearly all of them on the map.
    expect(pills.filter(({ p }) => p.placed).length).toBeGreaterThanOrEqual(pills.length - 4);
  });

  it("puts no two placed pills on each other, and none on a box", () => {
    const placed = pills.filter(({ p }) => p.placed).map(({ p }) => pillBox(p));
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i], placed[j])).toBe(false);
    for (const p of placed) for (const n of l.nodes) expect(overlap(p, boxOf(n))).toBe(false);
    // Nor in the room the layer names take, nor off the map.
    for (const p of placed) {
      expect(p.x).toBeGreaterThanOrEqual(l.gutter);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x + p.w).toBeLessThanOrEqual(l.width);
      expect(p.y + p.h).toBeLessThanOrEqual(l.height);
    }
  });

  it("keeps a pill at its own arrow, small, and cuts a long label short (the whole of it is kept for hover)", () => {
    const long = l.edges.find((e) => e.label.startsWith("pairs, measures"))!;
    expect(long.label.length).toBeGreaterThan(PILL_CHARS);
    expect(long.pill!.text).toHaveLength(PILL_CHARS);
    expect(long.pill!.text.endsWith("…")).toBe(true);
    // The map reads a label to 40 characters; the pill keeps the whole of that for hover.
    expect(long.label.startsWith("pairs, measures and reports back")).toBe(true);
    for (const { e, p } of pills) {
      expect(p.h).toBe(PILL_H);
      expect(p.w).toBeLessThanOrEqual(pillWidth(PILL_CHARS + 2));
      // Within a pill's reach of its own line.
      const near = Math.min(...e.poly.slice(1).map((q, i) => distToSegment(p, e.poly[i], q)));
      expect(near).toBeLessThan(p.w / 2 + 6);
    }
    expect(pillText("short")).toBe("short");
  });

  it("draws no arrow through a box it doesn't touch, and crosses no more than the map's own arrows must", () => {
    expect(edgesThroughBoxes(l.edges, l.nodes)).toBe(0);
    // It was 49 crossings (and 26 arrows through boxes) before the arrows were routed.
    expect(edgeCrossings(l.edges)).toBeLessThanOrEqual(49);
  });

  it("keeps the layer names' column clear of arrows and pills", () => {
    for (const layout of [l, layoutArchitecture(testo()), layoutArchitecture(dense(), "LR", 2)]) {
      expect(layout.gutter).toBeGreaterThan(0);
      for (const e of layout.edges) for (const p of e.poly) expect(p.x).toBeGreaterThanOrEqual(layout.gutter);
      for (const e of layout.edges) if (e.pill?.placed) expect(e.pill.x - e.pill.w / 2).toBeGreaterThanOrEqual(layout.gutter);
    }
  });

  it("draws two arrows between the same boxes, one each way, side by side", () => {
    const a = l.edges.find((e) => e.from === "ble" && e.to === "device")!;
    const b = l.edges.find((e) => e.from === "device" && e.to === "ble")!;
    expect(a.path).not.toBe(b.path);
    expect(edgeCrossings([a, b].map((e, i) => ({ ...e, from: `x${i}`, to: `y${i}` })))).toBe(0);
    const pa = a.pill!;
    const pb = b.pill!;
    if (pa.placed && pb.placed) expect(overlap(pillBox(pa), pillBox(pb))).toBe(false);
  });

  it("lays the same map out the same way each time, and a map of 40 boxes and 80 arrows quickly", () => {
    expect(layoutArchitecture(dense()).edges.map((e) => e.path)).toEqual(l.edges.map((e) => e.path));
    const nodes = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, label: `Box ${i}`, layer: `l${i % 6}`, status: "done" }));
    const edges = Array.from({ length: 80 }, (_, i) => ({ from: `n${(i * 7) % 40}`, to: `n${(i * 11 + 3) % 40}`, label: ["reads", "writes", "asks", "notifies"][i % 4] }));
    const read = parseArchitecture(JSON.stringify({ layers: Array.from({ length: 6 }, (_, i) => ({ id: `l${i}`, label: `Layer ${i}` })), nodes, edges }));
    if (!("spec" in read)) throw new Error(read.error);
    const t = performance.now();
    const big = layoutArchitecture(read.spec);
    expect(performance.now() - t).toBeLessThan(4000);
    const placed = big.edges.filter((e) => e.pill?.placed).map((e) => pillBox(e.pill!));
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i], placed[j])).toBe(false);
    expect(edgesThroughBoxes(big.edges, big.nodes)).toBe(0);
  });

  it("lays a map without layers out with pills too, and keeps the ranking that crosses least", () => {
    const flat = { ...dense(), layers: [], nodes: dense().nodes.map((n) => ({ ...n, layer: null })) };
    const f = layoutArchitecture(flat);
    expect(f.bands).toEqual([]);
    const placed = f.edges.filter((e) => e.pill?.placed).map((e) => pillBox(e.pill!));
    expect(placed.length).toBeGreaterThan(30);
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i], placed[j])).toBe(false);
    for (const p of placed) for (const n of f.nodes) expect(overlap(p, boxOf(n))).toBe(false);
  });

  it("takes fewer boxes to a row in a narrow room, so the map needn't be panned sideways", () => {
    const made: number[] = [];
    const layoutFor = (r: number) => (made.push(r), layoutArchitecture(dense(), "LR", r));
    const wide = bestRows(layoutFor, { w: 1800, h: 1400 }, 0.75);
    // Room for the widest: it is the only one made.
    expect(wide.rowMax).toBe(5);
    expect(made).toEqual([5]);
    const narrow = bestRows((r) => layoutArchitecture(dense(), "LR", r), { w: 600, h: 700 }, 0.75);
    expect(narrow.rowMax).toBeLessThan(5);
    expect(narrow.rowMax).toBeGreaterThanOrEqual(2);
    // The one it takes is no wider than the room at the smallest fit (or the narrowest there is).
    expect(narrow.layout.width * 0.75 <= 600 - 16 || narrow.rowMax === 2).toBe(true);
    // No room yet: the widest.
    expect(bestRows((r) => layoutArchitecture(dense(), "LR", r), { w: 0, h: 0 }, 0.75).rowMax).toBe(5);
    const rows = (max: number) => new Set(layoutArchitecture(dense(), "LR", max).nodes.filter((n) => n.layer === "domain").map((n) => n.y)).size;
    expect(rows(2)).toBeGreaterThan(rows(5));
  });
});

describe("placeLabels", () => {
  const line = (x0: number, y0: number, x1: number, y1: number) => Array.from({ length: 11 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / 10, y: y0 + ((y1 - y0) * i) / 10 }));
  const size = { w: 600, h: 400 };
  const input = (key: string, text: string, poly: { x: number; y: number }[]): LabelInput => ({ key, text, poly });

  it("moves a label off another's spot, along its own arrow or beside it", () => {
    // Two arrows over each other with the same word: the middle is wanted twice.
    const a = input("a", "reads", line(100, 50, 100, 350));
    const b = input("b", "reads", line(100, 50, 100, 350));
    const [pa, pb] = placeLabels([a, b], [], size);
    expect(pa.placed && pb.placed).toBe(true);
    expect(overlap(pillBox(pa), pillBox(pb))).toBe(false);
  });

  it("keeps a label off the boxes", () => {
    const box: Rect = { x: 60, y: 160, w: 90, h: 80 };
    const [p] = placeLabels([input("a", "asks", line(100, 50, 100, 350))], [box], size);
    expect(p.placed).toBe(true);
    expect(overlap(pillBox(p), box)).toBe(false);
  });

  it("leaves off a label that fits nowhere, and says so", () => {
    // A box over the whole line and everything near it.
    const [p] = placeLabels([input("a", "asks", line(100, 50, 100, 350))], [{ x: 0, y: 0, w: 600, h: 400 }], size);
    expect(p.placed).toBe(false);
    // Its spot is still its arrow's middle, for the marker and the hover.
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(200);
  });

  it("gives more labels than room a place each, or leaves them off, never on each other", () => {
    const inputs = Array.from({ length: 30 }, (_, i) => input(`e${i}`, "connects to", line(200 + (i % 3), 20, 200 + (i % 3), 380)));
    const out = placeLabels(inputs, [], size);
    const placed = out.filter((p) => p.placed).map(pillBox);
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i], placed[j])).toBe(false);
    expect(out).toHaveLength(30);
  });

  it("is pure: the same input gives the same places", () => {
    const inputs = [input("a", "reads", line(100, 50, 300, 350)), input("b", "writes", line(300, 50, 100, 350))];
    expect(placeLabels(inputs, [], size)).toEqual(placeLabels(inputs, [], size));
  });
});
