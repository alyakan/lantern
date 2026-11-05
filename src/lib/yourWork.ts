/**
 * The Desk's "Your work": where each piece of your work stands, from a branch never pushed to a release, and what to do next.
 * Your pull requests (and Claude's, which are opened as you) and the ones you are asked to review, from what git and gh said
 * (status.rs); nothing is guessed. A next step either goes to a chat as a message ("Do it") or is your call (merging,
 * publishing, releasing), which the chat still asks you about on an approval card.
 *
 * The messages name a pull request by its repository and number, and a branch or tag only when it reads as one: what GitHub
 * says (a title, someone else's branch) is shown on the Desk, never handed to Claude.
 */
import type { InboxRow } from "./deskBoard";
import { ISSUE_ID, safeIssueId, safeIssueUrl } from "./linear";
import type { LinearIssue, LinearWork, RepoStatus } from "../types";

export type Stage = "issue" | "local" | "pr" | "checks" | "review" | "merge" | "release";
export const STAGES: { stage: Stage; label: string }[] = [
  { stage: "issue", label: "Issue" },
  { stage: "local", label: "Local" },
  { stage: "pr", label: "PR" },
  { stage: "checks", label: "Checks" },
  { stage: "review", label: "Review" },
  { stage: "merge", label: "Merge" },
  { stage: "release", label: "Release" },
];

/** bad: blocked (checks failing, conflicts, changes asked); wait: on its way (checks running, a review pending); you: your call;
 * move: its pull request merged but its Linear issue still says it is being worked on (the ticket needs moving); local: on the Mac
 * only; todo: an issue in Linear not started (no branch or pull request); ready: merged, waiting for a release; done: released. */
export type Tone = "bad" | "wait" | "you" | "move" | "local" | "todo" | "ready" | "done";
export const TONE_WORD: Record<Tone, string> = { bad: "blocked", you: "your call", move: "needs moving", wait: "waiting", local: "local only", todo: "not started", ready: "ready", done: "done" };

export type StepKind = "push" | "conflicts" | "checks" | "changes" | "update" | "merge" | "review" | "release" | "publish" | "start" | "move";

export interface Step {
  kind: StepKind;
  /** What to do, before the item's name: "Fix failing checks on". */
  what: string;
  /** Yours to decide (a merge, a publish, a release): the chat prepares it and asks you on an approval card. */
  yours: boolean;
  /** The button's word. */
  button: string;
  /** What the chat is told, without the line about where to work (see `stepMessage`). */
  text: string;
  /** It changes code on the branch, so a chat that isn't on it is told to use a worktree of its own. */
  onBranch: boolean;
  /** Yours to decide, and it goes around a rule (merging a pull request nobody approved): drawn in a warning colour. */
  warn?: boolean;
}

export interface WorkItem {
  key: string;
  /** The repository's main checkout, and its short name. */
  repo: string;
  name: string;
  github: string | null;
  number: number | null;
  /** The branch, as git or GitHub has it (shown; in a message only when `safeRef`). */
  branch: string | null;
  /** What is shown: the pull request's title, the branch, or the release's tag. */
  title: string;
  stage: Stage;
  tone: Tone;
  /** Where it is, in a few words: "Checks failing", "Not pushed · 3 commits". */
  word: string;
  /** One quiet line under it. */
  meta: string;
  /** When it last moved (ms), when known. */
  at: number | null;
  next: Step | null;
  /** Changes when it moves on: a step sent stays marked as sent until this does. */
  sig: string;
  /** Only a next step, not listed under where things stand (a release: its pull requests are listed each). */
  stepOnly?: boolean;
  /** The Linear issue it is the work of (named by its title too), and the project (feature) that is in. */
  issue?: { identifier: string; url: string; project: string | null; title: string };
  /** `meta` without the issue's part, which the Mac draws as a line of its own (the phone is sent `meta` whole). */
  bare?: string;
  /** What is quiet enough to fold with its kind in a list (see `foldRows`): work merged and waiting for a release, or done. */
  fold?: Fold;
  /** Where a pull request sits in a stack of them (see `stackOf`). */
  stack?: StackPlace;
}

/** A pull request based on another open pull request's branch is stacked on it. `id`: the bottom one's number, which the stack is
 * known by; `pos`: 1 at the bottom; `of`: how tall the stack is; `on`: the number of the one it is based on. */
export interface StackPlace {
  id: number;
  pos: number;
  of: number;
  on: number | null;
}

/** ready: merged, waiting for a release (a Ready issue, or a pull request merged since the last release); done: finished. */
export type Fold = "ready" | "done";

/** A branch or tag that is only letters, digits and `._/-`, and never reads as an option: safe to name in a message. */
export const safeRef = (s: string | null | undefined): s is string => !!s && s.length <= 200 && /^[A-Za-z0-9._/-]+$/.test(s) && !s.startsWith("-") && !s.includes("..");

/** A branch's commits never pushed are a next step for this long after its last one; older, they're only listed. */
const BRANCH_FRESH_MS = 3 * 86_400_000;

const time = (iso: string | null | undefined): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

const short = (r: RepoStatus) => r.github?.split("/")[1] ?? r.repo.split("/").filter(Boolean).pop() ?? r.repo;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const ASK_PUSH = "Ask me with request_approval before you push.";

function prRef(r: RepoStatus, n: number) {
  return r.github ? `pull request #${n} in ${r.github}` : `pull request #${n}`;
}

type Pr = RepoStatus["prs"][number];

/** Where one of your open pull requests stands, and what comes next. Conflicts come before checks: GitHub runs no checks on a
 * pull request that conflicts. One that is approved, or whose repository asks for no review, is merged. One whose review is
 * required and missing can still be merged by an admin (a repository you merge alone stays "review required" for good), but that
 * is **Bypass & merge**, in a warning colour: it goes around the rule. */
function openStage(r: RepoStatus, p: Pr): Pick<WorkItem, "stage" | "tone" | "word" | "next"> {
  const ref = prRef(r, p.number);
  const step = (kind: StepKind, what: string, text: string, yours = false, button = "Do it", onBranch = !yours, warn = false): Step => ({ kind, what, text, yours, button, onBranch, ...(warn ? { warn } : {}) });
  if (p.draft) return { stage: "pr", tone: "wait", word: "Draft", next: null };
  if (p.mergeable === "CONFLICTING" || p.merge_state === "DIRTY")
    return { stage: "merge", tone: "bad", word: "Conflicts with its base", next: step("conflicts", "Resolve conflicts on", `${cap(ref)} has merge conflicts with its base branch. Read it with gh, resolve the conflicts on its branch and run the tests. ${ASK_PUSH}`) };
  if (p.checks === "fail")
    return { stage: "checks", tone: "bad", word: "Checks failing", next: step("checks", "Fix failing checks on", `The checks failed on ${ref}. Find out which and why with gh (gh pr checks, then the failed run's log), fix them on its branch and run the tests. ${ASK_PUSH}`) };
  if (p.checks === "pending") return { stage: "checks", tone: "wait", word: "Checks running", next: null };
  if (p.review === "CHANGES_REQUESTED")
    return { stage: "review", tone: "bad", word: "Changes asked", next: step("changes", "Answer the review on", `A reviewer asked for changes on ${ref}. Read the review with gh pr view --comments, make the changes on its branch and run the tests. Don't reply on GitHub. ${ASK_PUSH}`) };
  if (p.merge_state === "BEHIND")
    return { stage: "merge", tone: "bad", word: "Behind its base", next: step("update", "Bring up to date", `${cap(ref)} is behind its base branch. Bring its branch up to date with the base and run the tests. ${ASK_PUSH}`) };
  if (p.mergeable === "UNKNOWN" || p.merge_state === "UNKNOWN") return { stage: "merge", tone: "wait", word: "GitHub is checking it", next: null };
  // Nobody approved it and a review is required: merging is a decision to go around the rule, and the chat is told to say so.
  if (p.review === "REVIEW_REQUIRED")
    return {
      stage: "review",
      tone: "you",
      word: "Not approved",
      next: step(
        "merge",
        "Bypass review and merge",
        `${cap(ref)} has no approval, and its repository requires a review. Its checks pass and it has no conflicts. Check it once more with gh. Merging it goes around the review rule (gh pr merge --admin), so ask me with request_approval, and say on the card that it bypasses the required review. Merge it only if I say yes.`,
        true,
        "Bypass & merge…",
        false,
        true,
      ),
    };
  return {
    stage: "merge",
    tone: "you",
    word: p.checks === "none" ? "Ready to merge · no checks" : "Ready to merge",
    next: step("merge", "Merge", `${cap(ref)} looks ready: its checks pass and it has no conflicts. Check it once more with gh, then ask me with request_approval to merge it. Merge it only if I say yes.`, true, "Merge…"),
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The open pull requests `p` is stacked on, the bottom one first (none when it is based on a branch no open pull request has). */
function below(r: RepoStatus, p: Pr): Pr[] {
  const out: Pr[] = [];
  const seen = new Set([p.number]);
  for (let q = r.prs.find((x) => x.branch === p.base); q && !seen.has(q.number); q = r.prs.find((x) => x.branch === q!.base)) {
    seen.add(q.number);
    out.unshift(q);
  }
  return out;
}

/** Where `p` sits in its stack, when it is in one (two or more pull requests, each based on the one below). */
function stackOf(r: RepoStatus, p: Pr): StackPlace | undefined {
  const under = below(r, p);
  const bottom = under[0] ?? p;
  const heights = r.prs.flatMap((q) => {
    const b = below(r, q);
    return (b[0] ?? q).number === bottom.number ? [b.length + 1] : [];
  });
  if (heights.length < 2) return undefined;
  return { id: bottom.number, pos: under.length + 1, of: Math.max(...heights), on: under.length ? under[under.length - 1].number : null };
}

/**
 * A stacked pull request is merged with the ones under it, from the bottom up, into the bottom one's base: only when each of them
 * is yours and could be merged now. Until then it waits on the first that can't, and one of someone else's is never merged from
 * here. The bottom one merges on its own, as any other.
 */
function stacked(r: RepoStatus, p: Pr, s: ReturnType<typeof openStage>): ReturnType<typeof openStage> {
  const under = below(r, p);
  if (!under.length || s.next?.kind !== "merge") return s;
  const theirs = under.find((q) => !r.viewer || q.author.toLowerCase() !== r.viewer.toLowerCase());
  if (theirs) return { stage: s.stage, tone: "wait", word: `Stacked on #${theirs.number} by @${theirs.author}`, next: null };
  const stuck = under.find((q) => openStage(r, q).next?.kind !== "merge");
  if (stuck) return { stage: s.stage, tone: "wait", word: `Waiting on #${stuck.number}`, next: null };
  const all = [...under, p];
  const warn = all.some((q) => q === p ? s.next?.warn : openStage(r, q).next?.warn);
  const into = safeRef(under[0].base) ? ` (${under[0].base})` : "";
  const nums = all.map((q) => `#${q.number}`).join(", ");
  return {
    stage: "merge",
    tone: "you",
    word: `Ready to merge · ${all.length} in the stack`,
    next: {
      kind: "merge",
      what: "Merge the stack up to",
      yours: true,
      button: "Merge stack to here…",
      onBranch: false,
      ...(warn ? { warn } : {}),
      text: `${cap(prRef(r, p.number))} is stacked on others. Merge the stack from the bottom up to it, ${nums}${r.github ? ` in ${r.github}` : ""}, into the bottom one's base branch${into}. Check each once more with gh first. Merge them the way this repository merges stacks: GitHub's own stack merge if it uses stacked pull requests, otherwise each in turn from the bottom, pointing the next one's base at that branch with gh pr edit --base before merging it. Ask me with request_approval once, naming every pull request${warn ? ", and say on the card that it bypasses a required review" : ""}. Merge them only if I say yes.`,
    },
  };
}

/** Every piece of your work in the repositories, in no order (see `nextSteps`, `whereThingsStand`). */
export function yourWork(repos: RepoStatus[] | null, now: number): WorkItem[] {
  const out: WorkItem[] = [];
  for (const r of repos ?? []) {
    const name = short(r);
    const base = { repo: r.repo, name, github: r.github };
    const viewer = r.viewer;
    // Without knowing who you are, no pull request counts as yours: a stranger's must never be offered to fix or merge.
    const mine = (author: string) => !!viewer && author.toLowerCase() === viewer.toLowerCase();
    for (const p of r.prs) {
      if (mine(p.author)) {
        const s = stacked(r, p, openStage(r, p));
        const stack = stackOf(r, p);
        out.push({ ...base, key: `${r.repo}:pr:${p.number}`, number: p.number, branch: p.branch, title: p.title, ...s, meta: `${name} · ${p.branch}`, at: null, sig: `${s.stage}:${s.word}`, ...(stack ? { stack } : {}) });
      } else if (viewer && p.review_requests.some((l) => l.toLowerCase() === viewer.toLowerCase())) {
        out.push({
          ...base,
          key: `${r.repo}:review:${p.number}`,
          number: p.number,
          branch: p.branch,
          title: p.title,
          stage: "review",
          tone: "you",
          word: "Your review is asked",
          meta: `${name} · by @${p.author}`,
          at: null,
          next: { kind: "review", what: "Review", yours: false, button: "Do it", onBranch: false, text: `I've been asked to review ${prRef(r, p.number)}. Read it with gh pr view and gh pr diff, and tell me what you find. It is someone else's code: only read it. Don't check out its branch, build it or run anything from it, and don't post anything on GitHub.` },
          sig: "review",
        });
      }
    }
    // What merged since the last release waits for the next one; a repository that has never released has nothing waiting.
    const released = time(r.release?.published_at);
    const waiting = released === null ? [] : r.merged.filter((m) => mine(m.author) && (time(m.merged_at) ?? 0) > released);
    for (const m of waiting) {
      out.push({ ...base, key: `${r.repo}:merged:${m.number}`, number: m.number, branch: m.branch, title: m.title, stage: "release", tone: "ready", word: "Merged · not released", meta: `${name} · merged ${ago(now, time(m.merged_at))}`, at: time(m.merged_at), next: null, sig: "merged", fold: "ready" });
    }
    for (const tag of r.drafts) {
      const ok = safeRef(tag);
      out.push({
        ...base,
        key: `${r.repo}:draft:${tag}`,
        number: null,
        branch: null,
        title: tag,
        stage: "release",
        tone: "you",
        word: "Draft release waiting",
        meta: `${name}${waiting.length ? ` · ${plural(waiting.length, "pull request")} merged since ${r.release?.tag}` : ""}`,
        at: null,
        next: ok ? { kind: "publish", what: "Publish", yours: true, button: "Publish…", onBranch: false, text: `The draft release ${tag}${r.github ? ` in ${r.github}` : ""} is waiting. Check it with gh release view ${tag}, then ask me with request_approval to publish it. Publish it only if I say yes.` } : null,
        sig: "draft",
      });
    }
    if (waiting.length && !r.drafts.length && r.release) {
      const tag = r.release.tag;
      out.push({
        ...base,
        key: `${r.repo}:release`,
        number: null,
        branch: null,
        title: `${plural(waiting.length, "pull request")} since ${tag}`,
        stage: "release",
        tone: "you",
        word: "Not released",
        meta: `${name} · ${waiting.map((m) => `#${m.number}`).join(", ")}`,
        at: waiting[0] ? time(waiting[0].merged_at) : null,
        next: { kind: "release", what: "Release", yours: true, button: "Release…", onBranch: false, text: `${plural(waiting.length, "pull request")} merged${r.github ? ` in ${r.github}` : ""} since the last release${safeRef(tag) ? `, ${tag}` : ""}: ${waiting.map((m) => `#${m.number}`).join(", ")}. Get the next release ready the way this project releases, and ask me with request_approval before you push a tag or publish anything.` },
        sig: `release:${waiting.length}`,
        stepOnly: true,
      });
    }
    if (released !== null && sameDay(released, now) && r.release) {
      out.push({ ...base, key: `${r.repo}:released:${r.release.tag}`, number: null, branch: null, title: `Released ${r.release.tag}`, stage: "release", tone: "done", word: "Released", meta: `${name} · ${ago(now, released)}`, at: released, next: null, sig: "released", fold: "done" });
    }
    // A branch that was merged under its name isn't work left, even if it never had an upstream.
    const known = new Set([...r.prs.map((p) => p.branch), ...r.merged.map((m) => m.branch)]);
    for (const b of r.branches ?? []) {
      if (known.has(b.name)) continue;
      const at = b.committed ? b.committed * 1000 : null;
      const fresh = at !== null && now - at < BRANCH_FRESH_MS && safeRef(b.name);
      out.push({
        ...base,
        key: `${r.repo}:branch:${b.name}`,
        number: null,
        branch: b.name,
        title: b.name,
        stage: "local",
        tone: "local",
        word: `Not pushed · ${plural(b.ahead, "commit")}`,
        meta: `${name} · last commit ${ago(now, at)}`,
        at,
        next: fresh
          ? { kind: "push", what: "Push and open a pull request for", yours: false, button: "Do it", onBranch: true, text: `The branch ${b.name} has ${plural(b.ahead, "commit")} that were never pushed. Look at what they do and write a pull request description for them. Ask me with request_approval before you push it and open the pull request.` }
          : null,
        sig: `local:${b.ahead}`,
      });
    }
  }
  return out;
}

function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

function ago(now: number, at: number | null): string {
  if (at === null) return "at a time not known";
  const m = Math.floor((now - at) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

const ORDER: Record<Tone, number> = { you: 0, bad: 1, move: 2, local: 3, todo: 4, wait: 5, ready: 6, done: 7 };

/** The repositories GitHub answered for without saying who you are: their pull requests can't be told apart, so none are shown. */
export function unknownViewer(repos: RepoStatus[] | null): string[] {
  return (repos ?? []).filter((r) => r.gh === "ready" && !r.viewer).map(short);
}

/** What to do next, yours to decide first, then what is blocked, then tickets to move, then branches to push, then issues to start. */
export function nextSteps(items: WorkItem[]): WorkItem[] {
  return items.filter((i) => i.next).sort((a, b) => ORDER[a.tone] - ORDER[b.tone]);
}

/** Every item, blocked first, then yours, tickets to move, on its way, local, Ready and done: what's done and branches with nothing to do come last. */
export function whereThingsStand(items: WorkItem[]): WorkItem[] {
  const rank = (i: WorkItem) => ({ bad: 0, you: 1, move: 2, wait: 3, local: 4, todo: 6, ready: 7, done: 8 })[i.tone] + (i.tone === "local" && !i.next ? 1 : 0);
  return stackTogether(items.filter((i) => !i.stepOnly).sort((a, b) => rank(a) - rank(b) || (b.at ?? 0) - (a.at ?? 0)));
}

/** The list with each stack's pull requests together, bottom first, at the place of the most pressing of them. */
function stackTogether(items: WorkItem[]): WorkItem[] {
  const out: WorkItem[] = [];
  const placed = new Set<string>();
  for (const i of items) {
    if (placed.has(i.key)) continue;
    const members = i.stack ? items.filter((j) => j.repo === i.repo && j.stack?.id === i.stack!.id).sort((a, b) => a.stack!.pos - b.stack!.pos) : [i];
    for (const m of members) {
      out.push(m);
      placed.add(m.key);
    }
  }
  return out;
}

/** A row of a list of work: an item, or several quiet ones (`fold`) in one line that opens to them. */
export type WorkRow = { kind: "item"; item: WorkItem } | { kind: "fold"; fold: Fold; items: WorkItem[] };

/**
 * A list of work as rows, in its order. Two or more items of one kind (`fold`: Ready, or done) are one row, at the place of the
 * first of them, that opens to them; a single one stays a row of its own. The items are gathered whatever the order between them.
 */
export function foldRows(items: WorkItem[]): WorkRow[] {
  const of = new Map<Fold, WorkItem[]>();
  for (const i of items) if (i.fold) of.set(i.fold, [...(of.get(i.fold) ?? []), i]);
  const rows: WorkRow[] = [];
  const placed = new Set<Fold>();
  for (const i of items) {
    const members = i.fold ? of.get(i.fold)! : [];
    if (!i.fold || members.length < 2) rows.push({ kind: "item", item: i });
    else if (!placed.has(i.fold)) {
      placed.add(i.fold);
      rows.push({ kind: "fold", fold: i.fold, items: members });
    }
  }
  return rows;
}

/** What a folded row says: how many, and what they are. */
export const foldWord = (fold: Fold, n: number): string => (fold === "ready" ? `${n} Ready · merged, waiting for a release` : `${n} Done`);

/** How many of a repository's items are in each state (done left out), for a project's tile. */
export function toneCounts(items: WorkItem[], repo: string): Partial<Record<Tone, number>> {
  const n: Partial<Record<Tone, number>> = {};
  for (const i of items) if (i.repo === repo && i.tone !== "done" && !i.stepOnly) n[i.tone] = (n[i.tone] ?? 0) + 1;
  return n;
}

export type Target = { kind: "chat"; slot: string; title: string } | { kind: "busy"; slot: string; title: string; why: string } | { kind: "new"; folder: string };

const BUSY: Record<InboxRow["state"], string> = { working: "is working", waiting: "is waiting on you", asleep: "is asleep", done: "" };

/**
 * Where a step goes: the chat on the item's branch when it is idle (one working, waiting on you or asleep is busy, and nothing is
 * sent to it), else a new chat in one of the repository's folders on the Desk.
 */
export function targetFor(item: WorkItem, chats: InboxRow[], repos: RepoStatus[] | null): Target | null {
  const repo = repos?.find((r) => r.repo === item.repo);
  if (!repo) return null;
  const here = chatsOn(item, chats, repos);
  const free = here.find((c) => c.state === "done");
  if (free) return { kind: "chat", slot: free.slot, title: free.title };
  if (here[0]) return { kind: "busy", slot: here[0].slot, title: here[0].title, why: BUSY[here[0].state] };
  const folder = repo.folders[0]?.folder;
  return folder ? { kind: "new", folder } : null;
}

/** The chats on the Desk whose folder is on the item's branch: the ones working on it. */
export function chatsOn(item: WorkItem, chats: InboxRow[], repos: RepoStatus[] | null): InboxRow[] {
  const repo = repos?.find((r) => r.repo === item.repo);
  const onBranch = repo && item.branch ? repo.folders.filter((f) => f.branch === item.branch).map((f) => f.folder) : [];
  return chats.filter((c) => onBranch.includes(c.folder));
}

/** What finds the chats about an item in History's search, most telling first: its branch (a long one, not a base branch), its
 * Linear issue, its pull request's link. Only what reads as a branch, an identifier or a number is searched for. */
export function searchTerms(item: WorkItem): string[] {
  const branch = safeRef(item.branch) && item.branch.length >= 5 && !["main", "master", "develop", "trunk"].includes(item.branch) ? item.branch : null;
  const issue = item.issue && safeIssueId(item.issue.identifier) ? item.issue.identifier : null;
  const pull = item.number !== null && item.github ? `${item.github}/pull/${item.number}` : null;
  return [branch, issue, pull].filter((t): t is string => !!t);
}

/** A stack's place in words: "stack 2 of 3 · on #410". */
export const stackWord = (s: StackPlace): string => `stack ${s.pos} of ${s.of}${s.on !== null ? ` · on #${s.on}` : ""}`;

/** What the item's own line says, quietly: its issue, where it is (without a feature the heading says, or its project when a tag
 * says that), and its place in a stack. */
export function lineOf(item: WorkItem, feature: string | null, tagged = false): string {
  const meta = (item.bare ?? item.meta).split(" · ").filter((part) => part !== feature && !(tagged && part === item.name));
  return [item.issue && !item.key.startsWith("linear:") ? item.issue.identifier : null, ...meta, item.stack ? stackWord(item.stack) : null].filter(Boolean).join(" · ");
}

/** What the chat is told: the step, and, when the chat isn't on the item's branch, to work on it without moving this checkout. */
export function stepMessage(item: WorkItem, target: Target): string {
  const step = item.next!;
  if (!step.onBranch || target.kind === "chat") return step.text;
  const branch = safeRef(item.branch) ? ` (${item.branch})` : "";
  return `${step.text}\n\nWork on its branch${branch} in a git worktree of your own, and leave the branch and files of this checkout as they are.`;
}

/** An issue not started is a next step when it is urgent or high, or due within this long (or overdue). */
const SOON_MS = 3 * 86_400_000;

/** Whether `issue` is the issue of `item`: a pull request Linear has linked, the branch Linear suggests, or its identifier in the
 * branch or the title. */
function isIssueOf(issue: LinearIssue, item: Pick<WorkItem, "number" | "github" | "branch" | "title">): boolean {
  if (item.number !== null && item.github && issue.links.includes(`https://github.com/${item.github}/pull/${item.number}`)) return true;
  if (item.branch && issue.branch && item.branch.toLowerCase() === issue.branch.toLowerCase()) return true;
  const named = (t: string | null) => !!t && [...t.matchAll(ISSUE_ID)].some((m) => `${m[1]}-${m[2]}`.toUpperCase() === issue.identifier);
  // A pull request's title can name it; a release or a draft (no number, no branch) is no one issue's work.
  return named(item.branch) || (item.number !== null && named(item.title));
}

const PRIORITY = ["", "Urgent", "High", "Medium", "Low"];

/** Ready: merged, not yet released. */
export const isReady = (issue: LinearIssue) => issue.state.trim().toLowerCase() === "ready";

/** Done or Closed: finished. Linear says an issue is done only by its state's name here (Ready and In Review are "completed" too). */
export const isFinished = (issue: LinearIssue) => issue.state_type === "completed" && ["done", "closed"].includes(issue.state.trim().toLowerCase());

/** Linear still says it is being worked on (In Progress, In Review, or not even started): once its pull request has merged, the
 * ticket needs moving. Testing can rightly come after a merge; Ready, Done and Closed are where a merged one goes. */
export const lagsMerge = (issue: LinearIssue) => !isReady(issue) && !isFinished(issue) && issue.state_type !== "canceled" && issue.state.trim().toLowerCase() !== "testing";

/** Your pull request of `issue` that merged in this repository (one of the latest GitHub listed), when there is one. Someone
 * else's that names it (a follow-up) doesn't say its ticket is behind. */
function mergedPull(issue: LinearIssue, r: RepoStatus): RepoStatus["merged"][number] | null {
  const mine = (author: string) => !!r.viewer && author.toLowerCase() === r.viewer.toLowerCase();
  return r.merged.find((m) => mine(m.author) && isIssueOf(issue, { number: m.number, github: r.github, branch: m.branch, title: m.title })) ?? null;
}

const MOVED = "Merged · move the ticket";

/** A short fingerprint of `text` (not for secrets: only to tell one list from another). */
const hash = (text: string) => [...text].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7).toString(36);

/** The pull request Linear has linked to `issue` in this repository, when it has one. */
function linkedPull(issue: LinearIssue, github: string | null): number | null {
  if (!github) return null;
  const prefix = `https://github.com/${github}/pull/`;
  const link = issue.links.find((l) => l.startsWith(prefix) && /^\d{1,7}$/.test(l.slice(prefix.length)));
  return link ? Number(link.slice(prefix.length)) : null;
}

/**
 * Your work with Linear's: each item marked with the issue it is the work of, and an item for each of your issues that nothing
 * is the work of yet (not started), in the repository its team is the work of (`teamOf`: repository → team key). An issue of a
 * team no Desk project is in is listed without a step. The step names the issue by its identifier and link only.
 */
export function withLinear(items: WorkItem[], work: LinearWork | null, teamOf: Record<string, string>, repos: RepoStatus[] | null, now: number): WorkItem[] {
  if (!work?.connected || !work.issues.length) return items;
  const started = new Set<string>();
  const out = items.flatMap((item): WorkItem[] => {
    const issue = work.issues.find((i) => isIssueOf(i, item));
    if (!issue) return [item];
    started.add(issue.identifier);
    // The issue by name, so a row says what it is the work of (and why it sits under its feature), not only its identifier.
    const named = issue.title.trim() ? `${issue.identifier} ${issue.title.trim()}` : issue.identifier;
    const tag = issue.project ? `${named} · ${issue.project}` : named;
    const marked: WorkItem = { ...item, issue: { identifier: issue.identifier, url: issue.url, project: issue.project, title: issue.title }, bare: item.meta, meta: `${tag} · ${item.meta}` };
    // Merged, and Linear still says it is being worked on: the ticket is behind, which is louder than waiting for a release.
    if (item.key.includes(":merged:") && lagsMerge(issue)) {
      const { fold: _quiet, ...moved } = marked;
      return [{ ...moved, tone: "move", word: MOVED, sig: `move:${issue.state}` }];
    }
    return [marked];
  });
  const repoOfTeam = (team: string) => (repos ?? []).find((r) => teamOf[r.repo] === team);
  // A feature (Linear project) is going while any issue of yours in it isn't finished: only then its finished issues are listed.
  const featureOf = (i: LinearIssue) => (i.project ? (i.project_id ?? i.project) : null);
  const going = new Set(work.issues.filter((i) => !isFinished(i)).map(featureOf));
  for (const issue of work.issues) {
    if (started.has(issue.identifier)) continue;
    const r = repoOfTeam(issue.team);
    if (isFinished(issue)) {
      const feature = featureOf(issue);
      if (feature === null || !going.has(feature)) continue;
      const pull = linkedPull(issue, r?.github ?? null);
      out.push({
        key: `linear:${issue.identifier}`,
        repo: r?.repo ?? "",
        name: r ? short(r) : issue.team,
        github: r?.github ?? null,
        number: pull,
        branch: null,
        title: `${issue.identifier} ${issue.title}`,
        stage: "release",
        tone: "done",
        word: issue.state,
        meta: [issue.project, !r && `no Desk project is in team ${issue.team}`].filter(Boolean).join(" · "),
        at: null,
        next: null,
        sig: `issue:${issue.state}`,
        issue: { identifier: issue.identifier, url: issue.url, project: issue.project, title: issue.title },
        fold: "done",
      });
      continue;
    }
    // Its pull request merged and Linear wasn't told: it isn't on its way, or work to start, but a ticket to move.
    const pull = r && lagsMerge(issue) ? mergedPull(issue, r) : null;
    if (r && pull) {
      out.push({
        key: `linear:${issue.identifier}`,
        repo: r.repo,
        name: short(r),
        github: r.github,
        number: pull.number,
        branch: pull.branch || null,
        title: `${issue.identifier} ${issue.title}`,
        stage: "release",
        tone: "move",
        word: MOVED,
        meta: [issue.project, `still ${issue.state || "open"} in Linear`, `merged ${ago(now, time(pull.merged_at))}`].filter(Boolean).join(" · "),
        at: time(pull.merged_at),
        next: null,
        sig: `move:${issue.state}`,
        issue: { identifier: issue.identifier, url: issue.url, project: issue.project, title: issue.title },
      });
      continue;
    }
    const due = issue.due ? Date.parse(`${issue.due}T23:59:59`) : NaN;
    const soon = (issue.priority === 1 || issue.priority === 2) || (Number.isFinite(due) && due - now < SOON_MS);
    const ok = !!r && safeIssueId(issue.identifier) && safeIssueUrl(issue.url);
    // Linear files In Review, Testing and Ready under "completed", but they aren't done: nothing to start, and it is on its way (or, Ready,
    // merged and waiting for a release). Its pull request, if the Desk has it, is its row instead (above).
    if (issue.state_type === "completed") {
      const ready = isReady(issue);
      out.push({
        key: `linear:${issue.identifier}`,
        repo: r?.repo ?? "",
        name: r ? short(r) : issue.team,
        github: r?.github ?? null,
        number: null,
        branch: null,
        title: `${issue.identifier} ${issue.title}`,
        stage: ready ? "release" : "review",
        tone: ready ? "ready" : "wait",
        word: issue.state,
        meta: [issue.project, ready && "merged, waiting for a release", !r && `no Desk project is in team ${issue.team}`].filter(Boolean).join(" · "),
        at: null,
        next: null,
        sig: `issue:${issue.state}`,
        issue: { identifier: issue.identifier, url: issue.url, project: issue.project, title: issue.title },
        ...(ready ? { fold: "ready" as const } : {}),
      });
      continue;
    }
    const facts = [issue.project, PRIORITY[issue.priority], issue.due && `due ${issue.due}`, !r && `no Desk project is in team ${issue.team}`].filter(Boolean).join(" · ");
    out.push({
      key: `linear:${issue.identifier}`,
      repo: r?.repo ?? "",
      name: r ? short(r) : issue.team,
      github: r?.github ?? null,
      number: null,
      branch: null,
      title: `${issue.identifier} ${issue.title}`,
      stage: "issue",
      tone: "todo",
      word: issue.state || "Not started",
      meta: facts,
      at: Number.isFinite(due) ? due : null,
      next:
        ok && soon
          ? { kind: "start", what: "Start", yours: false, button: "Do it", onBranch: false, text: `Start on the Linear issue ${issue.identifier} (${issue.url}). Read it with your Linear tools if you have them, or ask me what it says. Plan the work and show me the plan before you change any code. Then work on a new branch with ${issue.identifier} in its name, in a git worktree of your own, and leave this checkout as it is.` }
          : null,
      sig: `issue:${issue.state_type}`,
      issue: { identifier: issue.identifier, url: issue.url, project: issue.project, title: issue.title },
    });
  }
  return [...out, ...moveSteps(out, repos)];
}

/**
 * A step for each feature whose tickets are behind their merged pull requests: a chat moves them all in Linear, after asking. It
 * names each issue by its identifier and link, and its pull request by repository and number, never by what Linear or GitHub
 * call them.
 */
function moveSteps(items: WorkItem[], repos: RepoStatus[] | null): WorkItem[] {
  const by = new Map<string, WorkItem[]>();
  for (const i of items) {
    if (i.tone !== "move" || !i.issue || !i.repo || !safeIssueId(i.issue.identifier) || !safeIssueUrl(i.issue.url)) continue;
    const k = i.issue.project ?? "";
    by.set(k, [...(by.get(k) ?? []), i]);
  }
  return [...by.entries()].flatMap(([feature, moving]): WorkItem[] => {
    const r = repos?.find((x) => x.repo === moving[0].repo);
    if (!r) return [];
    const ids = moving.map((i) => i.issue!.identifier).sort();
    const listed = moving.map((i) => `${i.issue!.identifier} (${i.issue!.url})${i.number !== null && i.github ? `, ${prRef({ ...r, github: i.github }, i.number)}` : ""}`).join("; ");
    return [
      {
        key: `linear-move:${feature}`,
        repo: r.repo,
        name: short(r),
        github: r.github,
        number: null,
        branch: null,
        title: feature || "issues in no feature",
        stage: "release",
        tone: "move",
        word: `${plural(moving.length, "ticket")} behind ${moving.length === 1 ? "its pull request" : "their pull requests"}`,
        meta: `${short(r)} · ${ids.join(", ")}`,
        at: null,
        next: {
          kind: "move",
          what: "Update Linear for",
          yours: true,
          button: "Update Linear…",
          onBranch: false,
          text: `${plural(moving.length, "Linear issue")} of mine still ${moving.length === 1 ? "says it is" : "say they are"} being worked on, but ${moving.length === 1 ? "its pull request has" : "their pull requests have"} merged: ${listed}. Read each with your Linear tools and check its pull request merged with gh. Move each to the state that follows a merge in its team's workflow (Ready, if the team has it), never to Done. List them with the state you'll set and ask me with request_approval before you change anything in Linear.`,
        },
        // Short (a phone is sent at most 80 characters of it) and changing whenever the tickets behind do.
        sig: `move:${ids.length}:${hash(ids.join(","))}`,
        stepOnly: true,
      },
    ];
  });
}

/** How your Linear issues stand in each project (feature) a repository's work is in: how many are being worked on, and how many
 * not started. */
export function projectsOf(items: WorkItem[], repo: string): { project: string; doing: number; todo: number }[] {
  const by = new Map<string, { doing: Set<string>; todo: number }>();
  for (const i of items) {
    if (i.repo !== repo || !i.issue?.project) continue;
    const p = by.get(i.issue.project) ?? { doing: new Set<string>(), todo: 0 };
    if (i.tone === "done" || i.tone === "ready") continue;
    if (i.tone === "todo") p.todo++;
    else p.doing.add(i.issue.identifier);
    by.set(i.issue.project, p);
  }
  return [...by.entries()].map(([project, p]) => ({ project, doing: p.doing.size, todo: p.todo }));
}

/**
 * What a repository's own page lists: its work, and the Linear issues of a team no Desk project is in (they belong to no repository)
 * that sit in a feature being worked on there, so the feature's board is whole. A feature nothing there is doing leaves them out.
 */
export function workOfRepo(items: WorkItem[], repo: string): WorkItem[] {
  const going = new Set(items.flatMap((i) => (i.repo === repo && i.tone !== "done" && i.issue?.project ? [i.issue.project] : [])));
  return items.filter((i) => i.repo === repo || (i.repo === "" && !!i.issue?.project && going.has(i.issue.project)));
}

export interface FeatureGroup {
  /** The Linear project (feature); null: work in no feature. */
  feature: string | null;
  /** Its items as `whereThingsStand` orders them. */
  items: WorkItem[];
  /** How many of its issues are being worked on, and how many are still to start. */
  doing: number;
  todo: number;
}

/** How where things stand is grouped: by feature (the Linear project), by project (the repository), or not at all. */
export type GroupBy = "feature" | "project" | "none";

export interface WorkGroup {
  /** Stable across refreshes: what a folded group is remembered by. */
  key: string;
  label: string;
  /** Work with no feature: its label is only a stand-in, and it goes last. */
  plain: boolean;
  items: WorkItem[];
  doing: number;
  todo: number;
}

/**
 * Where things stand in groups, the ones with something blocked or yours first (by the most pressing item in each), then by name;
 * work in no feature last. By project a group is a repository; by none there is one group, with no heading.
 */
export function groupWork(items: WorkItem[], by: GroupBy): WorkGroup[] {
  const ordered = whereThingsStand(items);
  const keyOf = (i: WorkItem): { key: string; label: string; plain: boolean } =>
    by === "feature" ? { key: i.issue?.project ?? "", label: i.issue?.project ?? "No feature", plain: !i.issue?.project } : by === "project" ? { key: i.repo || i.name, label: i.name, plain: false } : { key: "", label: "", plain: false };
  const groups = new Map<string, { label: string; plain: boolean; items: WorkItem[] }>();
  for (const i of ordered) {
    const k = keyOf(i);
    const g = groups.get(k.key) ?? { label: k.label, plain: k.plain, items: [] };
    g.items.push(i);
    groups.set(k.key, g);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      ...g,
      doing: new Set(g.items.filter((i) => i.tone !== "todo" && i.tone !== "done" && i.tone !== "ready" && i.issue).map((i) => i.issue!.identifier)).size,
      todo: g.items.filter((i) => i.tone === "todo").length,
    }))
    .sort((a, b) => Number(a.plain) - Number(b.plain) || ordered.indexOf(a.items[0]) - ordered.indexOf(b.items[0]) || a.label.localeCompare(b.label));
}

/** Where things stand by feature (the Linear project its issue is in). */
export function byFeature(items: WorkItem[]): FeatureGroup[] {
  return groupWork(items, "feature").map((g) => ({ feature: g.plain ? null : g.label, items: g.items, doing: g.doing, todo: g.todo }));
}

/** The states a filter offers, in the order shown, with how many items are in each (done included: it is listed, only quieter). */
export const FILTER_TONES: Tone[] = ["bad", "you", "move", "wait", "local", "todo", "ready", "done"];

/** The tabs inside a feature: what needs you, what is moving, what isn't started, and what shipped (the phone has the same four). */
export type Bucket = "attn" | "moving" | "start" | "shipped";
export const BUCKETS: { bucket: Bucket; label: string }[] = [
  { bucket: "attn", label: "Needs you" },
  { bucket: "moving", label: "Moving" },
  { bucket: "start", label: "To start" },
  { bucket: "shipped", label: "Shipped" },
];

/** Which tab an item is under: blocked, your call and needs moving need you; Ready and done, or anything folded, shipped. */
export function bucketOf(item: WorkItem): Bucket {
  if (item.fold) return "shipped";
  switch (item.tone) {
    case "bad":
    case "you":
    case "move":
      return "attn";
    case "todo":
      return "start";
    case "ready":
    case "done":
      return "shipped";
    default:
      return "moving";
  }
}

/** The tab a feature opens on: Needs you when something does, else the first one with anything in it. */
export function openBucket(items: WorkItem[]): Bucket {
  return BUCKETS.find((b) => items.some((i) => bucketOf(i) === b.bucket))?.bucket ?? "attn";
}

/** What needs you in a feature, the most pressing first: your call, then blocked, then a ticket to move. */
const ASK_ORDER: Tone[] = ["you", "bad", "move"];
export const askOf = (items: WorkItem[]): WorkItem[] => items.filter((i) => bucketOf(i) === "attn").sort((a, b) => ASK_ORDER.indexOf(a.tone) - ASK_ORDER.indexOf(b.tone));

export function stateCounts(items: WorkItem[]): Partial<Record<Tone, number>> {
  const n: Partial<Record<Tone, number>> = {};
  for (const i of items) if (!i.stepOnly) n[i.tone] = (n[i.tone] ?? 0) + 1;
  return n;
}

/** Only the items in these states; none chosen shows everything. */
export function filterWork(items: WorkItem[], only: Tone[]): WorkItem[] {
  return only.length === 0 ? items : items.filter((i) => only.includes(i.tone));
}
