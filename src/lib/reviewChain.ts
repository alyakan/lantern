import type { TeamTemplate } from "./roles";

/**
 * A team's "Review and test what an agent builds" setting. On: when a Builder finishes with work committed, Lantern starts a
 * Reviewer (and a QA tester, when the team has one) on that work by itself, and the Lead gets one note with their reports.
 * `checks` are the roles that do the checking, by id; `tidy` closes them once they have reported. Kept with the team.
 */
export interface ReviewSetting {
  on: boolean;
  tidy: boolean;
  checks: string[];
}

/** The roles that check a build (a template with one of these is a team that reviews). */
export const CHECK_ROLES = ["reviewer", "qa", "security"];

/** What a team has when nothing was asked for: off, and a Reviewer when it is switched on. Reviewers are tidied up after they report. */
export const NO_REVIEW: ReviewSetting = { on: false, tidy: true, checks: ["reviewer"] };

/** On for a team started from a template that has a Reviewer or QA (those members are the checks), otherwise off. */
export function reviewFor(template: TeamTemplate | null): ReviewSetting {
  const checks = template ? template.members.filter((id) => CHECK_ROLES.includes(id)) : [];
  const wanted = checks.some((id) => id === "reviewer" || id === "qa");
  return wanted ? { on: true, tidy: true, checks } : NO_REVIEW;
}

/** A saved setting, checked: anything that isn't one is the default. */
export function readReview(value: unknown): ReviewSetting {
  const v = value as Partial<ReviewSetting> | null;
  if (!v || typeof v !== "object" || typeof v.on !== "boolean") return NO_REVIEW;
  const checks = Array.isArray(v.checks) ? v.checks.filter((c): c is string => typeof c === "string" && c.length > 0).slice(0, 4) : [];
  return { on: v.on, tidy: typeof v.tidy === "boolean" ? v.tidy : true, checks: checks.length ? checks : NO_REVIEW.checks };
}

/** One check of a builder's work, as the backend reports it (see `review_update`). */
export interface ReviewCheck {
  role: string;
  label: string;
  slot: string | null;
  /** Waiting for a free slot, going, reported, stopped before it reported, or dropped when the setting went off. */
  state: "waiting" | "running" | "done" | "failed" | "skipped";
  /** From the report's last line (RESULT: pass, RESULT: issues 3); null when it had none. */
  findings: number | null;
  passed: boolean | null;
}

/** The review and test of one commit of a builder's work, for the builder's card and the inbox. */
export interface ReviewInfo {
  builder: string;
  name: string;
  commit: string;
  checks: ReviewCheck[];
  /** Every check has finished and the Lead has its one note. */
  done: boolean;
  /** When it last changed (ms). */
  at: number;
}

const isTest = (c: ReviewCheck) => c.role === "qa";
const things = (n: number) => (n === 1 ? "1 finding" : `${n} findings`);

/** What one check says on the builder's card: "In review", "Review: 2 findings", "Tested: failed", "Review: waiting for a free slot". */
export function checkText(c: ReviewCheck): string | null {
  const audit = c.role === "security";
  const noun = isTest(c) ? "Test" : audit ? "Audit" : "Review";
  switch (c.state) {
    case "skipped":
      return null;
    case "waiting":
      return `${noun}: waiting for a free slot`;
    case "running":
      return isTest(c) ? "Testing" : audit ? "Being audited" : "In review";
    case "failed":
      return `${isTest(c) ? "Tested" : noun}: didn't finish`;
    case "done":
      if (isTest(c)) return c.passed === null ? "Tested: done" : c.passed ? "Tested: passed" : "Tested: failed";
      return c.findings === null ? `${noun}: done` : c.findings === 0 ? `${noun}: no findings` : `${noun}: ${things(c.findings)}`;
  }
}

/** The small strip on a builder's card while its work is checked and after: each check's text, joined; null when there is nothing to say. */
export function reviewStrip(info: ReviewInfo | undefined): string | null {
  const parts = (info?.checks ?? []).flatMap((c) => checkText(c) ?? []);
  return parts.length ? parts.join(" · ") : null;
}

/** Whether something in the strip is still going or waiting, for a quiet pulse. */
export const reviewBusy = (info: ReviewInfo | undefined): boolean => !!info && !info.done;

/**
 * What the inbox says once the checks are in: "Review of Login found 3 things". Only the checks whose last line gave a number are
 * counted; with none that did, it says there is no summary rather than guess. Null while the checks are still going.
 */
export function reviewHeadline(info: ReviewInfo): string | null {
  if (!info.done) return null;
  const ran = info.checks.filter((c) => c.state === "done" || c.state === "failed");
  if (ran.length === 0) return null;
  if (ran.every((c) => c.state === "failed")) return `Review of ${info.name} didn't finish`;
  const known = ran.filter((c) => c.findings !== null);
  if (known.length === 0) return `Review of ${info.name} is in (no summary)`;
  const total = known.reduce((n, c) => n + (c.findings ?? 0), 0);
  const base = total === 0 ? `Review of ${info.name} found nothing to fix` : `Review of ${info.name} found ${total} ${total === 1 ? "thing" : "things"}`;
  return known.length < ran.length ? `${base} (one report had no summary)` : base;
}
