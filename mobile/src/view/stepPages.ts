/**
 * Step by step on the phone, as the Mac shows it: a page per step, side by side, one on screen. A page starts at Claude's
 * heading and holds what came after it (your questions about the step and the answers) up to the next heading. What came
 * before the first heading is a Start page.
 */

import type { Row } from "./timeline";

export interface StepPage {
  /** The key of the row it starts at: the same as the page grows. */
  key: string;
  /** "Step 2 of 4", "Frame", "Start". */
  kicker: string;
  title: string;
  rows: Row[];
}

export function stepPagesOf(rows: Row[]): StepPage[] {
  const pages: StepPage[] = [];
  for (const row of rows) {
    const last = pages[pages.length - 1];
    if (row.kind === "page") {
      // A step written again after a question about it (the same heading as the page on screen) is that page, revised.
      if (last && last.kicker === row.page.kicker) {
        last.title = row.page.title;
        last.rows.push(row);
      } else pages.push({ key: row.key, kicker: row.page.kicker, title: row.page.title, rows: [row] });
    } else if (last) last.rows.push(row);
    else pages.push({ key: "start", kicker: "Start", title: "Before the first page", rows: [row] });
  }
  return pages;
}

/** Which page a row is on (-1: none). */
export const pageOfKey = (pages: StepPage[], key: string) => pages.findIndex((p) => p.rows.some((r) => r.key === key));
