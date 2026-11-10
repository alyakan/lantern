import type { PageKind } from "./pages";
import { unitName, type ReviewFile, type ReviewFrame } from "./review";

/**
 * The route through a Review, as the Mac draws it in the head of the steps (ReviewRoute in src/components/ReviewDesk.tsx): the
 * Frame, every unit the Frame planned (those not reached yet greyed), and the Summary. The phone doesn't know a chat's flavour,
 * so a chat is a Review when one of its pages is a File page, or its Frame lists Units. (Risks alone don't say so: a Design
 * Frame may have a Risks section too, and it ends on a Summary page of its own.)
 */

/** A stop on a Review's route: the Frame, a unit, or the Summary, and the page it is (null: not on the phone). */
export interface RouteStop {
  key: string;
  kind: "frame" | "unit" | "summary";
  /** The unit's number. */
  n?: number;
  label: string;
  /** What the stop says in full (a unit's whole path). */
  title: string;
  /** The index of its page among the chat's pages; null while it isn't written. */
  page: number | null;
  /**
   * A unit before one the phone does have, that it doesn't: the chat's earlier pages load as it is scrolled back, so a unit
   * can have been reviewed and still be nowhere on the phone yet.
   */
  earlier?: boolean;
  /** A unit's findings, and how many still wait for your verdict; unknown until its page is written. */
  findings?: number;
  open?: number;
}

/** What the route needs of one of the chat's pages (its newest heading). */
export interface RoutePage {
  kind: PageKind;
  /** "File 3 of 20". */
  kicker: string;
  /** What the page says as a unit, for a File page. */
  file: ReviewFile | null;
  /** The findings with a verdict, sent or not yet sent. */
  decided: number;
}

/** "File 3 of 20" → 3 and 20. */
export function fileNumbers(kicker: string): { n: number; total: number } | null {
  const m = /^File (\d+) of (\d+)$/.exec(kicker);
  return m ? { n: Number(m[1]), total: Number(m[2]) } : null;
}

/**
 * The stops of a Review's route, or null when the chat isn't a Review. `pages[i]` is what the i-th page is (null: not a
 * Review heading, such as the page before the first); `frame` is the newest Frame's Units and Risks, when it has them.
 */
export function reviewRoute(pages: (RoutePage | null)[], frame: ReviewFrame | null): RouteStop[] | null {
  const lastOf = (match: (p: RoutePage) => boolean) => {
    for (let i = pages.length - 1; i >= 0; i--) {
      const p = pages[i];
      if (p && match(p)) return i;
    }
    return null;
  };
  const filePages = pages.flatMap((p) => (p?.kind === "file" ? [fileNumbers(p.kicker)] : [])).filter((f): f is { n: number; total: number } => f !== null);
  if ((!frame || frame.units.length === 0) && filePages.length === 0) return null;
  const unitPage = (n: number) => lastOf((p) => p.kind === "file" && fileNumbers(p.kicker)?.n === n);
  // Every unit there is word of: the Frame's, the pages' own "File N of M" (Claude may add a unit after the Frame), up to the last M.
  const total = Math.max(0, ...filePages.map((f) => Math.max(f.total, f.n)), ...(frame?.units.map((u) => u.n) ?? []));
  const newestLoaded = Math.max(0, ...filePages.map((f) => f.n));
  const framed = new Map((frame?.units ?? []).map((u) => [u.n, u.title]));
  const framePage = lastOf((p) => p.kind === "frame");
  const stops: RouteStop[] = [{ key: "frame", kind: "frame", label: "Frame", title: "The Frame: what the change is, its risks and the route", page: framePage }];
  for (let n = 1; n <= total; n++) {
    const at = unitPage(n);
    const page = at === null ? null : pages[at];
    const r = page?.file ?? null;
    const shown = r ? (r.group ?? r.path ?? "") : "";
    const title = framed.get(n) || shown || `Unit ${n}`;
    const named = !!(framed.get(n) || shown);
    stops.push({
      key: `unit-${n}`,
      kind: "unit",
      n,
      label: named ? unitName(title) : `Unit ${n}`,
      title,
      page: at,
      ...(at === null && n < newestLoaded ? { earlier: true } : {}),
      findings: r?.findings.length,
      open: r && page ? Math.max(0, r.findings.length - page.decided) : undefined,
    });
  }
  stops.push({ key: "summary", kind: "summary", label: "Summary", title: "The Summary: every finding", page: lastOf((p) => p.kind === "summary") });
  return stops;
}
