/**
 * Long text, as the Claude app treats it: a paste that big is not left in the message box (where it would fill the screen) but
 * held as a card above it, and a message that long is a short card in the chat that opens to all of it.
 */

/** A paste or a message this long (in characters) is a card. */
export const LONG_CHARS = 500;
/** ...or this many lines. */
export const LONG_LINES = 10;

export const linesOf = (text: string) => text.trimEnd().split("\n").length;

/** Whether `text` is long enough to be held apart: a paste, or a message in the chat. */
export const isLong = (text: string) => text.length >= LONG_CHARS || linesOf(text) >= LONG_LINES;

/**
 * What a change to the box inserted, when it is long: the box's words are `prev`, and now `next`. The inserted stretch is what is
 * between the words they still share at the start and at the end (a paste in the middle of a line leaves both sides in place).
 * Null for typing, a short paste, or a change that took words away.
 */
export function pastedPart(prev: string, next: string): { pasted: string; rest: string } | null {
  if (next.length <= prev.length) return null;
  let start = 0;
  const most = Math.min(prev.length, next.length);
  while (start < most && prev[start] === next[start]) start++;
  let end = 0;
  while (end < prev.length - start && prev[prev.length - 1 - end] === next[next.length - 1 - end]) end++;
  const pasted = next.slice(start, next.length - end);
  if (!isLong(pasted)) return null;
  return { pasted, rest: next.slice(0, start) + next.slice(next.length - end) };
}

/** The first few lines of `text`, for a card's preview. */
export const previewOf = (text: string, lines = 3) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, lines)
    .join("\n");
