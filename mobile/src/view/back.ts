/** The rules of dragging a screen away to go back. Pure, so they are tested without a finger. */

/** How wide the strip at the screen's left edge is, where a drag to the right takes the top screen with it. */
export const BACK_EDGE_WIDTH = 20;

/** A flick to the right faster than this (points per millisecond) goes back wherever it is; a flick to the left stays. */
const FLICK = 0.4;
/** Without a flick, past this much of the screen's width it goes back. */
const FAR = 0.4;

/** How far the screen has been pulled, 0 where it was to 1 right off the screen. */
export function pulled(dx: number, width: number): number {
  return width > 0 ? Math.min(1, Math.max(0, dx / width)) : 0;
}

/** Whether the screen goes back when the finger lifts: from how far it was pulled and how fast the finger was going (positive: to the right). */
export function goesBack(progress: number, velocity: number): boolean {
  if (Math.abs(velocity) > FLICK) return velocity > 0;
  return progress > FAR;
}
