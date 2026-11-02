/** Marking what a chat search looks for inside the messages that say it. */

/** A query shorter than this marks nothing (the same rule as `findRows`: the stepper has no matches either). */
const MIN_QUERY = 2;

/** A piece of a text, and whether it is what was looked for. */
export interface Piece {
  text: string;
  hit: boolean;
}

/**
 * The text with each character in lower case only where that doesn't change its length, so a place found in it is a place in
 * the original (`"İ".toLowerCase()` is two characters, and every index after it would slip).
 */
function fold(text: string): string {
  let out = "";
  for (const ch of text) {
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

/** Where `query` (any case, trimmed) is in `text`, as [start, end) pairs, in order, not overlapping. None for a short query. */
export function markRanges(text: string, query: string): [number, number][] {
  const q = fold(query.trim());
  if (q.length < MIN_QUERY || !text) return [];
  const where = fold(text);
  const out: [number, number][] = [];
  for (let at = where.indexOf(q); at >= 0; at = where.indexOf(q, at + q.length)) out.push([at, at + q.length]);
  return out;
}

/** The text cut into pieces, each wholly a match or wholly not; one piece, untouched, when there is nothing to mark. */
export function splitMarked(text: string, query: string | undefined): Piece[] {
  const ranges = query ? markRanges(text, query) : [];
  if (ranges.length === 0) return [{ text, hit: false }];
  const out: Piece[] = [];
  let from = 0;
  for (const [start, end] of ranges) {
    if (start > from) out.push({ text: text.slice(from, start), hit: false });
    out.push({ text: text.slice(start, end), hit: true });
    from = end;
  }
  if (from < text.length) out.push({ text: text.slice(from), hit: false });
  return out;
}

/**
 * A line of tokens (code, each with its kind) cut where a match starts and ends, so a match across tokens is marked as one and
 * each piece keeps its token's kind. A line with no match comes back as it was.
 */
export function markTokens<T extends { text: string }>(tokens: T[], query: string | undefined): (T & { hit: boolean })[] {
  const ranges = query ? markRanges(tokens.map((t) => t.text).join(""), query) : [];
  if (ranges.length === 0) return tokens.map((t) => ({ ...t, hit: false }));
  const out: (T & { hit: boolean })[] = [];
  let at = 0;
  for (const token of tokens) {
    const end = at + token.text.length;
    let from = at;
    for (const [s, e] of ranges) {
      if (e <= from || s >= end) continue;
      const a = Math.max(s, from);
      const b = Math.min(e, end);
      if (a > from) out.push({ ...token, text: token.text.slice(from - at, a - at), hit: false });
      out.push({ ...token, text: token.text.slice(a - at, b - at), hit: true });
      from = b;
    }
    if (from < end) out.push({ ...token, text: token.text.slice(from - at), hit: false });
    at = end;
  }
  return out;
}

/** Whether `query` is in `text` at all. */
export const hasMark = (text: string, query: string | undefined): boolean => !!query && markRanges(text, query).length > 0;
