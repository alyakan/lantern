/** How the app is laid out for the window it has. Pure, so the breakpoints are tested without a screen. */

/** "phone": one screen at a time. "overlay": a tablet held upright, the chat full width with the chats sliding in over it. "split": the chats beside the chat. */
export type Layout = "phone" | "overlay" | "split";

/** The narrowest window that has room for more than one screen. An iPad's Split View pane or Slide Over is narrower, so it gets the phone's layout. */
export const WIDE_MIN = 700;

/** The chats' column, beside the chat or sliding over it. */
export const SIDEBAR_WIDTH = 340;

/** The widest a chat reads: its header, messages and message box line up in one column. */
export const COLUMN_MAX = 860;

/** The widest a bottom sheet goes, so one does not stretch across a tablet. */
export const SHEET_MAX = 640;

/** The narrowest window that has the chats beside the chat and still leaves the chat room to read. */
export const SPLIT_MIN = 900;

export function layoutFor(width: number, height: number): Layout {
  if (width < WIDE_MIN) return "phone";
  return width > height && width >= SPLIT_MIN ? "split" : "overlay";
}

/** How far past `WIDE_MIN` a window resized by hand must go before the app changes between a phone's and a tablet's. */
export const WIDE_SLACK = 24;

/**
 * The layout for a window that had `before`: as `layoutFor`, except that between a phone's and a tablet's it changes only once
 * the window is `WIDE_SLACK` past the line. The two are different screens, built again from nothing (the chat's place, the open
 * pane, the folded projects), and a Stage Manager window dragged to about 700 points wide flipped between them at every step.
 */
export function layoutAfter(before: Layout | null, width: number, height: number): Layout {
  const now = layoutFor(width, height);
  if (before === null) return now;
  if (before === "phone" && now !== "phone" && width < WIDE_MIN + WIDE_SLACK) return "phone";
  if (before !== "phone" && now === "phone" && width >= WIDE_MIN - WIDE_SLACK) return layoutFor(WIDE_MIN, height);
  return now;
}

/**
 * The margin a page keeps from the window's sides: Apple lays a compact width out with 16 points and a wider one with 20.
 * Cards sit at their own 16 either way, so on a wide screen the list's text lines up inside them.
 */
export function gutterFor(layout: Layout): number {
  return layout === "phone" ? 16 : 20;
}

/** The narrowest the Changes pane gets beside the chat. */
export const CHANGES_WIDTH = 320;

/** The narrowest the chat gets beside the Changes pane: it reads best at 500 and over. */
export const CHAT_MIN = 500;

/** The share of the width the Changes pane takes beside the chat until it is dragged to another: half. */
export const CHANGES_SHARE = 0.5;

/** The narrowest window that has the chat and the changed files side by side (the chat reads best at 500 and over). */
export const CHANGES_MIN = 880;

/**
 * Whether the changed files sit beside the chat, given where the chats are (`layout` is how the chats are placed: "split" is
 * beside the chat, "overlay" is away until asked for): the pane takes the room the chats would have, so with them beside the
 * chat the changes are a sheet over it instead.
 */
export const hasRoomForChanges = (layout: Layout, width: number) => layout === "overlay" && width >= CHANGES_MIN;

/**
 * How wide the Changes pane is beside the chat: its share of the width (dragged to, or half), but never narrower than it reads
 * (`CHANGES_WIDTH`) nor so wide that the chat is narrower than `CHAT_MIN`. A share rather than points, so a turned tablet keeps
 * the same split.
 */
export function changesWidth(share: number, width: number): number {
  const most = Math.max(CHANGES_WIDTH, width - CHAT_MIN);
  return Math.round(Math.min(most, Math.max(CHANGES_WIDTH, share * width)));
}

/** The share a pane `pane` points wide takes of `width`, kept between what `changesWidth` allows. */
export function shareOf(pane: number, width: number): number {
  return width > 0 ? changesWidth(pane / width, width) / width : CHANGES_SHARE;
}

/** Where the Changes go when floated over the chat: a big card in the middle, the chat dimmed around it. */
export function floatFrame(width: number, height: number, top = 0, bottom = 0) {
  const w = Math.round(Math.min(width * 0.8, 1100));
  const room = height - top - bottom;
  const h = Math.round(room * 0.86);
  return { x: Math.round((width - w) / 2), y: Math.round(top + (room - h) / 2), w, h };
}
