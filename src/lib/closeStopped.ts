import type { State } from "../store";
import type { CloseAgreed, CloseCheck } from "../types";
import { nodeStatus, type OrchestraNode } from "./orchestraView";

/** A stopped agent on a team: the agents "Close stopped agents" looks at. */
export interface StoppedAgent {
  slot: string;
  name: string;
}

/** Whether an agent has stopped (on its own, or on an error). One that works, waits for you or is starting is not. */
export function isStopped(state: State | undefined): boolean {
  if (!state) return false;
  const status = nodeStatus(state);
  return status === "ended" || status === "failed";
}

/** The team's agents that have stopped, in canvas order. Never the Lead: only agents it started. */
export function stoppedAgents(nodes: OrchestraNode[], read: (slot: string) => State | undefined): StoppedAgent[] {
  return nodes.filter((n) => n.role === "worker" && isStopped(read(n.slot))).map((n) => ({ slot: n.slot, name: n.name }));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What closing one agent would throw away, short enough for a list: "3 commits", "1 uncommitted file", "3 commits and 2 uncommitted files". */
export function lostBrief(c: CloseCheck): string {
  return [c.unmerged_commits > 0 ? plural(c.unmerged_commits, "commit") : null, c.uncommitted > 0 ? `${plural(c.uncommitted, "uncommitted file")}` : null].filter(Boolean).join(" and ");
}

export const hasWork = (c: CloseCheck) => c.uncommitted > 0 || c.unmerged_commits > 0;

/** An agent with what closing it would lose, as the backend's check says. */
export interface Checked extends StoppedAgent {
  check: CloseCheck;
}

/** What closing does to the agents in the question: an agent whose worktree is already gone has only its branch left to delete. */
export function bulkEffect(risky: Checked[]): string {
  const gone = risky.filter((a) => a.check.gone).length;
  if (gone === 0) return "Closing stops them and deletes their worktrees and branches";
  if (gone === risky.length) return `${risky.length === 1 ? "Its worktree is" : "Their worktrees are"} already gone. Closing stops ${risky.length === 1 ? "it" : "them"} and deletes ${risky.length === 1 ? "its branch" : "their branches"}`;
  return `${gone === 1 ? "1 of them has" : `${gone} of them have`} no worktree left. Closing stops them and deletes their branches, and the worktrees that are still there`;
}

/** What the check of every stopped agent found: those that can go now, those with work to lose, and those that can't be closed at all. */
export interface ClosePlan {
  free: Checked[];
  risky: Checked[];
  /** Agents whose check was refused (its branch is being merged, say), with the reason: they are kept. */
  refused: { name: string; reason: string }[];
}

const reasonOf = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : "it can't be closed right now");

/** Asks what closing each of `agents` would throw away. */
export async function planClosing(agents: StoppedAgent[], closeCheck: (slot: string) => Promise<CloseCheck>): Promise<ClosePlan> {
  const results = await Promise.all(agents.map((a) => closeCheck(a.slot).then((check): Checked => ({ ...a, check }), (e) => ({ ...a, reason: reasonOf(e) }))));
  const plan: ClosePlan = { free: [], risky: [], refused: [] };
  for (const r of results) {
    if ("reason" in r) plan.refused.push({ name: r.name, reason: r.reason });
    else (hasWork(r.check) ? plan.risky : plan.free).push(r);
  }
  return plan;
}

/** The one question for every agent with work to lose, with exactly what each would lose. */
export function riskyQuestion(risky: Checked[]): string {
  const list = risky.map((a) => `${a.name} (${lostBrief(a.check)})`).join(", ");
  return risky.length === 1 ? `1 agent has work that isn't merged: ${list}. Close it anyway?` : `${risky.length} agents have work that isn't merged: ${list}. Close them anyway?`;
}

/** What closing did. */
export interface CloseOutcome {
  closed: number;
  kept: number;
  /** Why some were kept, when it wasn't the user's choice. */
  problems: string[];
}

/**
 * Closes `agents` one at a time with the existing close (each tells the Lead it is gone). An agent that is not stopped any more is
 * left alone. An agent with work is closed with what the user was told it would lose (`agreed`), so one that gained work since is refused, not discarded.
 */
export async function closeAll(
  agents: (StoppedAgent & { agreed?: CloseAgreed })[],
  deps: { closeWorker: (slot: string, agreed?: CloseAgreed) => Promise<void>; stillStopped: (slot: string) => boolean },
): Promise<CloseOutcome> {
  const out: CloseOutcome = { closed: 0, kept: 0, problems: [] };
  for (const a of agents) {
    if (!deps.stillStopped(a.slot)) {
      out.kept++;
      continue;
    }
    try {
      await deps.closeWorker(a.slot, a.agreed);
      out.closed++;
    } catch (e) {
      out.kept++;
      out.problems.push(`${a.name}: ${reasonOf(e)}`);
    }
  }
  return out;
}

/** The line that says what happened: "Closed 4 agents. Kept 1." */
export function closedLine(closed: number, kept: number, problems: string[] = []): string {
  const head = closed === 0 ? "No agents were closed." : `Closed ${plural(closed, "agent")}.`;
  const rest = kept > 0 ? ` Kept ${kept}.` : "";
  const why = problems.length > 0 ? ` ${problems.map((p) => (/[.!?]$/.test(p) ? p : `${p}.`)).join(" ")}` : "";
  return `${head}${rest}${why}`;
}

/** The agent-ready version of the agreed numbers of a check. */
export const agreedOf = (c: CloseCheck): CloseAgreed => ({ uncommitted: c.uncommitted, unmerged_commits: c.unmerged_commits });
