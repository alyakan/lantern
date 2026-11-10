import { parseUnifiedDiff, type DiffRow } from "./fileDiff";

/**
 * The lines a Review finding names, out of the file's diff (the Mac's `excerpt`, src/lib/lineDiff.ts, for the phone's rows).
 * The Mac has both versions of the file whole; the phone has what `review_diff` sends, a unified diff with three lines of
 * context around each change. A finding on a line further from a change than that has no lines here.
 */

/**
 * The rows around new-file lines `from`–`to`, with `context` lines either side, and the removed lines among them. At most
 * `max` rows, cut from the far end. Empty when the diff doesn't have those lines.
 */
export function excerpt(rows: DiffRow[], from: number, to: number, context = 3, max = 40): DiffRow[] {
  const lo = from - context;
  const hi = to + context;
  // Only a row of the new file counts: a removed line has no number there, and a gap or a note isn't a line.
  const inNew = (r: DiffRow) => (r.kind === "ctx" || r.kind === "add") && r.newNo !== null;
  const first = rows.findIndex((r) => inNew(r) && (r.newNo as number) >= lo && (r.newNo as number) <= hi);
  if (first < 0) return [];
  let last = first;
  for (let i = first; i < rows.length; i++) {
    const r = rows[i];
    if (inNew(r) && (r.newNo as number) > hi) break;
    if (inNew(r) && (r.newNo as number) >= lo) last = i;
  }
  // The removed lines just before the first line shown belong with it (they were replaced by it).
  let begin = first;
  while (begin > 0 && rows[begin - 1].kind === "del" && rows[first].kind === "add") begin--;
  return rows.slice(begin, last + 1).slice(0, max);
}

/** A finding's lines from a file's unified diff. */
export const excerptOf = (diff: string, from: number, to: number) => excerpt(parseUnifiedDiff(diff), from, to);
