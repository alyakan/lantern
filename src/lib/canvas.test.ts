import { describe, expect, it } from "vitest";
import { inSummary, bounds, centerOn, clampZoom, firstBox, fitView, GAP, READABLE_ZOOM, MAIN_SIZE, MAX_ZOOM, MIN_NODE, MIN_ZOOM, moveBox, overlaps, panBy, PLACE_COLUMNS, placeCheck, placeWorker, inView, resizeBox, SUMMARY_ZOOM, tether, toScreen, toWorld, WORKER_SIZE, zoomAt, type Box, type View } from "./canvas";

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
    const boxes: Box[] = [firstBox(), { x: 800, y: -50, ...WORKER_SIZE }, { x: 800, y: 150, ...WORKER_SIZE }];
    const viewport = { w: 1400, h: 800 };
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

  it("doesn't zoom out of readable by itself: it shows what fits from the main agent and leaves the rest to a pan", () => {
    const boxes: Box[] = [firstBox()];
    for (let i = 0; i < 8; i++) boxes.push(placeWorker(boxes, boxes[0]));
    const viewport = { w: 1100, h: 800 };
    const v = fitView(boxes, viewport);
    expect(v.zoom).toBe(READABLE_ZOOM);
    // The main agent starts at the top left, with a little room.
    expect(toScreen(v, { x: 0, y: 0 })).toEqual({ x: 24, y: 24 });
  });

  it("centres an agent that needs you", () => {
    const box: Box = { x: 1000, y: 400, w: 400, h: 300 };
    const v = centerOn(box, { w: 1000, h: 600 }, 1);
    expect(toScreen(v, { x: 1200, y: 550 })).toEqual({ x: 500, y: 300 });
  });
});

describe("placing workers", () => {
  const main = firstBox();
  const noOverlap = (boxes: Box[]) => {
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j]), `${i} and ${j}`).toBe(false);
  };
  const fill = (boxes: Box[], n: number) => {
    const placed: Box[] = [];
    for (let i = 0; i < n; i++) {
      const w = placeWorker(boxes, boxes[0]);
      boxes.push(w);
      placed.push(w);
    }
    return placed;
  };

  it("puts the first worker right below the Lead, aligned with it", () => {
    expect(placeWorker([main], main)).toEqual({ x: 0, y: MAIN_SIZE.h + GAP, ...WORKER_SIZE });
  });

  it("works on an empty canvas around a Lead that is the only card, wherever the Lead is", () => {
    const lead: Box = { x: -300, y: 900, ...MAIN_SIZE };
    expect(placeWorker([lead], lead)).toEqual({ x: -300, y: 900 + MAIN_SIZE.h + GAP, ...WORKER_SIZE });
    expect(placeWorker([], lead)).toEqual({ x: -300, y: 900 + MAIN_SIZE.h + GAP, ...WORKER_SIZE });
  });

  it("fills a row below the Lead, then wraps to the next row, never going far to the right", () => {
    const boxes: Box[] = [main];
    const placed = fill(boxes, 7);
    const col = (i: number) => i * (WORKER_SIZE.w + GAP);
    const row0 = MAIN_SIZE.h + GAP;
    const row1 = row0 + WORKER_SIZE.h + GAP;
    expect(placed.map((b) => [b.x, b.y])).toEqual([
      [col(0), row0],
      [col(1), row0],
      [col(2), row0],
      [col(0), row1],
      [col(1), row1],
      [col(2), row1],
      [col(0), row1 + WORKER_SIZE.h + GAP],
    ]);
    noOverlap(boxes);
    // However many there are, the team is never wider than three cards.
    for (const b of placed) expect(b.x + b.w).toBeLessThanOrEqual(PLACE_COLUMNS * (WORKER_SIZE.w + GAP));
  });

  it("many cards: 30 placed in turn never overlap each other or the Lead", () => {
    const boxes: Box[] = [main];
    fill(boxes, 30);
    noOverlap(boxes);
    expect(bounds(boxes)!.w).toBeLessThanOrEqual(PLACE_COLUMNS * (WORKER_SIZE.w + GAP));
  });

  it("keeps the saved positions as they are: placing a new card changes nothing that was placed", () => {
    const moved: Box = { x: 900, y: 40, ...WORKER_SIZE };
    const boxes: Box[] = [main, moved];
    const before = JSON.parse(JSON.stringify(boxes));
    placeWorker(boxes, main);
    expect(boxes).toEqual(before);
  });

  it("goes around a card the user moved onto a spot, and uses the free spot beside it", () => {
    const first: Box = { x: 0, y: MAIN_SIZE.h + GAP, ...WORKER_SIZE };
    const moved: Box = { x: first.x + 40, y: first.y + 30, ...WORKER_SIZE };
    const w = placeWorker([main, moved], main);
    expect(overlaps(w, moved, GAP / 2)).toBe(false);
    expect(overlaps(w, main)).toBe(false);
    // The nearest spot that is free: the next one along the row.
    expect(w).toEqual({ x: 2 * (WORKER_SIZE.w + GAP), y: first.y, ...WORKER_SIZE });
  });

  it("uses a gap the user left, nearest the Lead first", () => {
    const boxes: Box[] = [main, { x: 0, y: MAIN_SIZE.h + GAP, ...WORKER_SIZE }, { x: 2 * (WORKER_SIZE.w + GAP), y: MAIN_SIZE.h + GAP, ...WORKER_SIZE }];
    expect(placeWorker(boxes, main)).toEqual({ x: WORKER_SIZE.w + GAP, y: MAIN_SIZE.h + GAP, ...WORKER_SIZE });
  });

  it("always finds somewhere, even when crowded", () => {
    const crowd: Box[] = [main, { x: -50_000, y: MAIN_SIZE.h, w: 100_000, h: 10_000 }];
    const w = placeWorker(crowd, main);
    expect(overlaps(w, main)).toBe(false);
    expect(overlaps(w, crowd[1])).toBe(false);
  });

  it("keeps a team of three at a size where chats can be read", () => {
    const boxes: Box[] = [main];
    fill(boxes, 3);
    expect(fitView(boxes, { w: 1426, h: 845 }).zoom).toBeGreaterThanOrEqual(SUMMARY_ZOOM);
  });
});

describe("placing a card that checks a builder's work", () => {
  const main = firstBox();
  const lead = main;
  const builder = placeWorker([main], main);

  it("goes beside the builder, level with it, when that is free", () => {
    const r = placeCheck([main, builder], builder, lead);
    expect(r).toEqual({ x: builder.x + builder.w + GAP, y: builder.y, ...WORKER_SIZE });
  });

  it("goes right below the builder when its side is taken", () => {
    const side: Box = { x: builder.x + builder.w + GAP, y: builder.y, ...WORKER_SIZE };
    const r = placeCheck([main, builder, side], builder, lead);
    expect(r).toEqual({ x: builder.x, y: builder.y + builder.h + GAP, ...WORKER_SIZE });
  });

  it("stays near the builder, not at the end of the row, even with other agents about", () => {
    const boxes: Box[] = [main];
    for (let i = 0; i < 5; i++) boxes.push(placeWorker(boxes, main));
    const b = boxes[4];
    const r = placeCheck(boxes, b, lead);
    boxes.forEach((e) => expect(overlaps(r, e, GAP / 2)).toBe(false));
    expect(Math.hypot(r.x - b.x, r.y - b.y)).toBeLessThanOrEqual(2.5 * (WORKER_SIZE.w + GAP));
  });

  it("two cards checking the same builder never overlap", () => {
    const boxes: Box[] = [main, builder];
    const a = placeCheck(boxes, builder, lead);
    boxes.push(a);
    const q = placeCheck(boxes, builder, lead);
    expect(overlaps(a, q)).toBe(false);
    expect(overlaps(q, builder)).toBe(false);
  });

  it("falls back to the Lead's free space when the builder is boxed in", () => {
    const ring: Box[] = [];
    for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 4; dy++) if (dx !== 0 || dy !== 0) ring.push({ x: builder.x + dx * 500, y: builder.y + dy * 580, w: 480, h: 560 });
    const r = placeCheck([main, builder, ...ring], builder, lead);
    expect(overlaps(r, builder)).toBe(false);
    ring.forEach((e) => expect(overlaps(r, e, GAP / 2)).toBe(false));
  });

  it("works when the builder's Lead is gone", () => {
    expect(placeCheck([builder], builder, undefined)).toEqual({ x: builder.x + builder.w + GAP, y: builder.y, ...WORKER_SIZE });
  });
});

describe("whether a card is in view", () => {
  const viewport = { w: 1000, h: 700 };
  const view: View = { x: 0, y: 0, zoom: 1 };

  it("is true for a card on screen, false for one off an edge, and false for one only peeking in", () => {
    expect(inView(view, viewport, { x: 100, y: 100, w: 400, h: 500 })).toBe(true);
    expect(inView(view, viewport, { x: 1200, y: 100, w: 400, h: 500 })).toBe(false);
    expect(inView(view, viewport, { x: 100, y: 900, w: 400, h: 500 })).toBe(false);
    expect(inView(view, viewport, { x: 960, y: 100, w: 400, h: 500 })).toBe(false);
    expect(inView(view, viewport, { x: 900, y: 100, w: 400, h: 500 })).toBe(true);
  });

  it("follows the pan and the zoom", () => {
    const box: Box = { x: 1200, y: 100, w: 400, h: 500 };
    expect(inView({ x: -900, y: 0, zoom: 1 }, viewport, box)).toBe(true);
    expect(inView({ x: 0, y: 0, zoom: 0.5 }, viewport, box)).toBe(true);
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
