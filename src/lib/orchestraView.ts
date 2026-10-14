import { wakesPaused, type Chats } from "../sessions";
import type { ChatItem, State } from "../store";

/** What an agent on the canvas is doing, in the words a product owner would use. */
export type NodeStatus = "starting" | "working" | "waiting" | "idle" | "ended";

export const STATUS_LABEL: Record<NodeStatus, string> = {
  starting: "Starting",
  working: "Working",
  waiting: "Needs you",
  idle: "Idle",
  ended: "Stopped",
};

export function nodeStatus(s: State): NodeStatus {
  if (s.items.some((it) => it.type === "permission" && it.decision === null)) return "waiting";
  if (s.status === "ended") return "ended";
  if (s.status === "running" || s.thinking) return "working";
  if (s.status === "starting" || s.status === "locating") return "starting";
  return "idle";
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
  const worker = ([slot, meta]: [string, Chats["agents"][string]], parent: string | null): OrchestraNode => ({ slot, role: "worker", parent, name: meta.name, branch: meta.branch, isolation: meta.isolation, ...(meta.hidden ? { hidden: true } : {}) });
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
  // A main agent whose workers' updates are held back by the loop guard is waiting for the user to say go on.
  return nodes.filter((n) => slots[n.slot] && (nodeStatus(slots[n.slot]) === "waiting" || merges.has(n.slot) || wakesPaused(slots[n.slot]))).map((n) => n.slot);
}

/** Dollars for a screen: "$0.42", "$12.30", "<$0.01" for something that cost a little, nothing for nothing. */
export function money(usd: number): string {
  if (usd <= 0) return "";
  if (usd < 0.01) return "<$0.01";
  return `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(usd < 100 ? 1 : 0)}`;
}
