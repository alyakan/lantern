/**
 * Your work on the Work tab: the items the Mac's window works out (git, GitHub and Linear are asked there), grouped, filtered and
 * drawn here. The same rules as the Mac's Desk (src/lib/yourWork.ts); nothing here decides what a step is or sends.
 */
import type { RemoteWorkItem } from "../protocol/generated/RemoteWorkItem";
import { ago } from "./home";

export type Tone = "bad" | "wait" | "you" | "local" | "todo" | "done";
export type GroupBy = "feature" | "project" | "none";

export const TONE_WORD: Record<Tone, string> = { bad: "blocked", you: "your call", wait: "waiting", local: "local only", todo: "not started", done: "done" };
/** The states a filter offers, in the order shown. */
export const FILTER_TONES: Tone[] = ["bad", "you", "wait", "local", "todo", "done"];

const STAGES: { stage: string; label: string }[] = [
  { stage: "issue", label: "Issue" },
  { stage: "local", label: "Local" },
  { stage: "pr", label: "PR" },
  { stage: "checks", label: "Checks" },
  { stage: "review", label: "Review" },
  { stage: "merge", label: "Merge" },
  { stage: "release", label: "Release" },
];

const isTone = (t: string): t is Tone => t in TONE_WORD;
/** The item's state, or the quietest one for a state this app doesn't know (a newer Mac's). */
export const toneOf = (item: RemoteWorkItem): Tone => (isTone(item.tone) ? item.tone : "wait");

/** A node of an item's path: behind it, where it is, ahead, or (an issue node of work with no Linear issue) skipped. */
export interface PathNode {
  stage: string;
  label: string;
  state: "past" | "now" | "ahead" | "skip";
}

/** Its path, a node a stage, starting at the issue when Linear is connected. Work with no issue in Linear has that node skipped. */
export function pathOf(item: RemoteWorkItem, issues: boolean): PathNode[] {
  const stages = issues ? STAGES : STAGES.filter((s) => s.stage !== "issue");
  const at = Math.max(0, stages.findIndex((s) => s.stage === item.stage));
  const done = toneOf(item) === "done";
  return stages.map((s, i) => ({ ...s, state: s.stage === "issue" && i < at && !item.issue ? "skip" : i < at || (done && i === at) ? "past" : i === at ? "now" : "ahead" }));
}

/** The line under an item: the Mac's, with a time in it (`{ago}`) filled in from when it happened. */
export function metaOf(item: RemoteWorkItem, now: number): string {
  if (!item.meta.includes("{ago}")) return item.meta;
  const t = item.at === null ? "a while ago" : (() => { const a = ago(item.at, now); return a === "now" ? "just now" : `${a} ago`; })();
  return item.meta.replace("{ago}", t);
}

/** An item's line without a part the heading above it already says (its feature, or its project). */
export function metaUnder(item: RemoteWorkItem, now: number, heading: string | null): string {
  const meta = metaOf(item, now);
  return heading === null ? meta : meta.split(" · ").filter((part) => part !== heading).join(" · ");
}

/** What to do next: yours to decide first, then what is blocked, then branches to push, then issues to start. */
const ORDER: Record<Tone, number> = { you: 0, bad: 1, local: 2, todo: 3, wait: 4, done: 5 };
export function nextSteps(items: RemoteWorkItem[]): RemoteWorkItem[] {
  return items.filter((i) => i.next).sort((a, b) => ORDER[toneOf(a)] - ORDER[toneOf(b)]);
}

/** The rows of "Where things stand" (the Mac lists them in order; a release step has no row of its own). */
export const standing = (items: RemoteWorkItem[]): RemoteWorkItem[] => items.filter((i) => !i.step_only);

export interface WorkGroup {
  /** Stable across updates: what a folded group is remembered by. */
  key: string;
  label: string;
  /** Work with no feature: its label is only a stand-in, and it goes last. */
  plain: boolean;
  items: RemoteWorkItem[];
  doing: number;
  todo: number;
}

/** Groups items (in the order given) by feature, by project, or not at all; the ones with something pressing first, none last. */
export function groupItems(items: RemoteWorkItem[], by: GroupBy): WorkGroup[] {
  const keyOf = (i: RemoteWorkItem) => (by === "feature" ? { key: i.feature ?? "", label: i.feature ?? "No feature", plain: !i.feature } : by === "project" ? { key: i.repo, label: i.repo, plain: false } : { key: "", label: "", plain: false });
  const groups = new Map<string, { label: string; plain: boolean; items: RemoteWorkItem[] }>();
  for (const i of items) {
    const k = keyOf(i);
    const g = groups.get(k.key) ?? { label: k.label, plain: k.plain, items: [] };
    g.items.push(i);
    groups.set(k.key, g);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      ...g,
      doing: new Set(g.items.filter((i) => toneOf(i) !== "todo" && i.issue).map((i) => i.issue)).size,
      todo: g.items.filter((i) => toneOf(i) === "todo").length,
    }))
    .sort((a, b) => Number(a.plain) - Number(b.plain) || items.indexOf(a.items[0]) - items.indexOf(b.items[0]) || a.label.localeCompare(b.label));
}

/** How many items are in each state. */
export function stateCounts(items: RemoteWorkItem[]): Partial<Record<Tone, number>> {
  const n: Partial<Record<Tone, number>> = {};
  for (const i of items) n[toneOf(i)] = (n[toneOf(i)] ?? 0) + 1;
  return n;
}

/** Only the items in these states; none chosen shows everything. */
export const filterItems = (items: RemoteWorkItem[], only: Tone[]): RemoteWorkItem[] => (only.length === 0 ? items : items.filter((i) => only.includes(toneOf(i))));

/** How the list is grouped: what was chosen, or by feature with Linear and by project without it (features need Linear). */
export function groupingFor(chosen: GroupBy | "auto", issues: boolean): GroupBy {
  return chosen === "auto" ? (issues ? "feature" : "project") : chosen === "feature" && !issues ? "project" : chosen;
}

/** A link this phone opens: https on GitHub or Linear, a plain URL with nothing else in it. The Mac checked it too. */
export function safeLink(url: string | null): url is string {
  if (!url || url.length > 300) return false;
  const rest = url.startsWith("https://github.com/") ? url.slice(19) : url.startsWith("https://linear.app/") ? url.slice(19) : null;
  return !!rest && !/[\s\\@\u0000-\u001f\u007f]/.test(url);
}
