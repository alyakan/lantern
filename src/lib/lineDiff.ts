import { linesOf } from "./diffComments";

/** A row of a diff: a line both versions have, one added (new file's number), or one removed (old file's number). */
export type DiffRow = { kind: "ctx"; oldNo: number; newNo: number; text: string } | { kind: "add"; newNo: number; text: string } | { kind: "del"; oldNo: number; text: string };

/** Past this many differing lines the diff isn't worked out: the rows read as unchanged rather than take long. */
const MAX_EDITS = 1000;

/**
 * Every line of two versions of a file as diff rows, in order: removed lines come before the lines added in their place.
 * Myers' algorithm on what is left once the lines the two share at both ends are set aside. Null when the versions are
 * too far apart to work out quickly.
 */
export function diffRows(original: string, current: string): DiffRow[] | null {
  const a = original === "" ? [] : linesOf(original);
  const b = current === "" ? [] : linesOf(current);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const middle = editScript(a.slice(start, endA), b.slice(start, endB));
  if (!middle) return null;
  const rows: DiffRow[] = [];
  for (let i = 0; i < start; i++) rows.push({ kind: "ctx", oldNo: i + 1, newNo: i + 1, text: a[i] });
  let i = start;
  let j = start;
  // Removed lines go first wherever removals and additions meet, as a unified diff shows them.
  let dels: DiffRow[] = [];
  let adds: DiffRow[] = [];
  const flush = () => {
    rows.push(...dels, ...adds);
    dels = [];
    adds = [];
  };
  for (const op of middle) {
    if (op === "=") {
      flush();
      rows.push({ kind: "ctx", oldNo: i + 1, newNo: j + 1, text: a[i] });
      i++;
      j++;
    } else if (op === "-") {
      dels.push({ kind: "del", oldNo: i + 1, text: a[i] });
      i++;
    } else {
      adds.push({ kind: "add", newNo: j + 1, text: b[j] });
      j++;
    }
  }
  flush();
  for (let k = 0; endA + k < a.length; k++) rows.push({ kind: "ctx", oldNo: endA + k + 1, newNo: endB + k + 1, text: a[endA + k] });
  return rows;
}

/** Myers' shortest edit script from `a` to `b`: "=" keep, "-" remove from a, "+" add from b. Null past MAX_EDITS. */
function editScript(a: string[], b: string[]): ("=" | "-" | "+")[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0) return Array(m).fill("+");
  if (m === 0) return Array(n).fill("-");
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, d, n, m, offset);
    }
    v = next;
  }
  return null;
}

function backtrack(trace: Int32Array[], d: number, n: number, m: number, offset: number): ("=" | "-" | "+")[] {
  const ops: ("=" | "-" | "+")[] = [];
  let x = n;
  let y = m;
  for (let step = d; step > 0; step--) {
    const v = trace[step];
    const k = x - y;
    const prevK = k === -step || (k !== step && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("=");
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push("+");
      y--;
    } else {
      ops.push("-");
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push("=");
    x--;
    y--;
  }
  return ops.reverse();
}

/**
 * The rows around new-file lines `from`–`to`, with `context` lines either side, and the removed lines among them. At most
 * `max` rows, cut from the far end. Empty when the lines aren't in the file.
 */
export function excerpt(rows: DiffRow[], from: number, to: number, context = 3, max = 40): DiffRow[] {
  const lo = from - context;
  const hi = to + context;
  const first = rows.findIndex((r) => r.kind !== "del" && r.newNo >= lo);
  if (first < 0) return [];
  let last = first;
  for (let i = first; i < rows.length; i++) {
    const r = rows[i];
    if (r.kind !== "del" && r.newNo > hi) break;
    last = i;
  }
  // The removed lines just before the first line shown belong with it (they were replaced by it).
  let begin = first;
  while (begin > 0 && rows[begin - 1].kind === "del" && rows[first].kind === "add") begin--;
  return rows.slice(begin, last + 1).slice(0, max);
}
