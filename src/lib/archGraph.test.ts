import { describe, expect, it } from "vitest";
import { architectureBlock, layoutArchitecture, nearest, parseArchitecture, routePath, type ArchSpec } from "./archGraph";

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
    expect(s.edges).toEqual([{ from: "caller", to: "client", label: "calls" }, { from: "client", to: "policy", label: "asks" }, { from: "legacy", to: "client", label: "" }]);
  });

  it("says what is wrong with a block it can't draw", () => {
    expect(parseArchitecture("{nodes: [")).toEqual({ error: "It isn't valid JSON." });
    expect(parseArchitecture('{"nodes": []}')).toEqual({ error: "It has no nodes." });
    expect(parseArchitecture('{"nodes": [{"id": "a b"}]}')).toMatchObject({ error: expect.stringContaining("isn't a short name") });
    expect(parseArchitecture('{"nodes": [{"id": "a"}, {"id": "a"}]}')).toEqual({ error: 'Two nodes have the id "a".' });
  });

  it("leaves out an arrow to a box that isn't there, and ignores a change it doesn't know", () => {
    const read = parseArchitecture('{"nodes": [{"id": "a", "change": "moved"}], "edges": [{"from": "a", "to": "ghost"}]}');
    expect(read).toEqual({ spec: { nodes: [{ id: "a", label: "a", change: null, note: "" }], edges: [] } });
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
