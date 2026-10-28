import { countdown, isGrid, runs, squareSize } from "./qr";

describe("a QR code as pieces to draw", () => {
  it("joins the dark squares that touch along a row, and leaves the light ones out", () => {
    expect(runs(["0110100", "1111111", "0000000"])).toEqual([
      { row: 0, x: 1, length: 2 },
      { row: 0, x: 4, length: 1 },
      { row: 1, x: 0, length: 7 },
    ]);
    expect(runs(["1011"])).toEqual([
      { row: 0, x: 0, length: 1 },
      { row: 0, x: 2, length: 2 },
    ]);
  });

  it("takes only a square of dark and light squares for a QR code", () => {
    const grid = (n: number) => Array.from({ length: n }, () => "01".repeat(n).slice(0, n));
    expect(isGrid(grid(21))).toBe(true);
    expect(isGrid(grid(45))).toBe(true);
    // Too small to be one, too big to be one, not square, or not squares at all.
    expect(isGrid(grid(10))).toBe(false);
    expect(isGrid(grid(200))).toBe(false);
    expect(isGrid([...grid(21).slice(1), "0101"])).toBe(false);
    expect(isGrid(grid(21).map((r) => r.replace("0", "x")))).toBe(false);
  });

  it("makes the squares big enough to scan while the code and its margin fit", () => {
    // 45 across and a margin of 4 each side is 53 squares: 280 points is 5 each.
    expect(squareSize(280, 45)).toBe(5);
    expect(squareSize(10, 45)).toBe(1);
  });

  it("counts down in minutes and seconds, and stops at zero", () => {
    expect(countdown(300_000, 0)).toBe("5:00");
    expect(countdown(300_000, 28_000)).toBe("4:32");
    expect(countdown(300_000, 299_001)).toBe("0:01");
    expect(countdown(300_000, 400_000)).toBe("0:00");
  });
});
