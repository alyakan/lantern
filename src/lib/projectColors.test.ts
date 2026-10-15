import { describe, expect, it } from "vitest";
import { PROJECT_COLORS, assignColors } from "./projectColors";

describe("project colours", () => {
  it("gives projects in view different colours, in the list's order", () => {
    expect(assignColors(["/a", "/b", "/c"], {})).toEqual({ "/a": 0, "/b": 1, "/c": 2 });
  });

  it("never changes a saved colour, and returns the same object when nothing is new", () => {
    const saved = { "/a": 3, "/b": 5 };
    expect(assignColors(["/a", "/b"], saved)).toBe(saved);
    expect(assignColors(["/b", "/c"], saved)).toEqual({ "/a": 3, "/b": 5, "/c": 0 });
  });

  it("avoids the colours of the projects in view first, then the ones saved projects use most", () => {
    // /a (colour 0) is saved but not in view; /b in view has 1. The new one skips 1, and prefers 2 over 0, which /a has.
    expect(assignColors(["/b", "/c"], { "/a": 0, "/b": 1 })["/c"]).toBe(2);
  });

  it("shares colours evenly once there are more projects than colours", () => {
    const folders = Array.from({ length: PROJECT_COLORS.length + 2 }, (_, i) => `/p${i}`);
    const given = Object.values(assignColors(folders, {}));
    expect(given.slice(PROJECT_COLORS.length)).toEqual([0, 1]);
  });

  it("replaces a saved colour that isn't one any more", () => {
    expect(assignColors(["/a"], { "/a": 99 })).toEqual({ "/a": 0 });
  });
});
