import { describe, expect, it } from "vitest";
import { architectureBlock, issuesOf, layoutArchitecture, nearest, parseArchitecture, routePath, wrapLabel, type ArchSpec } from "./archGraph";
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

