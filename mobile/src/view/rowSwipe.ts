/**
 * Swiping a chat's row: right pins or unpins it, left lays out its buttons. How far and how fast is decided here, apart from
 * the row, so it is tested: a tap, a short drag and a drag that is mostly down are never a swipe.
 */

/** How far right the row must be dragged to pin it when it is let go (the haptic tap comes as it crosses this). */
export const PIN_AT = 84;

/** How wide one button of the tray is. */
export const BUTTON = 76;

/** How far a drag must go before it is a swipe at all, and how much more sideways than up or down it must be. */
export const START_AT = 10;
export const SIDEWAYS = 1.6;

/** Whether a drag of (`dx`, `dy`) has begun to be a sideways swipe (and so is the row's, not the list's scrolling). */
export function swiping(dx: number, dy: number): boolean {
  return Math.abs(dx) > START_AT && Math.abs(dx) > Math.abs(dy) * SIDEWAYS;
}

/** How far from the screen's left edge a swipe right must start to be the row's (nearer, it is the system's). */
export const EDGE = 20;

/**
 * Whether a drag right began away from the screen's left edge: where it began is where the finger is now (`moveX`) less how far
 * it has come (`dx`). (A PanResponder's `x0` can't be used: it is only set once a gesture is granted, so before the first one it
 * is 0, which reads as the edge.)
 */
export const startsAwayFromEdge = (moveX: number, dx: number) => moveX - dx >= EDGE;

/** The tray's width for `buttons` of them. */
export const trayWidth = (buttons: number) => buttons * BUTTON;

/**
 * Where the row is while a finger has it: `dx` from where it began (`from`: 0 closed, or minus the tray's width when it
 * started open). The row never goes further left than the tray, and to the right it drags harder the further it is pulled.
 */
export function follow(from: number, dx: number, tray: number, canPin: boolean): number {
  const x = from + dx;
  if (x < -tray) return -tray - Math.sqrt(-tray - x) * 2;
  if (x > 0) return canPin ? Math.min(x, PIN_AT + (x - PIN_AT > 0 ? Math.sqrt(x - PIN_AT) * 3 : 0)) : 0;
  return x;
}

export type Settle = "pin" | "open" | "closed";

/**
 * What happens when the finger lifts at `x` (the row's place, see `follow`) going `vx` (points per millisecond, left is
 * negative): a pull past `PIN_AT` pins; a pull left past a third of the tray, or a quick flick left, opens it; anything else
 * closes it. A tray that has no buttons never opens.
 */
export function settle(x: number, vx: number, tray: number, canPin: boolean): Settle {
  if (canPin && x >= PIN_AT) return "pin";
  if (tray > 0 && (x <= -tray / 3 || vx < -0.6) && vx < 0.6) return "open";
  return "closed";
}
