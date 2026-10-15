import { basename } from "./diff";
import { modelName } from "./harness";
import { nodeStatus } from "./orchestraView";
import { chatTitle, type Chats } from "../sessions";
import { totalCost, totalTokens, type State } from "../store";

/** What a chat or team is doing, as the usage list says it. */
export type UsageState = "working" | "waiting" | "idle" | "ended";

/** One model's part of what a chat spent, as a share (0 to 1) of its cost, or of its tokens when no cost is known. Null: not known. */
export interface ModelShare {
  name: string;
  share: number | null;
}

/** An open chat, a team's Lead or one of its agents, with what it has used since it started. */
export interface UsageRow {
  slot: string;
  name: string;
  /** The project it is in (its folder's name). */
  project: string;
  state: UsageState;
  /** Dollars, 0 when none is known (a login that isn't billed per use reports none). */
  cost: number;
  tokens: number;
  models: ModelShare[];
  /** A team's Lead and its agents, in canvas order: this row is the team and its figures are the total. */
  members?: UsageRow[];
}

const stateOf = (s: State): UsageState => {
  const status = nodeStatus(s);
  if (status === "working" || status === "starting") return "working";
  if (status === "waiting" || status === "held") return "waiting";
  return status === "idle" ? "idle" : "ended";
};

/** A team is as active as its most active member. */
const teamState = (states: UsageState[]): UsageState => (["working", "waiting", "idle"] as const).find((x) => states.includes(x)) ?? "ended";

/**
 * Who ran on what, from what the latest turn reported per model (main, subagents, advisor), pooled across `states` and
 * grouped by family ("Sonnet", "Opus"), biggest first. A chat that hasn't reported yet says the model it runs on.
 */
export function modelShares(states: State[]): ModelShare[] {
  const by = new Map<string, { cost: number; tokens: number }>();
  for (const s of states)
    for (const u of s.modelUsage) {
      const name = modelName(u.model) ?? u.model;
      const at = by.get(name) ?? { cost: 0, tokens: 0 };
      by.set(name, { cost: at.cost + u.cost_usd, tokens: at.tokens + u.input_tokens + u.output_tokens });
    }
  const byCost = [...by.values()].reduce((sum, v) => sum + v.cost, 0) > 0;
  const weight = (v: { cost: number; tokens: number }) => (byCost ? v.cost : v.tokens);
  const total = [...by.values()].reduce((sum, v) => sum + weight(v), 0);
  if (total > 0)
    return [...by]
      .filter(([, v]) => weight(v) > 0)
      .sort((a, b) => weight(b[1]) - weight(a[1]))
      .map(([name, v]) => ({ name, share: weight(v) / total }));
  const running = [...new Set(states.flatMap((s) => (s.model ? [modelName(s.model) ?? s.model] : [])))];
  return running.map((name) => ({ name, share: null }));
}

/** "Sonnet 62%, Opus 38%"; "<1%" for a sliver, no figure when none is known. */
export function modelLine(models: ModelShare[]): string {
  return models.map((m) => (m.share === null ? m.name : `${m.name} ${m.share < 0.01 ? "<1" : Math.round(m.share * 100)}%`)).join(", ");
}

const rowOf = (slot: string, name: string, s: State): UsageRow => ({ slot, name, project: s.folder ? basename(s.folder) : "", state: stateOf(s), cost: totalCost(s), tokens: totalTokens(s), models: modelShares([s]) });
const used = (r: Pick<UsageRow, "cost" | "tokens" | "state">) => r.cost > 0 || r.tokens > 0 || r.state === "working";

/** Biggest spender first: by cost, then by tokens (all that is known when there are no costs). */
const biggest = (a: UsageRow, b: UsageRow) => b.cost - a.cost || b.tokens - a.tokens;

/**
 * Every open chat and team, in any project, with what it has used since it started, biggest first. A team is one row
 * (its Lead and agents under `members`, its figures their total). Chats that have used nothing and aren't working are left out.
 */
export function usageRows(chats: Chats, titles: Record<string, string> = {}): UsageRow[] {
  const rows: UsageRow[] = [];
  const agentsOf = (lead: string) => Object.entries(chats.agents).filter(([slot, a]) => a.parent === lead && chats.slots[slot]);
  for (const [slot, s] of Object.entries(chats.slots)) {
    const agent = chats.agents[slot];
    if (agent && chats.slots[agent.parent]?.orchestrator) continue;
    if (!s.orchestrator) {
      const row = rowOf(slot, agent?.name ?? chatTitle(s, titles), s);
      if (used(row)) rows.push(row);
      continue;
    }
    const members = [rowOf(slot, "Lead", s), ...agentsOf(slot).map(([id, a]) => rowOf(id, a.name, chats.slots[id]))];
    const team: UsageRow = {
      slot,
      name: s.folder ? `Team · ${basename(s.folder)}` : "Team",
      project: s.folder ? basename(s.folder) : "",
      state: teamState(members.map((m) => m.state)),
      cost: members.reduce((sum, m) => sum + m.cost, 0),
      tokens: members.reduce((sum, m) => sum + m.tokens, 0),
      models: modelShares([s, ...agentsOf(slot).map(([id]) => chats.slots[id])]),
      members: members.sort((a, b) => (a.slot === slot ? -1 : b.slot === slot ? 1 : biggest(a, b))),
    };
    if (members.some(used)) rows.push(team);
  }
  return rows.sort(biggest);
}

/** A team that is working right now, for the warning before a second one starts. */
export interface WorkingTeam {
  name: string;
  /** How many of its agents are working (not counting the Lead). */
  agents: number;
}

/** The teams, in any project, whose Lead or agents are working, except the team of `except` (its Lead's slot). */
export function workingTeams(chats: Chats, except: string | null = null): WorkingTeam[] {
  const teams: WorkingTeam[] = [];
  for (const [slot, s] of Object.entries(chats.slots)) {
    if (!s.orchestrator || slot === except) continue;
    const working = (id: string) => !!chats.slots[id] && nodeStatus(chats.slots[id]) === "working";
    const agents = Object.entries(chats.agents).filter(([id, a]) => a.parent === slot && working(id)).length;
    if (agents > 0 || working(slot)) teams.push({ name: s.folder ? basename(s.folder) : "a team", agents });
  }
  return teams;
}

/** "Another team is working (acme-api, 3 agents). Every agent spends the same plan. Start anyway?" */
export function teamWarning(teams: WorkingTeam[]): string {
  const one = (t: WorkingTeam) => `${t.name}, ${t.agents === 0 ? "its Lead" : t.agents === 1 ? "1 agent" : `${t.agents} agents`}`;
  const who = teams.map(one).join("; ");
  return `${teams.length === 1 ? "Another team is" : "Other teams are"} working (${who}). Every agent spends the same plan. Start anyway?`;
}
