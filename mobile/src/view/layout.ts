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

/** The Changes pane's width. */
export const CHANGES_WIDTH = 380;

/** The narrowest window that has the chat and the changed files side by side (the chat reads best at 500 and over). */
export const CHANGES_MIN = 880;

/**
 * Whether the changed files sit beside the chat, given where the chats are (`layout` is how the chats are placed: "split" is
 * beside the chat, "overlay" is away until asked for): the pane takes the room the chats would have, so with them beside the
 * chat the changes are a sheet over it instead.
 */
export const hasRoomForChanges = (layout: Layout, width: number) => layout === "overlay" && width >= CHANGES_MIN;
