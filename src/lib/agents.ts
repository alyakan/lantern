import type { ChatItem, ToolItem } from "../store";
import { describeStep, stepLabel } from "./activity";
import { modelName } from "./harness";

/** A subagent in the tree: its Agent step, and what it ran. */
export interface SubagentNode {
  id: string;
  type: string;
  description: string;
  /** The model it ran on (from its messages), else the one it asked for, else null. */
  model: string | null;
  status: ToolItem["status"];
  /** What it's doing now (claude's progress line, or its running step), or how it ended. */
  now: string;
  steps: number;
  tokens: number | null;
  ms: number | null;
}

/** When Claude consulted the advisor, inferred from where in the turn it happened (Claude Code doesn't say why). */
export type AdvisorMoment = "before starting" | "after a failed step" | "before finishing" | "mid-task";

export interface AdvisorCall {
  id: string;
  status: "advising" | "reviewed" | "declined" | "unavailable";
  detail: string | null;
  moment: AdvisorMoment;
}

export interface LogEntry {
  id: string;
  at: number | null;
  /** "main", "advisor", or the subagent's type. */
  agent: string;
  model: string | null;
  text: string;
  status: ToolItem["status"];
}

export interface AgentTree {
  /** The turn's prompt, or null before any. */
  prompt: string | null;
  live: boolean;
  main: { model: string | null; effort: string | null; now: string | null; steps: number };
  advisor: { model: string | null; calls: AdvisorCall[] };
  subagents: SubagentNode[];
  log: LogEntry[];
  /** Every subagent the turn started has ended: the work is back with the main session. */
  back: boolean;
}

const isAgent = (t: ToolItem) => t.name === "Agent" || t.name === "Task";
const steps = (items: ChatItem[]): ToolItem[] => items.flatMap((it) => (it.type === "tool" ? [it] : []));
const allSteps = (items: ChatItem[]): ToolItem[] => steps(items).flatMap((t) => [t, ...allSteps(t.children)]);

/** The latest turn's items: everything after the last prompt. */
function lastTurn(items: ChatItem[]): { prompt: string | null; items: ChatItem[] } {
  const at = items.map((it) => it.type === "user").lastIndexOf(true);
  const prompt = at >= 0 ? items[at] : null;
  return { prompt: prompt?.type === "user" ? prompt.text : null, items: items.slice(at + 1) };
}

/**
 * Where in the turn the advisor was consulted. With times (a live turn), against every step, subagents' included:
 * what had ended before it, what started after. Without (a reopened session), by the main session's order.
 */
function momentOf(turn: ToolItem[], i: number, live: boolean): AdvisorMoment {
  const call = turn[i];
  const work = allSteps(turn).filter((t) => t.name !== "advisor");
  const at = call.startedAt;
  const timed = at !== undefined && work.every((t) => t.startedAt !== undefined);
  const before = timed ? work.filter((t) => t.startedAt! < at!) : turn.slice(0, i).filter((t) => t.name !== "advisor");
  const after = timed ? work.filter((t) => t.startedAt! > at!) : turn.slice(i + 1).filter((t) => t.name !== "advisor");
  // A step failed since the advisor was last consulted (or the turn began): it's about that failure.
  const since = turn.slice(0, i).filter((t) => t.name === "advisor").pop()?.startedAt ?? 0;
  const failed = timed ? work.some((t) => t.status === "error" && t.endedAt !== undefined && t.endedAt > since && t.endedAt <= at!) : before.some((t) => t.status === "error");
  if (failed) return "after a failed step";
  if (!before.some((t) => t.edit || t.name === "Bash" || isAgent(t))) return "before starting";
  if (!live && after.length === 0) return "before finishing";
  return "mid-task";
}

function advisorStatus(t: ToolItem): AdvisorCall["status"] {
  if (t.status === "running") return "advising";
  if (t.summary.startsWith("declined")) return "declined";
  if (t.status === "error" || t.summary.startsWith("unavailable")) return "unavailable";
  return "reviewed";
}

const nowOf = (t: ToolItem, folder: string | null) => {
  if (t.status !== "running") return t.status === "error" ? "Failed" : "Done";
  const running = [...steps(t.children)].reverse().find((c) => c.status === "running");
  return t.agent?.progress?.description || (running ? describeStep(running, folder) : "Starting…");
};

/**
 * The agent tree of the chat's latest turn: the main session, the advisor's consultations, each subagent and what it
 * ran, and a log of who did what. `harness`: what the chat runs with (the advisor's model isn't in the stream).
 */
export function agentTree(items: ChatItem[], opts: { live: boolean; folder: string | null; mainModel: string | null; effort: string | null; advisor: string | null }): AgentTree {
  const { prompt, items: turn } = lastTurn(items);
  const top = steps(turn);
  const running = [...top].reverse().find((t) => t.status === "running" && !isAgent(t) && t.name !== "advisor");
  const subagents = top.filter(isAgent).map((t): SubagentNode => {
    const p = t.agent?.progress;
    return {
      id: t.id,
      type: t.agent?.type ?? "general-purpose",
      description: t.agent?.description || t.summary,
      model: t.agent?.model ?? t.agent?.requested ?? null,
      status: t.status,
      now: nowOf(t, opts.folder),
      steps: Math.max(p?.toolUses ?? 0, allSteps(t.children).length),
      tokens: p?.tokens ?? null,
      ms: p?.durationMs ?? (t.startedAt && t.endedAt ? t.endedAt - t.startedAt : null),
    };
  });
  const waiting = subagents.filter((s) => s.status === "running").length;
  const calls = top.flatMap((t, i): AdvisorCall[] => (t.name === "advisor" ? [{ id: t.id, status: advisorStatus(t), detail: t.summary.match(/\((.*)\)/)?.[1] ?? null, moment: momentOf(top, i, opts.live) }] : []));

  // Who did what, in order: the main session's steps and advisor calls, and each subagent's own steps.
  const log: LogEntry[] = [];
  for (const t of top) {
    if (t.name === "advisor") {
      const c = calls.find((x) => x.id === t.id)!;
      log.push({ id: t.id, at: t.startedAt ?? null, agent: "advisor", model: opts.advisor, text: c.status === "advising" ? "Advising…" : `${c.status}${c.detail ? ` (${c.detail})` : ""} · ${c.moment}`, status: t.status });
    } else if (isAgent(t)) {
      const node = subagents.find((s) => s.id === t.id)!;
      log.push({ id: t.id, at: t.startedAt ?? null, agent: "main", model: opts.mainModel, text: `Started ${node.type}: ${node.description}`, status: "done" });
      for (const c of allSteps(t.children)) log.push({ id: c.id, at: c.startedAt ?? null, agent: node.type, model: node.model, text: `${stepLabel(c)} ${c.summary}`.trim(), status: c.status });
      if (t.status !== "running") log.push({ id: `${t.id}:end`, at: t.endedAt ?? null, agent: node.type, model: node.model, text: t.status === "error" ? "Failed" : "Handed back to main", status: t.status });
    } else {
      log.push({ id: t.id, at: t.startedAt ?? null, agent: "main", model: opts.mainModel, text: `${stepLabel(t)} ${t.summary}`.trim(), status: t.status });
    }
  }
  // Steps keep their order within each agent; across agents, the clock does when it's known.
  log.sort((a, b) => (a.at !== null && b.at !== null ? a.at - b.at : 0));

  return {
    prompt,
    live: opts.live,
    main: {
      model: opts.mainModel,
      effort: opts.effort,
      now: running ? describeStep(running, opts.folder) : waiting ? `Waiting for ${waiting === 1 ? "1 subagent" : `${waiting} subagents`}` : opts.live ? "Thinking…" : null,
      steps: top.length,
    },
    advisor: { model: opts.advisor, calls },
    subagents,
    log,
    back: subagents.length > 0 && subagents.every((s) => s.status !== "running"),
  };
}

/** Whether a turn used anything worth the tree: a subagent or the advisor. */
export const usesAgents = (tree: AgentTree) => tree.subagents.length > 0 || tree.advisor.calls.length > 0;

/** "Haiku" for claude-haiku-5-5, keeping the version: "Haiku 5.5". */
export function shortModel(model: string | null): string | null {
  if (!model) return null;
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model);
  if (m) return `${modelName(m[1])} ${m[2]}${m[3] && m[3].length <= 2 ? `.${m[3]}` : ""}`;
  return modelName(model);
}
