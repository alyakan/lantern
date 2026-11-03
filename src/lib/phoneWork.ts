/**
 * Your work for a phone's Work tab: what the window says to the backend (see remote/work.rs), and what a phone's step is asked of it.
 * The phone is shown the items and the name of each step, never the message a step sends: that is written here (stepMessage) and
 * goes to a chat only when a step is asked for, on the Mac, from an item the phone saw as it is now (its `sig`).
 */
import { safeIssueUrl } from "./linear";
import { nextSteps, whereThingsStand, type WorkItem } from "./yourWork";

export interface WindowWorkItem {
  key: string;
  repo: string;
  title: string;
  stage: string;
  tone: string;
  word: string;
  meta: string;
  at: number | null;
  number: number | null;
  feature: string | null;
  issue: string | null;
  url: string | null;
  sig: string;
  step_only: boolean;
  /** ready or done: quiet enough to fold with its kind in a list. */
  fold: string | null;
  next: { what: string; yours: boolean; button: string; warn: boolean } | null;
}

export interface WindowWork {
  issues: boolean;
  /** The Mac has read the repositories (its first answer is in and a project is open): before that, "nothing open" would be a guess. */
  looked: boolean;
  /** The repositories GitHub answered for without saying whose account is yours: none of their pull requests is listed. */
  blind: string[];
  items: WindowWorkItem[];
}

/** A time as `ago` wrote it ("just now", "5m ago", "2h ago", "3d ago"): the phone fills it in from `at`, so the line doesn't change
 * every minute and push to every phone. */
const RELATIVE = /\b(?:just now|\d+[mhd] ago)\b/;

/** `owner/name`, as GitHub names a repository. */
const SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** The page of an item: its pull request on GitHub, or its Linear issue when it is only that. */
function linkOf(item: WorkItem): string | null {
  if (item.tone === "todo" && item.issue) return safeIssueUrl(item.issue.url) ? item.issue.url : null;
  return item.number !== null && item.github && SLUG.test(item.github) ? `https://github.com/${item.github}/pull/${item.number}` : null;
}

/** The user's work as a phone is told it: where things stand (blocked first), then the steps with no row of their own. */
export function phoneWork(items: WorkItem[], issues: boolean, looked: boolean, blind: string[]): WindowWork {
  const listed = whereThingsStand(items);
  const rest = nextSteps(items).filter((i) => i.stepOnly);
  return {
    issues,
    looked,
    blind,
    items: [...listed, ...rest].map((i) => ({
      key: i.key,
      repo: i.name,
      title: i.title,
      stage: i.stage,
      tone: i.tone,
      word: i.word,
      meta: i.at !== null ? i.meta.replace(RELATIVE, "{ago}") : i.meta,
      at: i.at,
      number: i.number,
      feature: i.issue?.project ?? null,
      issue: i.issue?.identifier ?? null,
      url: linkOf(i),
      sig: i.sig,
      step_only: !!i.stepOnly,
      fold: i.fold ?? null,
      next: i.next ? { what: i.next.what, yours: i.next.yours, button: i.next.button, warn: !!i.next.warn } : null,
    })),
  };
}
