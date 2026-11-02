/** Drawing on a photo before it is sent: strokes as lists of points, and the little straight pieces a screen draws them with. */

export interface Point {
  x: number;
  y: number;
}

export type Stroke = Point[];

/** How many strokes a photo can have, how many points one has, and how far apart two points have to be to count. */
export const MAX_STROKES = 20;
export const MAX_POINTS = 200;
export const MIN_STEP = 4;

/** The width of the pen, in points. */
export const PEN = 5;

/** `strokes` with a stroke begun at `p` (not past the limit). */
export function begin(strokes: Stroke[], p: Point): Stroke[] {
  return strokes.length >= MAX_STROKES ? strokes : [...strokes, [p]];
}

/** The last stroke with `p` added, unless it is too near the last point or the stroke is full. */
export function extend(strokes: Stroke[], p: Point): Stroke[] {
  if (strokes.length === 0) return strokes;
  const last = strokes[strokes.length - 1];
  const prev = last[last.length - 1];
  if (last.length >= MAX_POINTS || Math.hypot(p.x - prev.x, p.y - prev.y) < MIN_STEP) return strokes;
  return [...strokes.slice(0, -1), [...last, p]];
}

/** The strokes without the last one. */
export const undo = (strokes: Stroke[]): Stroke[] => strokes.slice(0, -1);

export interface Piece {
  /** Where the piece's middle is. */
  cx: number;
  cy: number;
  length: number;
  /** In degrees, clockwise from pointing right. */
  angle: number;
}

/** A stroke as straight pieces between its points (a single point is a dot: a piece of no length), each drawn as a thin turned rectangle. */
export function pieces(stroke: Stroke): Piece[] {
  if (stroke.length === 1) return [{ cx: stroke[0].x, cy: stroke[0].y, length: 0, angle: 0 }];
  return stroke.slice(1).map((b, i) => {
    const a = stroke[i];
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, length: Math.hypot(b.x - a.x, b.y - a.y), angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI };
  });
}

/** The largest size a photo of `width` by `height` fits at inside `maxW` by `maxH`, both sides kept in proportion (never larger than it is: that would blur). */
export function fitInside(width: number, height: number, maxW: number, maxH: number): { width: number; height: number } {
  if (width <= 0 || height <= 0 || maxW <= 0 || maxH <= 0) return { width: 0, height: 0 };
  const scale = Math.min(maxW / width, maxH / height, 1);
  return { width: Math.floor(width * scale), height: Math.floor(height * scale) };
}
