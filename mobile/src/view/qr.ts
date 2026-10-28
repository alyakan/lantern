/** Drawing a QR code from its squares (the Mac sends them as rows of "1" and "0"). Pure, so the layout is tested without a screen. */

/** A run of dark squares along one row: `x` squares in, `length` long. */
export interface Run {
  row: number;
  x: number;
  length: number;
}

/** The dark squares as the fewest pieces: each row's neighbouring squares joined, so a code is a few hundred views, not a couple of thousand. */
export function runs(rows: string[]): Run[] {
  const out: Run[] = [];
  rows.forEach((line, row) => {
    let start = -1;
    for (let x = 0; x <= line.length; x++) {
      const dark = x < line.length && line[x] === "1";
      if (dark && start < 0) start = x;
      if (!dark && start >= 0) {
        out.push({ row, x: start, length: x - start });
        start = -1;
      }
    }
  });
  return out;
}

/** Whether `rows` is a QR code's squares: square, nothing but "1" and "0", and big enough (the smallest QR code is 21 across). */
export function isGrid(rows: string[]): boolean {
  return rows.length >= 21 && rows.length <= 177 && rows.every((r) => r.length === rows.length && /^[01]+$/.test(r));
}

/** How many points one square is when the code (with its margin of 4 squares on every side, which a scanner needs) is to fit `size`. */
export function squareSize(size: number, across: number): number {
  return Math.max(1, Math.floor(size / (across + 8)));
}

/** Minutes and seconds left, as "4:32", never below 0:00. */
export function countdown(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
