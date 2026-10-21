/**
 * Allowing a command takes a swipe, so a stray tap in a pocket can't run something on the Mac. How far the knob has to
 * go is decided here, apart from the screen, so it is tested: a press, a short drag and a drag back are never "allow".
 */

/** How far along the track the knob must be when it is let go. */
export const ALLOW_AT = 0.85;

/** How far along, from 0 to 1, a drag of `dx` pixels is on a track `max` pixels long. */
export function progress(dx: number, max: number): number {
  if (!(max > 0) || !Number.isFinite(dx)) return 0;
  return Math.min(1, Math.max(0, dx / max));
}

/** Whether letting go at `dx` allows. */
export const allows = (dx: number, max: number) => progress(dx, max) >= ALLOW_AT;
