/**
 * Typing a list: Return after "1. one" starts "2. ", after "- one" starts "- ", and Return on an empty item ends the list,
 * as in a notes app. Only a single newline typed at the end of a list line is taken for it: pasting, deleting and typing
 * anywhere else are left exactly as they are.
 */
export interface ListEdit {
  text: string;
  /** Where the caret goes: after the new marker. */
  caret: number;
}

const ITEM = /^(\s*)(?:(\d{1,4})([.)])|([-*•]))[ \t]+(.*)$/;

/** What `next` becomes when the one thing typed since `prev` was a Return after a list item; null when it was not. */
export function continueList(prev: string, next: string): ListEdit | null {
  if (next.length !== prev.length + 1) return null;
  let i = 0;
  while (i < prev.length && prev[i] === next[i]) i++;
  // One newline put in at i, and nothing else changed.
  if (next[i] !== "\n" || next.slice(i + 1) !== prev.slice(i)) return null;
  const start = next.lastIndexOf("\n", i - 1) + 1;
  const m = ITEM.exec(next.slice(start, i));
  if (!m) return null;
  const [, indent, number, sep, bullet, content] = m;
  if (content.trim() === "") {
    // Return on an empty item: the marker goes, the list is over.
    return { text: `${next.slice(0, start)}\n${next.slice(i + 1)}`, caret: start + 1 };
  }
  const marker = number ? `${indent}${Number(number) + 1}${sep} ` : `${indent}${bullet} `;
  return { text: `${next.slice(0, i + 1)}${marker}${next.slice(i + 1)}`, caret: i + 1 + marker.length };
}
