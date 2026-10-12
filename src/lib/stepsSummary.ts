import { parsePlanStep } from "./markdown";
import { parseReviewFile, splitFileTitle } from "./review";
import { pageLabel, pageTitle, type StepPage } from "./steps";

/** One line of the Summary tab: a step of the plan, a reviewed file, an evidence round, a fix, or a bookend. */
export interface SummaryRow {
  /** The page it was built from (a step's own page when it has one), so it's stable while the chat goes on. */
  id: string;
  kind: "frame" | "step" | "file" | "evidence" | "fix" | "done" | "review-summary";
  /** "Step 2", "File 3 of 7", "Evidence 1", "Frame", … */
  label: string;
  title: string;
  /** A planned step that has been implemented. True for every other kind, which are pages that were written. */
  built: boolean;
  /** The row of the newest page: what Claude is on now (or just wrote and is waiting on you for). */
  current: boolean;
  /** One line on what the page says, from its own text. */
  gist: string | null;
  /** The page a click opens: a step's implementation, or its plan until it has one. */
  page: string;
  /** A built step's plan page, to open as well. Null when the chat has no plan page for it. */
  planPage: string | null;
  /** The turns whose changes are this row's, for a row that changes files (a built step, evidence, a fix). */
  range: { from: number; to: number } | null;
  /** Whether the row is one whose changed files are worth listing, even if `range` isn't known. */
  changes: boolean;
  /** A reviewed file's findings, as many as the page lists (not counting verdicts); null if its sections weren't found. */
  findings: { count: number; clean: boolean } | null;
  /** A reviewed file's size, from its title. */
  stats: { added: number; removed: number } | null;
}

export interface StepsSummary {
  /** "Plan: 4 steps · 2 built", "3 of 7 files reviewed", …; null when there's nothing to count. */
  headline: string | null;
  rows: SummaryRow[];
}

const GIST_MAX = 140;

/** The first line of prose in some markdown, with its markup taken out and cut to a readable length. */
export function gistOf(text: string): string | null {
  let fenced = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !line || line.startsWith(">") || line.startsWith("|") || /^[-*_]{3,}$/.test(line)) continue;
    const plain = line
      .replace(/^#{1,6}\s*/, "")
      .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\*\*|__|`/g, "")
      .trim();
    if (!plain) continue;
    return plain.length > GIST_MAX ? `${plain.slice(0, GIST_MAX - 1).trimEnd()}…` : plain;
  }
  return null;
}

/** The message a page's main turn wrote, its heading line already taken out. */
function messageOf(page: StepPage): string {
  const turn = page.turns[page.main];
  const own = turn.items.find((it) => it.type === "assistant" && it.id === turn.messageId);
  const msg = own ?? turn.items.find((it) => it.type === "assistant" && it.text.trim());
  return msg?.type === "assistant" ? msg.text : "";
}

/** What a plan page says it will change: the Change line of its File / Change / Verify block. */
function plannedChange(text: string): string | null {
  for (const m of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    const change = parsePlanStep(m[1])?.fields.find((f) => f.label === "Change")?.value;
    if (change) return gistOf(change);
  }
  return null;
}

/** A planned step with its plan page and, once built, its step page; or any other page on its own. */
type StepEntry = { n: number; plan?: StepPage; step?: StepPage };
type Entry = StepEntry | { n: null; page: StepPage };

/**
 * The plan so far, from the pages: Frame, each planned step with what was done for it, the files reviewed or evidence
 * gathered, and Done. Grouped by the headings the pages have, not by the flavour the chat is in now, so a chat that
 * went from Build to Debug keeps both. Suggestions and pages without a heading aren't steps and have no row.
 */
export function summarize(pages: StepPage[]): StepsSummary {
  const included = pages.filter((p) => p.heading && p.heading.kind !== "switch");
  // The row that's "current" is the newest page's; the plan-complete page is a pause after the last step, not a row.
  const lastKey = [...included].reverse().find((p) => p.heading?.kind !== "plan-complete")?.key ?? null;

  const entries: Entry[] = [];
  const stepEntry = new Map<number, StepEntry>();
  let planTotal: number | null = null;
  let stepTotal: number | null = null;
  let filesTotal: number | null = null;
  for (const page of included) {
    const h = page.heading!;
    if (h.kind === "plan-complete") {
      planTotal = h.total ?? planTotal;
    } else if ((h.kind === "plan" || h.kind === "step") && h.n !== null) {
      let e = stepEntry.get(h.n);
      if (!e) {
        e = { n: h.n };
        stepEntry.set(h.n, e);
        entries.push(e);
      }
      // A step planned again later replaces its earlier plan page, and likewise a step written again.
      if (h.kind === "plan") e.plan = page;
      else {
        e.step = page;
        stepTotal = Math.max(stepTotal ?? 0, h.total ?? 0) || stepTotal;
      }
    } else {
      if (h.kind === "file") filesTotal = Math.max(filesTotal ?? 0, h.total ?? 0) || filesTotal;
      entries.push({ n: null, page });
    }
  }

  const rows: SummaryRow[] = entries.map((e): SummaryRow => {
    if (e.n !== null) {
      const main = (e.step ?? e.plan)!;
      const built = !!e.step;
      const gist = built ? gistOf(messageOf(e.step!)) : (plannedChange(messageOf(e.plan!)) ?? gistOf(messageOf(e.plan!)));
      return {
        id: main.key,
        kind: "step",
        label: `Step ${e.n}`,
        title: pageTitle(main) ?? "",
        built,
        current: [e.plan?.key, e.step?.key].includes(lastKey ?? undefined),
        gist,
        page: main.key,
        planPage: built && e.plan ? e.plan.key : null,
        range: built ? (e.step!.range ?? null) : null,
        changes: built,
        findings: null,
        stats: null,
      };
    }
    const page = e.page;
    const h = page.heading!;
    const kind = h.kind === "summary" ? "review-summary" : (h.kind as Exclude<SummaryRow["kind"], "step" | "review-summary">);
    const base = { id: page.key, kind, label: h.kind === "summary" ? "Review summary" : pageLabel(h), title: pageTitle(page) ?? "", built: true, current: page.key === lastKey, page: page.key, planPage: null, findings: null, stats: null } as const;
    if (h.kind === "file") {
      const file = splitFileTitle(h.title);
      const review = parseReviewFile(h.title, messageOf(page));
      return {
        ...base,
        title: file.path,
        gist: review ? gistOf(review.changed) : gistOf(messageOf(page)),
        range: null,
        changes: false,
        findings: review ? { count: review.findings.length, clean: review.clean } : null,
        stats: file.added !== null && file.removed !== null ? { added: file.added, removed: file.removed } : null,
      };
    }
    const changes = h.kind === "evidence" || h.kind === "fix";
    return { ...base, gist: gistOf(messageOf(page)), range: changes ? (page.range ?? null) : null, changes };
  });

  const parts: string[] = [];
  const steps = rows.filter((r) => r.kind === "step");
  if (steps.length) {
    const total = Math.max(planTotal ?? stepTotal ?? 0, steps.length, ...steps.map((r) => Number(/\d+/.exec(r.label)?.[0] ?? 0)));
    const built = steps.filter((r) => r.built).length;
    parts.push(`Plan: ${total} step${total === 1 ? "" : "s"} · ${built === total ? "all built" : `${built} built`}`);
  }
  const files = rows.filter((r) => r.kind === "file").length;
  if (files) parts.push(filesTotal && filesTotal > files ? `${files} of ${filesTotal} files reviewed` : `${files} file${files === 1 ? "" : "s"} reviewed`);
  const evidence = rows.filter((r) => r.kind === "evidence").length;
  if (evidence) parts.push(`${evidence} evidence round${evidence === 1 ? "" : "s"}`);
  return { headline: parts.length ? parts.join(" · ") : null, rows };
}
