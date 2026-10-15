import { describe, expect, it } from "vitest";
import { inSummary, bounds, centerOn, clampZoom, firstBox, fitView, GAP, MAIN_SIZE, MAX_ZOOM, MIN_NODE, MIN_ZOOM, moveBox, overlaps, panBy, placeWorker, resizeBox, SUMMARY_ZOOM, tether, toScreen, toWorld, WORKER_SIZE, zoomAt, type Box, type View } from "./canvas";

const view: View = { x: 100, y: 50, zoom: 0.5 };

describe("the view", () => {
  it("maps the world onto the screen and back", () => {
    expect(toScreen(view, { x: 200, y: 200 })).toEqual({ x: 200, y: 150 });
    expect(toWorld(view, { x: 200, y: 150 })).toEqual({ x: 200, y: 200 });
    const p = { x: -37.5, y: 812 };
    const round = toWorld(view, toScreen(view, p));
    expect(round.x).toBeCloseTo(p.x);
    expect(round.y).toBeCloseTo(p.y);
  });

  it("zooms around the cursor, which keeps the world point under it", () => {
    const at = { x: 300, y: 220 };
    const before = toWorld(view, at);
    const z = zoomAt(view, 1.5, at);
    expect(z.zoom).toBeCloseTo(0.75);
    const after = toWorld(z, at);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("stops zooming at the limits, and a zoom that changes nothing returns the same view", () => {
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    const max: View = { x: 1, y: 2, zoom: MAX_ZOOM };
    expect(zoomAt(max, 2, { x: 10, y: 10 })).toBe(max);
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, 100, { x: 0, y: 0 }).zoom).toBe(MAX_ZOOM);
  });

  it("pans in screen pixels", () => {
    expect(panBy(view, -30, 12)).toEqual({ x: 70, y: 62, zoom: 0.5 });
  });

  it("fits every agent into the viewport, centred, and never zooms in past 1", () => {
    const boxes: Box[] = [firstBox(), { x: 800, y: -300, ...WORKER_SIZE }, { x: 800, y: 900, ...WORKER_SIZE }];
    const viewport = { w: 1200, h: 800 };
    const v = fitView(boxes, viewport);
    const b = bounds(boxes)!;
    const tl = toScreen(v, { x: b.x, y: b.y });
    const br = toScreen(v, { x: b.x + b.w, y: b.y + b.h });
    expect(tl.x).toBeGreaterThanOrEqual(0);
    expect(tl.y).toBeGreaterThanOrEqual(0);
    expect(br.x).toBeLessThanOrEqual(viewport.w);
    expect(br.y).toBeLessThanOrEqual(viewport.h);
    expect((tl.x + br.x) / 2).toBeCloseTo(viewport.w / 2);
    expect((tl.y + br.y) / 2).toBeCloseTo(viewport.h / 2);
    // One small agent in a big window stays at its size.
    expect(fitView([{ x: 0, y: 0, w: 300, h: 200 }], { w: 2000, h: 2000 }).zoom).toBe(1);
    expect(fitView([], viewport)).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(fitView(boxes, { w: 0, h: 0 })).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it("centres an agent that needs you", () => {
    const box: Box = { x: 1000, y: 400, w: 400, h: 300 };
    const v = centerOn(box, { w: 1000, h: 600 }, 1);
    expect(toScreen(v, { x: 1200, y: 550 })).toEqual({ x: 500, y: 300 });
  });
});

describe("placing workers", () => {
  const main = firstBox();

  it("puts the first worker level with its parent, to the right of it", () => {
    const w = placeWorker([main], main);
    expect(w).toEqual({ x: MAIN_SIZE.w + GAP, y: 0, ...WORKER_SIZE });
  });

  it("fills a column of two (level, then below), then starts the next one", () => {
    const boxes: Box[] = [main];
    const placed: Box[] = [];
    for (let i = 0; i < 6; i++) {
      const w = placeWorker(boxes, main);
      boxes.push(w);
      placed.push(w);
    }
    const col0 = MAIN_SIZE.w + GAP;
    const col1 = col0 + WORKER_SIZE.w + GAP;
    const col2 = col1 + WORKER_SIZE.w + GAP;
    expect(placed.map((b) => b.x)).toEqual([col0, col0, col1, col1, col2, col2]);
    expect(placed.slice(0, 2).map((b) => b.y)).toEqual([0, WORKER_SIZE.h + GAP]);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j]), `${i} and ${j}`).toBe(false);
  });

  it("keeps a full team at a size where a chat can still be read", () => {
    const boxes: Box[] = [main];
    for (let i = 0; i < 3; i++) boxes.push(placeWorker(boxes, main));
    // Three workers (the usual team) in an ordinary window.
    expect(fitView(boxes, { w: 1426, h: 845 }).zoom).toBeGreaterThanOrEqual(SUMMARY_ZOOM);
    for (let i = 3; i < 6; i++) boxes.push(placeWorker(boxes, main));
    expect(fitView(boxes, { w: 1426, h: 845 }).zoom).toBeGreaterThanOrEqual(0.45);
  });

  it("goes around an agent the user moved onto a spot", () => {
    const moved: Box = { x: MAIN_SIZE.w + GAP + 40, y: 30, ...WORKER_SIZE };
    const w = placeWorker([main, moved], main);
    expect(overlaps(w, moved)).toBe(false);
    expect(overlaps(w, main)).toBe(false);
  });

  it("always finds somewhere, even when crowded", () => {
    const crowd: Box[] = [main, { x: MAIN_SIZE.w, y: -5000, w: 90_000, h: 10_000 }];
    const w = placeWorker(crowd, main);
    expect(overlaps(w, main)).toBe(false);
  });
});

describe("tethers", () => {
  const a: Box = { x: 0, y: 0, w: 400, h: 600 };

  it("leave the parent's right edge and arrive at a worker's left edge when it is to the right", () => {
    const b: Box = { x: 500, y: 100, w: 300, h: 300 };
    const t = tether(a, b);
    expect(t.from.x).toBe(400);
    expect(t.to.x).toBe(500);
    expect(t.from.y).toBeGreaterThanOrEqual(a.y);
    expect(t.from.y).toBeLessThanOrEqual(a.y + a.h);
    expect(t.d.startsWith(`M 400 ${t.from.y} C`)).toBe(true);
    expect(t.d.endsWith(`500 ${t.to.y}`)).toBe(true);
  });

  it("mirror when the worker is to the left, and go vertical when it is above or below", () => {
    const left = tether(a, { x: -500, y: 0, w: 300, h: 300 });
    expect([left.from.x, left.to.x]).toEqual([0, -200]);
    const below = tether(a, { x: 50, y: 700, w: 300, h: 300 });
    expect([below.from.y, below.to.y]).toEqual([600, 700]);
    expect(below.d).toMatch(/^M [\d.-]+ 600 C [\d.-]+ [\d.-]+, [\d.-]+ [\d.-]+, [\d.-]+ 700$/);
    const above = tether(a, { x: 50, y: -500, w: 300, h: 300 });
    expect([above.from.y, above.to.y]).toEqual([0, -200]);
  });

  it("stay on the edges for agents of any size, and never produce NaN", () => {
    for (const b of [{ x: 0, y: 0, w: 400, h: 600 }, { x: 10, y: 10, w: 1, h: 1 }, { x: 400, y: 0, w: 10, h: 10 }, { x: -3000, y: 9000, w: 300, h: 240 }]) {
      const t = tether(a, b);
      expect(t.d).not.toContain("NaN");
      expect(Number.isFinite(t.from.x + t.from.y + t.to.x + t.to.y)).toBe(true);
    }
  });
});

describe("moving and resizing", () => {
  it("moves by screen pixels at the current zoom", () => {
    expect(moveBox({ x: 10, y: 10, w: 300, h: 300 }, 50, -20, 0.5)).toEqual({ x: 110, y: -30, w: 300, h: 300 });
  });

  it("resizes from the corner and never below the minimum", () => {
    expect(resizeBox({ x: 0, y: 0, w: 400, h: 400 }, 100, 50, 1)).toEqual({ x: 0, y: 0, w: 500, h: 450 });
    expect(resizeBox({ x: 0, y: 0, w: 400, h: 400 }, -9999, -9999, 1)).toEqual({ x: 0, y: 0, ...MIN_NODE });
  });
});

describe("inSummary", () => {
  it("turns agents into cards below 0.48 and back into chats above 0.52, and leaves them as they were in between", () => {
    expect(inSummary(false, 0.47)).toBe(true);
    expect(inSummary(false, 0.5)).toBe(false);
    expect(inSummary(true, 0.5)).toBe(true);
    expect(inSummary(true, 0.53)).toBe(false);
    expect(inSummary(false, 1)).toBe(false);
  });
});
