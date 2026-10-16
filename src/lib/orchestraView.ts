import { wakesPaused, type Chats } from "../sessions";
import type { ChatItem, State } from "../store";
import type { ActivityStatus } from "./status";
import type { CloseCheck } from "../types";
import type { AgentRole } from "./roles";

/** What an agent on the canvas is doing, in the words a product owner would use. */
export type NodeStatus = "starting" | "working" | "waiting" | "held" | "idle" | "ended" | "failed";

export const STATUS_LABEL: Record<NodeStatus, string> = {
  starting: "Starting",
  working: "Working",
  waiting: "Needs you",
  held: "Needs you · updates held",
  // Never shown as it is: see statusLabel, which says "Ready" for a lead and "Done" for an agent.
  idle: "Ready",
  ended: "Stopped",
  failed: "Stopped · error",
};

/**
 * What a card or a row says about its agent: "Idle" is "Ready" for the lead (its team is waiting on it) and "Done" for a
 * worker that finished its turn, and a worker whose branch the lead asked the user to merge is "Ready to merge".
 */
export function statusLabel(status: NodeStatus, role: "main" | "worker", readyToMerge = false): string {
  if (status !== "idle") return STATUS_LABEL[status];
  return readyToMerge ? "Ready to merge" : role === "main" ? "Ready" : "Done";
}

export function nodeStatus(s: State): NodeStatus {
  // Its worktree is being set up, or setup stopped and it is the user's to answer: it hasn't started working yet.
  if (s.setup) return s.setup.status === "failed" ? "waiting" : "starting";
  if (s.items.some((it) => it.type === "permission" && it.decision === null)) return "waiting";
  // Stopped is quiet; only one that stopped on an error says so in red.
  if (s.status === "ended") return s.banner?.kind === "error" ? "failed" : "ended";
  if (s.status === "running" || s.thinking) return "working";
  if (s.status === "starting" || s.status === "locating") return "starting";
  // A lead whose workers' updates the loop guard holds back is waiting for the user to say go on (see wakesPaused).
  return wakesPaused(s) ? "held" : "idle";
}

export interface OrchestraNode {
  slot: string;
  role: "main" | "worker";
  /** The main agent this worker reports to (its tether goes there); null for a main agent, and for a worker whose main agent was closed. */
  parent: string | null;
  name: string;
  /** The worker's own branch, when it has a worktree. */
  branch: string | null;
  isolation: "worktree" | "shared" | null;
  /** The role it was started in (a Reviewer, a Builder…), when it has one. */
  agentRole?: AgentRole;
  /** The user took it off the canvas (it is still on the team). Absent: shown. */
  hidden?: boolean;
}

/**
 * Every chat that belongs on the canvas: each main agent, then the workers it started, in the order it started them.
 * A worker whose main agent was closed stays, with no tether. Other chats aren't on the canvas.
 */
export function orchestraNodes(chats: Chats, mainName: (slot: string, s: State) => string): OrchestraNode[] {
  const mains = Object.entries(chats.slots).filter(([, s]) => s.orchestrator).map(([slot]) => slot);
  const nodes: OrchestraNode[] = [];
  const worker = ([slot, meta]: [string, Chats["agents"][string]], parent: string | null): OrchestraNode => ({ slot, role: "worker", parent, name: meta.name, branch: meta.branch, isolation: meta.isolation, ...(meta.role ? { agentRole: meta.role } : {}), ...(meta.hidden ? { hidden: true } : {}) });
  for (const main of mains) {
    nodes.push({ slot: main, role: "main", parent: null, name: mainName(main, chats.slots[main]), branch: null, isolation: null });
    for (const entry of Object.entries(chats.agents)) if (entry[1].parent === main && chats.slots[entry[0]]) nodes.push(worker(entry, main));
  }
  for (const entry of Object.entries(chats.agents)) if (!mains.includes(entry[1].parent) && chats.slots[entry[0]]) nodes.push(worker(entry, null));
  return nodes;
}

/**
 * The main agent of the team the chat `slot` belongs to: itself when it is one, or the main agent a worker reports to. Null
 * for any other chat (and for a worker whose main agent was closed), which has no canvas. The canvas shows one team: the
 * chat on screen's.
 */
export function teamMain(chats: Chats, slot: string): string | null {
  if (chats.slots[slot]?.orchestrator) return slot;
  const parent = chats.agents[slot]?.parent;
  return parent && chats.slots[parent]?.orchestrator ? parent : null;
}

/** The nodes of one team: its main agent and the workers it started. */
export function teamNodes(nodes: OrchestraNode[], main: string): OrchestraNode[] {
  return nodes.filter((n) => n.slot === main || n.parent === main);
}

/**
 * What the title bar says on a team's canvas, in place of the chat on screen's own turn ("Finished" says nothing about
 * the others): how many agents are working, how many need the user, and how many stopped, or "all idle". The Lead counts.
 */
export function teamActivity(nodes: OrchestraNode[], slots: Record<string, State>): ActivityStatus {
  const statuses = nodes.flatMap((n) => (slots[n.slot] ? [nodeStatus(slots[n.slot])] : []));
  const count = (...of: NodeStatus[]) => statuses.filter((s) => of.includes(s)).length;
  const working = count("working", "starting");
  const needYou = needingYou(nodes, slots).length;
  const failed = count("failed");
  const stopped = count("ended");
  const parts = [working && `${working} working`, needYou && `${needYou} ${needYou === 1 ? "needs" : "need"} you`, failed && `${failed} failed`, stopped && `${stopped} stopped`].filter(Boolean);
  return { text: parts.length ? parts.join(", ") : "all idle", detail: null, working: working > 0 };
}

/** The first line of the last thing an agent said at the top level of its chat. */
function lastSaid(items: ChatItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type !== "assistant") continue;
    const line = it.text.split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean);
    if (line) return line;
  }
  return null;
}

/** What an agent's summary card says: its latest words, else the step it is on, else what it was asked. */
export function summaryLine(s: State, max = 160): string {
  const clip = (t: string) => (t.length > max ? `${t.slice(0, max).trimEnd()}…` : t);
  const said = lastSaid(s.items);
  if (said) return clip(said);
  const tool = [...s.items].reverse().find((it): it is Extract<ChatItem, { type: "tool" }> => it.type === "tool");
  if (tool) return clip(`${tool.name} ${tool.summary}`.trim());
  const asked = s.items.find((it) => it.type === "user");
  if (asked?.type === "user") return clip(asked.text.split("\n")[0]);
  return "Waiting to start";
}

/** The workers whose branch the main agent has asked the user to merge, and the user hasn't answered. */
export function readyToMerge(nodes: OrchestraNode[], slots: Record<string, State>): Set<string> {
  return new Set(nodes.filter((n) => n.role === "main").flatMap((n) => (slots[n.slot]?.proposals ?? []).filter((p) => p.status === "open").map((p) => p.worker)));
}

/** The agents that are waiting on the user (a permission prompt, or a merge to approve), in canvas order. */
export function needingYou(nodes: OrchestraNode[], slots: Record<string, State>): string[] {
  const merges = readyToMerge(nodes, slots);
  // A lead whose workers' updates are held back by the loop guard ("held") is waiting for the user to say go on.
  return nodes.filter((n) => slots[n.slot] && (["waiting", "held"].includes(nodeStatus(slots[n.slot])) || merges.has(n.slot))).map((n) => n.slot);
}

/** Dollars for a screen: "$0.42", "$12.30", "<$0.01" for something that cost a little, nothing for nothing. */
export function money(usd: number): string {
  if (usd <= 0) return "";
  if (usd < 0.01) return "<$0.01";
  return `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(usd < 100 ? 1 : 0)}`;
}

/** Tokens for a screen, short: "950 tok", "12k tok", "3.1M tok"; nothing for none. */
export function tokens(n: number): string {
  if (n <= 0) return "";
  const text = n < 1_000 ? `${n}` : n < 1_000_000 ? `${Math.round(n / 1_000)}k` : `${(n / 1_000_000).toFixed(1)}M`;
  return `${text} tok`;
}

/** What an agent (or a team) has used: "$1.20 · 3.1M tok", with whichever is known; nothing when neither is. */
export function usage(usd: number, n: number): string {
  return [money(usd), tokens(n)].filter(Boolean).join(" · ");
}

/** What closing a worker would throw away, in words: "3 uncommitted files and 2 commits that aren't merged". Empty when nothing. */
export function lostText(c: CloseCheck): string {
  const files = c.uncommitted > 0 ? `${c.uncommitted} uncommitted file${c.uncommitted === 1 ? "" : "s"}` : null;
  const commits = c.unmerged_commits > 0 ? (c.unmerged_commits === 1 ? "1 commit that isn't merged" : `${c.unmerged_commits} commits that aren't merged`) : null;
  return [files, commits].filter(Boolean).join(" and ");
}
