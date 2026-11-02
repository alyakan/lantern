import { begin, extend, fitInside, MAX_POINTS, MAX_STROKES, MIN_STEP, pieces, undo } from "./markup";

describe("strokes", () => {
  it("begins a stroke, extends the last one, and undoes it", () => {
    let s = begin([], { x: 0, y: 0 });
    s = extend(s, { x: 10, y: 0 });
    s = begin(s, { x: 5, y: 5 });
    expect(s).toEqual([[{ x: 0, y: 0 }, { x: 10, y: 0 }], [{ x: 5, y: 5 }]]);
    expect(undo(s)).toEqual([[{ x: 0, y: 0 }, { x: 10, y: 0 }]]);
    expect(undo([])).toEqual([]);
  });

  it("ignores a point too near the last one, and an extend with no stroke", () => {
    const s = begin([], { x: 0, y: 0 });
    expect(extend(s, { x: MIN_STEP - 0.5, y: 0 })).toBe(s);
    expect(extend([], { x: 5, y: 5 })).toEqual([]);
  });

  it("keeps to the limits", () => {
    let s = begin([], { x: 0, y: 0 });
    for (let i = 1; i < MAX_POINTS + 50; i++) s = extend(s, { x: i * (MIN_STEP + 1), y: 0 });
    expect(s[0]).toHaveLength(MAX_POINTS);
    let many: ReturnType<typeof begin> = [];
    for (let i = 0; i < MAX_STROKES + 5; i++) many = begin(many, { x: i, y: i });
    expect(many).toHaveLength(MAX_STROKES);
  });
});

describe("pieces", () => {
  it("makes a piece between points with its middle, length and angle", () => {
    const [p] = pieces([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    expect(p).toEqual({ cx: 5, cy: 0, length: 10, angle: 0 });
    expect(pieces([{ x: 0, y: 0 }, { x: 0, y: 4 }])[0]).toMatchObject({ length: 4, angle: 90 });
  });

  it("makes a dot of a single point", () => {
    expect(pieces([{ x: 3, y: 4 }])).toEqual([{ cx: 3, cy: 4, length: 0, angle: 0 }]);
  });
});

describe("fitInside", () => {
  it("keeps the proportions and never makes a photo larger", () => {
    expect(fitInside(4000, 2000, 400, 400)).toEqual({ width: 400, height: 200 });
    expect(fitInside(100, 300, 400, 400)).toEqual({ width: 100, height: 300 });
    expect(fitInside(0, 5, 10, 10)).toEqual({ width: 0, height: 0 });
  });
});
