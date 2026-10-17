import { describe, expect, it } from "vitest";
import { layoutArchitecture, parseArchitecture } from "./archGraph";
import { FOCUS_OPACITY, focusOf } from "./archFocus";

// a → b → c, and d off to the side (d → c); e is joined to nothing.
const read = parseArchitecture(JSON.stringify({ nodes: ["a", "b", "c", "d", "e"].map((id) => ({ id })), edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "d", to: "c" }] }));
if (!("spec" in read)) throw new Error(read.error);
const layout = layoutArchitecture(read.spec);
const key = (from: string, to: string) => layout.edges.find((e) => e.from === from && e.to === to)!.key;

describe("focusOf", () => {
  it("draws everything at full strength when no part is on screen (the Overview)", () => {
    const f = focusOf(layout, []);
    expect(f.active).toBe(false);
    expect([...f.nodes.values(), ...f.edges.values()].every((v) => v === "full")).toBe(true);
    // A part that covers nothing on this map is the same as none.
    expect(focusOf(layout, ["ghost"]).active).toBe(false);
  });

  it("lights the boxes a part covers and the arrows between them, half-lights arrows out of them, and steps back the rest", () => {
    const f = focusOf(layout, ["a", "b"]);
    expect(f.active).toBe(true);
    expect([...f.nodes].filter(([, v]) => v === "full").map(([id]) => id)).toEqual(["a", "b"]);
    expect([...f.nodes].filter(([, v]) => v === "dim").map(([id]) => id)).toEqual(["c", "d", "e"]);
    expect(f.edges.get(key("a", "b"))).toBe("full");
    // Between a covered box and one that isn't: medium.
    expect(f.edges.get(key("b", "c"))).toBe("context");
    // Touching no covered box: faint.
    expect(f.edges.get(key("d", "c"))).toBe("dim");
  });

  it("treats an arrow into a single covered box as context, and one between two covered boxes as full", () => {
    const f = focusOf(layout, ["c"]);
    expect(f.edges.get(key("b", "c"))).toBe("context");
    expect(f.edges.get(key("d", "c"))).toBe("context");
    expect(f.edges.get(key("a", "b"))).toBe("dim");
    expect(focusOf(layout, ["b", "c"]).edges.get(key("b", "c"))).toBe("full");
  });

  it("lights what an issue picked from the list is about, and shows everything while Show all is held", () => {
    const box = focusOf(layout, [], { node: "e", edge: null });
    expect(box.active).toBe(true);
    expect(box.nodes.get("e")).toBe("full");
    expect(box.nodes.get("a")).toBe("dim");
    const arrow = focusOf(layout, [], { node: null, edge: key("a", "b") });
    expect(arrow.edges.get(key("a", "b"))).toBe("full");
    expect(arrow.nodes.get("a")).toBe("full");
    expect(arrow.nodes.get("b")).toBe("full");
    expect(arrow.nodes.get("c")).toBe("dim");
    const all = focusOf(layout, ["a"], null, true);
    expect(all.active).toBe(false);
    expect([...all.nodes.values(), ...all.edges.values()].every((v) => v === "full")).toBe(true);
  });

  it("fades the faint ones to about a quarter, the medium ones to about 0.6", () => {
    expect(FOCUS_OPACITY.full).toBe(1);
    expect(FOCUS_OPACITY.context).toBe(0.6);
    expect(FOCUS_OPACITY.dim).toBeGreaterThanOrEqual(0.25);
    expect(FOCUS_OPACITY.dim).toBeLessThanOrEqual(0.3);
  });
});
