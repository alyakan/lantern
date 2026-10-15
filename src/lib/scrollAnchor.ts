/**
 * Where a chat was read to, as a place in it rather than a number of pixels: the turn at the top of the view, which of
 * its rows, and how far down that row (a fraction of its height). The same chat shows at other widths (its card on the
 * canvas, the chat itself, a resized pane), where the same pixels are somewhere else; this is the same place in each.
 */
export interface ChatAnchor {
  /** The turn's id (its section's data-turn). */
  turn: string;
  /** Which of the turn's rows, counted among its children; -1: the turn's top, above its first row. */
  row: number;
  /** How far down the row the view's top is, as a fraction of its height; for the turn's top, pixels. */
  within: number;
}

const turnsOf = (scroller: HTMLElement) => Array.from(scroller.children).filter((el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.turn);

/** A turn's prompt stays pinned at the top while its reply scrolls, so where it sits says nothing about the place. */
const rowsOf = (turn: HTMLElement) => Array.from(turn.children).filter((el): el is HTMLElement => el instanceof HTMLElement && !el.classList.contains("turn-head"));

/** The place at the top of `scroller`'s view, or null when it shows no turn. */
export function anchorOf(scroller: HTMLElement): ChatAnchor | null {
  const top = scroller.getBoundingClientRect().top;
  const turn = turnsOf(scroller).find((t) => t.getBoundingClientRect().bottom > top);
  if (!turn?.dataset.turn) return null;
  const rows = rowsOf(turn);
  const row = rows.find((r) => r.getBoundingClientRect().bottom > top);
  const rect = row?.getBoundingClientRect();
  if (!row || !rect || rect.top > top || rect.height === 0) return { turn: turn.dataset.turn, row: -1, within: Math.max(0, top - turn.getBoundingClientRect().top) };
  return { turn: turn.dataset.turn, row: Array.from(turn.children).indexOf(row), within: (top - rect.top) / rect.height };
}

/** Scrolls `scroller` so `anchor` is at the top of its view again. False when the turn isn't there (nothing moves). */
export function scrollToAnchor(scroller: HTMLElement, anchor: ChatAnchor): boolean {
  const turn = turnsOf(scroller).find((t) => t.dataset.turn === anchor.turn);
  if (!turn) return false;
  const top = scroller.getBoundingClientRect().top;
  const row = anchor.row >= 0 ? turn.children[anchor.row] : undefined;
  const target = row instanceof HTMLElement ? row.getBoundingClientRect().top + anchor.within * row.getBoundingClientRect().height : turn.getBoundingClientRect().top + anchor.within;
  scroller.scrollTop += target - top;
  return true;
}
