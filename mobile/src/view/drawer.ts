/** The rules of dragging the chats' column in and out. Pure, so they are tested without a finger. */

/** How wide the strip at the screen's left edge is, where a drag to the right opens the column. It stops short of the header's button, which starts 16 pt in. */
export const EDGE_WIDTH = 16;

/** How far a drag must go sideways before it is a drag and not a tap or a scroll, and how much more sideways than up and down. */
const SLOP = 10;
const SIDEWAYS = 2;

/** Whether a finger that has moved (dx, dy) from where it touched is going sideways, not scrolling. */
export function isSideways(dx: number, dy: number): boolean {
  return Math.abs(dx) > SLOP && Math.abs(dx) > SIDEWAYS * Math.abs(dy);
}

/** How far in the column is (0 away, 1 in place) while a finger that began with it at `from` has moved `dx`. */
export function dragProgress(from: 0 | 1, dx: number, width: number): number {
  return Math.min(1, Math.max(0, from + dx / width));
}

/** A flick faster than this (points per millisecond) decides by its direction, wherever it is. */
const FLICK = 0.4;

/** Where the column goes when the finger lifts: in (true) or away (false), from how far in it is and how fast the finger was going (positive: to the right). */
export function settlesOpen(progress: number, velocity: number): boolean {
  if (Math.abs(velocity) > FLICK) return velocity > 0;
  return progress > 0.5;
}

/** How fast a finger is going (points per millisecond) between two moves; 0 when there is no time between them. */
export function velocityOf(fromX: number, fromAt: number, toX: number, toAt: number): number {
  return toAt > fromAt ? (toX - fromX) / (toAt - fromAt) : 0;
}
