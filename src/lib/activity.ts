import type { ChatItem, EditInfo, ToolItem } from "../store";
import { relativeTo } from "./diff";
import { serverLabel } from "./complete";

export type Step = ToolItem;
type AssistantItem = Extract<ChatItem, { type: "assistant" }>;
type PermissionItem = Extract<ChatItem, { type: "permission" }>;
/** What the expanded block lists, in order: tool steps, the narration between them, and answered permission prompts. */
export type Entry = Step | AssistantItem | PermissionItem;
/** `live`: the turn is still going, so the block shows what is happening now instead of a summary. */
export type ActivityRow = { type: "activity"; id: string; steps: Step[]; entries: Entry[]; live: boolean };
export type Row = Exclude<ChatItem, Step> | ActivityRow;

/**
 * Folds each turn's work (tool calls, the narration between them, answered permissions) into one activity row at
 * the point the work started, like Warp's in-place status. What stays out: the reply (the assistant text after the
 * last tool, or else the last text), permission prompts still waiting for an answer, and the turn's closing note.
 * `live` says whether the stream is still running; only its last turn can be.
 */
export function groupItems(items: ChatItem[], live = false): Row[] {
  const rows: Row[] = [];
  let turn: ChatItem[] = [];
  const flush = (last: boolean) => {
    rows.push(...foldTurn(turn, live && last));
    turn = [];
  };
  for (const it of items) {
    if (it.type === "user") {
      flush(false);
      rows.push(it);
    } else turn.push(it);
  }
  flush(true);
  return rows;
}

/** Cards that stay in the conversation once answered, instead of folding into the turn's activity. */
const KEPT_CARDS = ["ExitPlanMode", "Reproduce", "AskUserQuestion"];

function lastIndexWhere<T>(xs: T[], pred: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i--) if (pred(xs[i])) return i;
  return -1;
}

function foldTurn(items: ChatItem[], live: boolean): Row[] {
  const lastTool = lastIndexWhere(items, (it) => it.type === "tool");
  if (lastTool < 0) return items as Row[];
  const replyAfterTools = items.some((it, i) => i > lastTool && it.type === "assistant");
  const reply = replyAfterTools ? -1 : lastIndexWhere(items, (it) => it.type === "assistant");
  const inBlock = (it: ChatItem, i: number) =>
    i <= lastTool && i !== reply && (it.type === "tool" || it.type === "assistant" || (it.type === "permission" && it.decision !== null && !KEPT_CARDS.includes(it.toolName)));
  const entries = items.filter(inBlock) as Entry[];
  const steps = entries.filter((e): e is Step => e.type === "tool");
  // Live until the turn is fully done, even while the reply streams: the work line keeps moving until then.
  const block: ActivityRow = { type: "activity", id: `a:${steps[0].id}`, steps, entries, live: live && !items.some((it) => it.type === "turn") };
  const rest = items.filter((it, i) => !inBlock(it, i)) as Row[];
  const at = items.findIndex(inBlock);
  // The block goes where the work began: after anything left out that came first (e.g. a pending prompt).
  const before = rest.filter((r) => items.indexOf(r as ChatItem) < at);
  return [...before, block, ...rest.slice(before.length)];
}

export type Category = "read" | "search" | "run" | "skill" | "agent" | "advisor" | "web" | "edit" | "plan" | "reproduce" | "mcp" | "other";

const CATEGORY_OF: Record<string, Category> = {
  Read: "read", NotebookRead: "read",
  Grep: "search", Glob: "search", LS: "search",
  Bash: "run", BashOutput: "run",
  Skill: "skill",
  Task: "agent", Agent: "agent",
  advisor: "advisor",
  WebFetch: "web", WebSearch: "web",
  Edit: "edit", MultiEdit: "edit", Write: "edit", NotebookEdit: "edit",
  ExitPlanMode: "plan",
  mcp__lantern__reproduce: "reproduce",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const PHRASE: Record<Category, (n: number) => string> = {
  read: (n) => `read ${plural(n, "file")}`,
  search: (n) => `searched ${plural(n, "time")}`,
  run: (n) => `ran ${plural(n, "command")}`,
  skill: (n) => `used ${plural(n, "skill")}`,
  agent: (n) => `ran ${plural(n, "subagent")}`,
  advisor: (n) => (n === 1 ? "consulted the advisor" : `consulted the advisor ${n} times`),
  web: (n) => `made ${plural(n, "web lookup")}`,
  edit: (n) => `made ${plural(n, "edit")}`,
  plan: (n) => (n === 1 ? "proposed a plan" : `proposed ${n} plans`),
  reproduce: (n) => (n === 1 ? "had you reproduce it" : `had you reproduce it ${n} times`),
  // Said per server instead (see summarize).
  mcp: (n) => `used ${plural(n, "MCP tool")}`,
  other: (n) => `used ${plural(n, "other tool")}`,
};

/** An MCP tool call's server and tool as people say them ("Linear", "create issue"); null for other tools. */
export function mcpTool(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m || CATEGORY_OF[name]) return null;
  return { server: serverLabel(m[1]), tool: m[2].replace(/_/g, " ") };
}

export const categoryOf = (step: Step): Category => CATEGORY_OF[step.name] ?? (mcpTool(step.name) ? "mcp" : "other");

/** A step's tool, for its line: an MCP tool by its server and name ("Linear · create issue"). */
export function stepLabel(step: Step): string {
  const mcp = mcpTool(step.name);
  if (step.name === "advisor") return "Advisor";
  return mcp ? `${mcp.server} · ${mcp.tool}` : step.name;
}

/** "Read 4 files, ran 1 command". Applied edits are left out unless asked for: they get their own visible lines. */
export function summarize(steps: Step[], withEdits = false): string {
  const counts = new Map<Category, number>();
  for (const s of steps) {
    if (s.edit && !withEdits) continue;
    const c = categoryOf(s);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  // MCP tools by server, in the order they were used: "used Linear 2 times".
  const servers = new Map<string, number>();
  for (const s of steps) {
    const mcp = mcpTool(s.name);
    if (mcp) servers.set(mcp.server, (servers.get(mcp.server) ?? 0) + 1);
  }
  const text = (Object.keys(PHRASE) as Category[])
    .filter((c) => counts.has(c))
    .flatMap((c) => (c === "mcp" ? [...servers].map(([server, n]) => `used ${server}${n === 1 ? "" : ` ${n} times`}`) : [PHRASE[c](counts.get(c)!)]))
    .join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function failedCount(steps: Step[]): number {
  return steps.filter((s) => s.status === "error").length;
}

export function runningStep(steps: Step[]): ToolItem | null {
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i].status === "running") return steps[i];
  return null;
}

const VERB: Partial<Record<Category, string>> = { advisor: "Consulting the advisor", read: "Reading", search: "Searching", run: "Running", skill: "Using skill", plan: "Proposing a plan", reproduce: "Waiting for you to reproduce", agent: "Running subagent:", web: "Fetching", edit: "Editing" };

export function stepTarget(tool: ToolItem, folder: string | null): string {
  return relativeTo(tool.edit?.path ?? tool.summary, folder);
}

export function describeStep(tool: ToolItem, folder: string | null): string {
  const mcp = mcpTool(tool.name);
  if (mcp) return `Using ${mcp.server}: ${mcp.tool}`;
  const verb = VERB[categoryOf(tool)] ?? tool.name;
  return `${verb} ${stepTarget(tool, folder)}`.trim();
}

/** Every applied edit in these steps, including ones made by subagents. */
export function editsIn(items: ChatItem[]): { id: string; edit: EditInfo }[] {
  return items.flatMap((it) => (it.type === "tool" ? [...(it.edit ? [{ id: it.id, edit: it.edit }] : []), ...editsIn(it.children)] : []));
}
