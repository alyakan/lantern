import { ALLOW_AT, allows, progress } from "./swipe";

describe("swipe to allow", () => {
  it("a press or a short drag never allows", () => {
    for (const dx of [0, 1, 20, 100, 200]) expect(allows(dx, 300)).toBe(false);
  });

  it("letting go near the end allows, and not before ALLOW_AT", () => {
    expect(allows(300 * ALLOW_AT, 300)).toBe(true);
    expect(allows(300 * ALLOW_AT - 1, 300)).toBe(false);
    expect(allows(300, 300)).toBe(true);
    expect(allows(5000, 300)).toBe(true);
  });

  it("a drag backwards, a track with no length, or nonsense never allows", () => {
    expect(allows(-100, 300)).toBe(false);
    expect(allows(100, 0)).toBe(false);
    expect(allows(NaN, 300)).toBe(false);
    expect(allows(Infinity, 300)).toBe(false);
  });

  it("measures how far along a drag is, between 0 and 1", () => {
    expect([progress(-5, 100), progress(0, 100), progress(50, 100), progress(100, 100), progress(500, 100)]).toEqual([0, 0, 0.5, 1, 1]);
  });
});
