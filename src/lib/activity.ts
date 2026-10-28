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
type HookItem = Extract<ChatItem, { type: "hook" }>;
/** A post-hook and what Claude did for it, shown folded away (open while something in it waits for the user). `waiting`: a prompt in it has no answer yet. */
export type HookRow = { type: "hook"; id: string; text: string; rows: Row[]; waiting: boolean };
export type Row = Exclude<ChatItem, Step | HookItem> | ActivityRow | HookRow;

/**
 * Folds each turn's work (tool calls, the narration between them, answered permissions) into one activity row at
 * the point the work started, like Warp's in-place status. What stays out: what Claude says before its first tool (often
 * the answer to a question, before it goes on to act on it), the reply (the assistant text after the last tool, or else
 * the last text), permission prompts still waiting for an answer, and the turn's closing note.
 * `live` says whether the stream is still running; only its last turn can be. What follows a post-hook, up to the turn's
 * closing note, is folded the same way inside the hook's own row.
 */
export function groupItems(items: ChatItem[], live = false): Row[] {
  const rows: Row[] = [];
  let turn: ChatItem[] = [];
  let hook: { item: HookItem; items: ChatItem[] } | null = null;
  const flush = (last: boolean) => {
    if (hook) {
      rows.push({ type: "hook", id: hook.item.id, text: hook.item.text, rows: foldTurn(hook.items, live && last), waiting: hook.items.some((it) => it.type === "permission" && it.decision === null) });
      hook = null;
    } else rows.push(...foldTurn(turn, live && last));
    turn = [];
  };
  for (const it of items) {
    if (it.type === "user") {
      flush(false);
      rows.push(it);
    } else if (it.type === "hook") {
      // What came before it is the user's turn, as far as it went, or an earlier hook's work (a Stop hook that blocked
      // twice, or one before Lantern's post-hook); this hook's work follows.
      flush(false);
      hook = { item: it, items: [] };
    } else if (hook) {
      // The turn's closing note ends the hook's work (and stays in the conversation, outside the hook's row).
      if (it.type === "turn") {
        flush(false);
        rows.push(it);
      } else hook.items.push(it);
    } else turn.push(it);
  }
  flush(true);
  return rows;
}

/**
 * Whether a row shows the same as before, so it needn't be drawn again. The store keeps an item that hasn't changed as
 * the same object, so most rows are the same object; a turn's activity row is made afresh by each `groupItems`, and is
 * the same when it holds the same items and is as live as it was.
 */
export function sameRow(a: Row, b: Row): boolean {
  if (a === b) return true;
  if (a.type === "hook" && b.type === "hook") return a.id === b.id && a.text === b.text && a.waiting === b.waiting && a.rows.length === b.rows.length && a.rows.every((r, i) => sameRow(r, b.rows[i]));
  if (a.type !== "activity" || b.type !== "activity") return false;
  const same = <T,>(x: T[], y: T[]) => x.length === y.length && x.every((it, i) => it === y[i]);
  return a.id === b.id && a.live === b.live && same(a.steps, b.steps) && same(a.entries, b.entries);
}

/** Cards that stay in the conversation once answered, instead of folding into the turn's activity. */
const KEPT_CARDS = ["ExitPlanMode", "Reproduce", "Approval", "AskUserQuestion"];

function lastIndexWhere<T>(xs: T[], pred: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i--) if (pred(xs[i])) return i;
  return -1;
}

function foldTurn(items: ChatItem[], live: boolean): Row[] {
  const lastTool = lastIndexWhere(items, (it) => it.type === "tool");
  if (lastTool < 0) return items as Row[];
  const replyAfterTools = items.some((it, i) => i > lastTool && it.type === "assistant");
  const reply = replyAfterTools ? -1 : lastIndexWhere(items, (it) => it.type === "assistant");
  // What Claude says before it first acts: often the answer to the user's question, so it stays in the conversation.
  const firstTool = items.findIndex((it) => it.type === "tool");
  const opening = new Set(items.flatMap((it, i) => (i < firstTool && it.type === "assistant" ? [i] : [])));
  const inBlock = (it: ChatItem, i: number) =>
    i <= lastTool && i !== reply && !opening.has(i) && (it.type === "tool" || it.type === "assistant" || (it.type === "permission" && it.decision !== null && !KEPT_CARDS.includes(it.toolName)));
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

export type Category = "read" | "search" | "run" | "skill" | "agent" | "advisor" | "web" | "edit" | "plan" | "reproduce" | "approval" | "network" | "storage" | "mcp" | "other";

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
  mcp__lantern__request_approval: "approval",
  mcp__lantern__network_requests: "network", mcp__lantern__network_request: "network", mcp__lantern__network_watch: "network",
  mcp__lantern__network_unwatch: "network", mcp__lantern__network_watches: "network", mcp__lantern__network_summarize: "network",
  mcp__lantern__storage_scan: "storage", mcp__lantern__storage_results: "storage", mcp__lantern__storage_suggest: "storage",
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
  approval: (n) => (n === 1 ? "asked for your approval" : `asked for your approval ${n} times`),
  network: (n) => (n === 1 ? "used Network Monitor" : `used Network Monitor ${n} times`),
  storage: (n) => (n === 1 ? "checked disk space" : `checked disk space ${n} times`),
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
  if (CATEGORY_OF[step.name] === "network") return `Network Monitor · ${step.name.replace("mcp__lantern__network_", "").replace(/_/g, " ")}`;
  if (CATEGORY_OF[step.name] === "storage") return `Storage · ${step.name.replace("mcp__lantern__storage_", "").replace(/_/g, " ")}`;
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

const VERB: Partial<Record<Category, string>> = { advisor: "Consulting the advisor", read: "Reading", search: "Searching", run: "Running", skill: "Using skill", plan: "Proposing a plan", reproduce: "Waiting for you to reproduce", approval: "Waiting for your approval", network: "Reading Network Monitor", storage: "Checking disk space", agent: "Running subagent:", web: "Fetching", edit: "Editing" };

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
