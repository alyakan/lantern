import { describe, expect, it } from "vitest";
import { menuShift } from "./menuShift";

const viewport = (width: number) => ({ left: 0, right: width });

describe("menuShift", () => {
  it("leaves a menu that already fits alone", () => {
    expect(menuShift({ left: 100, right: 480 }, viewport(1000))).toBe(0);
  });

  it("nudges a menu right when it runs off the left edge", () => {
    // Left edge off screen by 24px (margin 8 => shift 32).
    expect(menuShift({ left: -24, right: 356 }, viewport(1000))).toBe(32);
  });

  it("nudges a menu left when it runs off the right edge", () => {
    expect(menuShift({ left: 650, right: 1030 }, viewport(1000))).toBe(-38);
  });

  it("respects the margin at each edge", () => {
    expect(menuShift({ left: 8, right: 400 }, viewport(1000))).toBe(0);
    expect(menuShift({ left: 7, right: 400 }, viewport(1000))).toBe(1);
    expect(menuShift({ left: 400, right: 992 }, viewport(1000))).toBe(0);
    expect(menuShift({ left: 400, right: 993 }, viewport(1000))).toBe(-1);
  });

  it("clamps to an inset region (a narrowed pane), not just the window", () => {
    // Pane spans 200..700. A menu at 520..900 overflows the pane's right edge: shift left to right - margin.
    expect(menuShift({ left: 520, right: 900 }, { left: 200, right: 700 })).toBe(-208);
    // A menu starting left of the pane is pushed in to pane.left + margin.
    expect(menuShift({ left: 180, right: 560 }, { left: 200, right: 700 })).toBe(28);
  });
});
