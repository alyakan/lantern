/**
 * The canvas's geometry: where agents sit in the world, how the view maps the world onto the screen, and the tethers
 * between agents. Pure, so it can be tested without a DOM.
 *
 * World coordinates are what boxes are placed in; the screen shows them through a `View`: a world point (wx, wy) is at
 * (wx * zoom + x, wy * zoom + y) in the canvas element.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Box extends Point, Size {}

export interface View extends Point {
  zoom: number;
}

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 1.6;
/** Fitting never zooms out past this by itself: a team too big for the window is shown at this size, and the user pans. */
export const READABLE_ZOOM = 0.8;
/** Below this zoom a chat is too small to read, so agents show as summary cards instead. */
export const SUMMARY_ZOOM = 0.5;
/** A pinch that hovers around SUMMARY_ZOOM mustn't swap cards and chats back and forth: cards start below this, chats return above SUMMARY_EXIT. */
export const SUMMARY_ENTER = 0.48;
export const SUMMARY_EXIT = 0.52;
/** Whether the agents are cards at `zoom`, given whether they were (the two thresholds make a band where it stays as it is). */
export const inSummary = (was: boolean, zoom: number) => (was ? zoom < SUMMARY_EXIT : zoom < SUMMARY_ENTER);
export const MAIN_SIZE: Size = { w: 520, h: 660 };
export const WORKER_SIZE: Size = { w: 420, h: 520 };
/** The smallest an agent can be resized to. */
export const MIN_NODE: Size = { w: 300, h: 240 };
/** Space left between agents when they're placed. */
export const GAP = 56;

export const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

export const toWorld = (view: View, p: Point): Point => ({ x: (p.x - view.x) / view.zoom, y: (p.y - view.y) / view.zoom });
export const toScreen = (view: View, p: Point): Point => ({ x: p.x * view.zoom + view.x, y: p.y * view.zoom + view.y });

/** Zooms by `factor` around `at` (a point in the canvas element): the world point under it stays under it. */
export function zoomAt(view: View, factor: number, at: Point): View {
  const zoom = clampZoom(view.zoom * factor);
  if (zoom === view.zoom) return view;
  const world = toWorld(view, at);
  return { zoom, x: at.x - world.x * zoom, y: at.y - world.y * zoom };
}

export const panBy = (view: View, dx: number, dy: number): View => ({ ...view, x: view.x + dx, y: view.y + dy });

export function bounds(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  const x1 = Math.min(...boxes.map((b) => b.x));
  const y1 = Math.min(...boxes.map((b) => b.y));
  const x2 = Math.max(...boxes.map((b) => b.x + b.w));
  const y2 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * A view that shows all of `boxes` in `viewport`, centred, never zoomed in past 1 (a lone agent isn't blown up) and never
 * out past READABLE_ZOOM. When everything wouldn't fit at that, it shows what does from the top left (the main agent
 * first) and the rest is a pan away.
 */
export function fitView(boxes: Box[], viewport: Size, padding = 56): View {
  const b = bounds(boxes);
  if (!b || viewport.w <= 0 || viewport.h <= 0) return { x: 0, y: 0, zoom: 1 };
  const zoom = clampZoom(Math.max(READABLE_ZOOM, Math.min(1, (viewport.w - 2 * padding) / b.w, (viewport.h - 2 * padding) / b.h)));
  // Along an axis where it fits it is centred; where it doesn't, it starts at the edge with a little room (less than the padding, which is for a view that shows everything).
  const edge = Math.min(padding, 24);
  const place = (room: number, size: number, at: number) => (size * zoom + 2 * padding > room ? edge - at * zoom : (room - size * zoom) / 2 - at * zoom);
  return { zoom, x: place(viewport.w, b.w, b.x), y: place(viewport.h, b.h, b.y) };
}

/** A view with `box` centred in `viewport` at `zoom` (to bring an agent that needs you into sight). */
export function centerOn(box: Box, viewport: Size, zoom: number): View {
  const z = clampZoom(zoom);
  return { zoom: z, x: viewport.w / 2 - (box.x + box.w / 2) * z, y: viewport.h / 2 - (box.y + box.h / 2) * z };
}

export function overlaps(a: Box, b: Box, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/** Where the first agent goes. */
export const firstBox = (): Box => ({ x: 0, y: 0, ...MAIN_SIZE });

/** How many cards sit side by side below the Lead before the next row starts: wide enough to fill a window, never far off to the right. */
export const PLACE_COLUMNS = 3;

const free = (box: Box, existing: Box[]) => !existing.some((e) => overlaps(box, e, GAP / 2));

/**
 * Where a new worker goes: in the free space below `lead`, filling a row of PLACE_COLUMNS from the left, then wrapping to the next
 * row down. The first card is right under the Lead; a spot another card sits on (one the user moved there) is skipped, so a card never
 * overlaps another and nothing that is already placed moves. Only called for a card that has no place yet.
 */
export function placeWorker(existing: Box[], lead: Box, size: Size = WORKER_SIZE): Box {
  const top = lead.y + lead.h + GAP;
  for (let row = 0; row < 60; row++) {
    for (let col = 0; col < PLACE_COLUMNS; col++) {
      const box: Box = { x: lead.x + col * (size.w + GAP), y: top + row * (size.h + GAP), ...size };
      if (free(box, existing)) return box;
    }
  }
  // Somewhere absurdly crowded: stack below everything.
  const b = bounds(existing) ?? lead;
  return { x: lead.x, y: b.y + b.h + GAP, ...size };
}

/**
 * Where a card that checks a builder's work goes: beside it (to its right), else right below it, else the nearest free spot around it
 * (a step left, diagonally, two steps off). With no room around the builder it is placed like any worker, below the Lead.
 */
export function placeCheck(existing: Box[], builder: Box, lead: Box | undefined, size: Size = WORKER_SIZE): Box {
  const stepX = size.w + GAP;
  const stepY = size.h + GAP;
  // The first step off the builder clears its own edge; the rest are whole cards. Listed in the order they are tried.
  const at = (dx: number, dy: number): Box => ({
    x: dx === 0 ? builder.x : dx > 0 ? builder.x + builder.w + GAP + (dx - 1) * stepX : builder.x - GAP - size.w + (dx + 1) * stepX,
    y: dy === 0 ? builder.y : dy > 0 ? builder.y + builder.h + GAP + (dy - 1) * stepY : builder.y - GAP - size.h + (dy + 1) * stepY,
    ...size,
  });
  const around: [number, number][] = [[1, 0], [0, 1], [1, 1], [-1, 0], [-1, 1], [0, -1], [1, -1], [2, 0], [-1, -1], [2, 1], [0, 2], [1, 2]];
  for (const [dx, dy] of around) {
    const box = at(dx, dy);
    if (free(box, existing)) return box;
  }
  return placeWorker(existing, lead ?? builder, size);
}

/** Whether at least `min` pixels of `box` (in each direction) are on screen in `viewport` through `view`: a card the user can see and grab. */
export function inView(view: View, viewport: Size, box: Box, min = 80): boolean {
  const a = toScreen(view, box);
  const w = Math.min(a.x + box.w * view.zoom, viewport.w) - Math.max(a.x, 0);
  const h = Math.min(a.y + box.h * view.zoom, viewport.h) - Math.max(a.y, 0);
  return w >= min && h >= min;
}

export interface Tether {
  from: Point;
  to: Point;
  /** An SVG path from one to the other, leaving and arriving along the axis the agents are apart on. */
  d: string;
}

/** The line between two agents, from where it leaves `a` to where it arrives at `b`. */
export function tether(a: Box, b: Box): Tether {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  // Side by side when there is daylight between them horizontally, else above and below.
  const horizontal = b.x >= a.x + a.w || a.x >= b.x + b.w || Math.abs(dx) * a.h >= Math.abs(dy) * a.w;
  let from: Point;
  let to: Point;
  if (horizontal) {
    const right = dx >= 0;
    from = { x: right ? a.x + a.w : a.x, y: clamp(bc.y, a.y + 24, a.y + a.h - 24) };
    to = { x: right ? b.x : b.x + b.w, y: clamp(ac.y, b.y + 24, b.y + b.h - 24) };
  } else {
    const below = dy >= 0;
    from = { x: clamp(bc.x, a.x + 24, a.x + a.w - 24), y: below ? a.y + a.h : a.y };
    to = { x: clamp(ac.x, b.x + 24, b.x + b.w - 24), y: below ? b.y : b.y + b.h };
  }
  const k = Math.max(48, (horizontal ? Math.abs(to.x - from.x) : Math.abs(to.y - from.y)) / 2);
  const sign = horizontal ? Math.sign(to.x - from.x) || 1 : Math.sign(to.y - from.y) || 1;
  const d = horizontal
    ? `M ${from.x} ${from.y} C ${from.x + sign * k} ${from.y}, ${to.x - sign * k} ${to.y}, ${to.x} ${to.y}`
    : `M ${from.x} ${from.y} C ${from.x} ${from.y + sign * k}, ${to.x} ${to.y - sign * k}, ${to.x} ${to.y}`;
  return { from, to, d };
}

function clamp(n: number, min: number, max: number): number {
  return max < min ? (min + max) / 2 : Math.min(max, Math.max(min, n));
}

/** `box` moved by (dx, dy) screen pixels at `zoom`. */
export const moveBox = (box: Box, dx: number, dy: number, zoom: number): Box => ({ ...box, x: box.x + dx / zoom, y: box.y + dy / zoom });

/** `box` resized from its bottom-right corner by (dx, dy) screen pixels at `zoom`, no smaller than MIN_NODE. */
export const resizeBox = (box: Box, dx: number, dy: number, zoom: number): Box => ({
  ...box,
  w: Math.max(MIN_NODE.w, box.w + dx / zoom),
  h: Math.max(MIN_NODE.h, box.h + dy / zoom),
});
