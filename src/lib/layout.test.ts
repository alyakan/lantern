import { describe, expect, it } from "vitest";
import { clampRatio, stepFile } from "./layout";

describe("clampRatio", () => {
  it("keeps both panes above their minimum widths", () => {
    expect(clampRatio(0.1, 1000, 320, 360)).toBeCloseTo(0.32);
    expect(clampRatio(0.9, 1000, 320, 360)).toBeCloseTo(0.64);
    expect(clampRatio(0.5, 1000, 320, 360)).toBe(0.5);
  });

  it("falls back to an even split when the window is too narrow", () => {
    expect(clampRatio(0.2, 600, 320, 360)).toBe(0.5);
  });
});

describe("stepFile", () => {
  const files = ["/a", "/b", "/c"].map((path) => ({ path, created: false, added: 0, removed: 0 }));

  it("moves and stops at the ends", () => {
    expect(stepFile(files, "/b", 1)).toBe("/c");
    expect(stepFile(files, "/c", 1)).toBe("/c");
    expect(stepFile(files, "/a", -1)).toBe("/a");
  });

  it("starts from the last file when nothing is selected", () => {
    expect(stepFile(files, null, -1)).toBe("/b");
    expect(stepFile([], null, 1)).toBeNull();
  });
});
