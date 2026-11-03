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
 * local: on the Mac only; todo: an issue in Linear not started (no branch or pull request); done: merged and released. */
export type Tone = "bad" | "wait" | "you" | "local" | "todo" | "done";
export const TONE_WORD: Record<Tone, string> = { bad: "blocked", you: "your call", wait: "waiting", local: "local only", todo: "not started", done: "done" };

export type StepKind = "push" | "conflicts" | "checks" | "changes" | "update" | "merge" | "review" | "release" | "publish" | "start";

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
        const s = openStage(r, p);
        out.push({ ...base, key: `${r.repo}:pr:${p.number}`, number: p.number, branch: p.branch, title: p.title, ...s, meta: `${name} · ${p.branch}`, at: null, sig: `${s.stage}:${s.word}` });
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
      out.push({ ...base, key: `${r.repo}:merged:${m.number}`, number: m.number, branch: m.branch, title: m.title, stage: "release", tone: "you", word: "Merged · not released", meta: `${name} · merged ${ago(now, time(m.merged_at))}`, at: time(m.merged_at), next: null, sig: "merged", fold: "ready" });
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

const ORDER: Record<Tone, number> = { you: 0, bad: 1, local: 2, todo: 3, wait: 4, done: 5 };

/** The repositories GitHub answered for without saying who you are: their pull requests can't be told apart, so none are shown. */
export function unknownViewer(repos: RepoStatus[] | null): string[] {
  return (repos ?? []).filter((r) => r.gh === "ready" && !r.viewer).map(short);
}

/** What to do next, yours to decide first, then what is blocked, then branches to push, then issues to start. */
export function nextSteps(items: WorkItem[]): WorkItem[] {
  return items.filter((i) => i.next).sort((a, b) => ORDER[a.tone] - ORDER[b.tone]);
}

/** Every item, blocked first, then yours, on its way, local and done: what's done and branches with nothing to do come last. */
export function whereThingsStand(items: WorkItem[]): WorkItem[] {
  const rank = (i: WorkItem) => ({ bad: 0, you: 1, wait: 2, local: 3, todo: 5, done: 6 })[i.tone] + (i.tone === "local" && !i.next ? 1 : 0);
  return items.filter((i) => !i.stepOnly).sort((a, b) => rank(a) - rank(b) || (b.at ?? 0) - (a.at ?? 0));
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
  const onBranch = item.branch ? repo.folders.filter((f) => f.branch === item.branch).map((f) => f.folder) : [];
  const here = chats.filter((c) => onBranch.includes(c.folder));
  const free = here.find((c) => c.state === "done");
  if (free) return { kind: "chat", slot: free.slot, title: free.title };
  if (here[0]) return { kind: "busy", slot: here[0].slot, title: here[0].title, why: BUSY[here[0].state] };
  const folder = repo.folders[0]?.folder;
  return folder ? { kind: "new", folder } : null;
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
function isIssueOf(issue: LinearIssue, item: WorkItem): boolean {
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
    return [{ ...item, issue: { identifier: issue.identifier, url: issue.url, project: issue.project, title: issue.title }, bare: item.meta, meta: `${tag} · ${item.meta}` }];
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
        tone: "wait",
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
  return out;
}

/** How your Linear issues stand in each project (feature) a repository's work is in: how many are being worked on, and how many
 * not started. */
export function projectsOf(items: WorkItem[], repo: string): { project: string; doing: number; todo: number }[] {
  const by = new Map<string, { doing: Set<string>; todo: number }>();
  for (const i of items) {
    if (i.repo !== repo || !i.issue?.project) continue;
    const p = by.get(i.issue.project) ?? { doing: new Set<string>(), todo: 0 };
    if (i.tone === "done") continue;
    if (i.tone === "todo") p.todo++;
    else p.doing.add(i.issue.identifier);
    by.set(i.issue.project, p);
  }
  return [...by.entries()].map(([project, p]) => ({ project, doing: p.doing.size, todo: p.todo }));
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
      doing: new Set(g.items.filter((i) => i.tone !== "todo" && i.tone !== "done" && i.issue).map((i) => i.issue!.identifier)).size,
      todo: g.items.filter((i) => i.tone === "todo").length,
    }))
    .sort((a, b) => Number(a.plain) - Number(b.plain) || ordered.indexOf(a.items[0]) - ordered.indexOf(b.items[0]) || a.label.localeCompare(b.label));
}

/** Where things stand by feature (the Linear project its issue is in). */
export function byFeature(items: WorkItem[]): FeatureGroup[] {
  return groupWork(items, "feature").map((g) => ({ feature: g.plain ? null : g.label, items: g.items, doing: g.doing, todo: g.todo }));
}

/** The states a filter offers, in the order shown, with how many items are in each (done included: it is listed, only quieter). */
export const FILTER_TONES: Tone[] = ["bad", "you", "wait", "local", "todo", "done"];

export function stateCounts(items: WorkItem[]): Partial<Record<Tone, number>> {
  const n: Partial<Record<Tone, number>> = {};
  for (const i of items) if (!i.stepOnly) n[i.tone] = (n[i.tone] ?? 0) + 1;
  return n;
}

/** Only the items in these states; none chosen shows everything. */
export function filterWork(items: WorkItem[], only: Tone[]): WorkItem[] {
  return only.length === 0 ? items : items.filter((i) => only.includes(i.tone));
}
