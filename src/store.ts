import type { RevertOutcome } from "./api";
import type { Hunk, ModelCost, ModelOption, Mode, Rule, RuleScope, SlashCommand, UiEvent, TestRun } from "./types";
import { countChanges } from "./lib/diff";
import { readFlavourNote, type Flavour } from "./lib/flavour";
import { readPageNote } from "./lib/pageNote";
import { restoreNoteId, revertSummary, undoOf, undoSummary, type RevertNote, type RevertUndo } from "./lib/revert";
import { KEEP_CHARS, readShellContext, takesShellContext } from "./lib/shell";
import { localUrlIn } from "./lib/localUrl";
import { readSkillNote } from "./lib/skillNote";
import { NO_REVIEW, type ReviewInfo, type ReviewSetting } from "./lib/reviewChain";
import type { Subagents } from "./lib/workflow";

export interface EditInfo {
  path: string;
  created: boolean;
  hunks: Hunk[];
}

/** A subagent's Agent step: what it is, the model it runs on, and what it's doing now. */
export interface AgentInfo {
  /** "Explore", "general-purpose", a custom agent's name. */
  type: string;
  description: string;
  /** The model its messages come from, once one has. */
  model?: string;
  /** The model it asked for, if any. */
  requested?: string | null;
  progress?: { description: string; tokens: number; toolUses: number; durationMs: number };
}

export interface ToolItem {
  type: "tool";
  id: string;
  name: string;
  summary: string;
  status: "running" | "done" | "error";
  output: string | null;
  edit: EditInfo | null;
  children: ChatItem[];
  /** When it started and ended (ms since the epoch), live only: a reopened session doesn't know. */
  startedAt?: number;
  endedAt?: number;
  /** Set on a subagent's Agent (or Task) step. */
  agent?: AgentInfo;
}

/** A command the user ran from the chat box ("!git status"), in the chat's folder, outside claude. */
export interface ShellItem {
  type: "shell";
  id: string;
  command: string;
  /** What it printed, stdout and stderr together; only the end of it once it's long (see KEEP_CHARS). */
  output: string;
  /** "unknown": replayed from a message sent while it still ran; how it ended was never recorded. */
  status: "running" | "done" | "failed" | "stopped" | "unknown";
  code: number | null;
  startedAt: number;
  endedAt?: number;
  /** Went to Claude with a message (see lib/shell.ts). */
  shared: boolean;
  /** It's reading a secret (a password): echo is off in its terminal. */
  secret?: boolean;
}

/** A worker's setup in its new worktree, before its claude starts (see lib/projectSetup.ts): running a line, or stopped at one. */
export interface SetupCard {
  status: "running" | "failed";
  /** The line it is at (from 0) and how many there are. */
  index: number;
  total: number;
  command: string;
  /** What the line printed last. */
  line: string;
  /** Failed: why, and the end of what it printed. */
  reason: string;
  tail: string;
}

/** The project's Run command, started from the Run button in the chat's folder (a command like the ones from the chat box). */
export interface RunTask {
  id: string;
  command: string;
  status: "running" | "stopped" | "failed";
  code: number | null;
  /** The end of what it printed (see KEEP_CHARS). */
  output: string;
  /** The first local address it printed (http://localhost:5173), kept even when the output moves on. */
  url: string | null;
  startedAt: number;
}

export type ChatItem =
  /** `turn`: the backend's number for the turn this prompt started, for that turn's changes (Step-by-step pages). */
  | {
      type: "user";
      id: string;
      text: string;
      turn?: number;
      /** When it was sent, ms since the epoch (unknown for some reopened sessions). */
      at?: number;
      /** Not something the user sent: Claude replied on its own (a background task ended); `text` says why. */
      auto?: boolean;
      /** Step by step: sent with the flavour the user had just picked (Claude was told in a note before the text). */
      switchedTo?: Flavour;
      /** ...with Explain as you go on. */
      explained?: boolean;
      /** Sent from the box: the box's text as an encoded draft, so Edit brings its paste placeholders back (see lib/paste.ts). */
      draft?: string;
      /** Sent by another agent, not typed here: the main agent's message to a worker, or a worker's brief. */
      from?: string;
    }
  | { type: "assistant"; id: string; text: string }
  | ToolItem
  | ShellItem
  /** `autoRule`: a rule allowed it with no card (decision is then "allowed"); `scope` is where that rule applies. */
  | { type: "permission"; id: string; toolName: string; input: unknown; decision: "allowed" | "denied" | null; note?: string; at?: number; autoRule?: { scope: RuleScope; rule: Rule } }
  /** What the turn cost and used (see lib/cost.ts): each null when not known. */
  | { type: "turn"; id: string; isError: boolean; stopped: boolean; result: string | null; durationMs: number | null; denied: number; cost?: number | null; tokens?: number | null };

export interface ChangedFile {
  path: string;
  created: boolean;
  added: number;
  removed: number;
  /** Gone from disk since Claude changed it. */
  deleted?: boolean;
}

export type Status = "locating" | "setup" | "no_folder" | "starting" | "idle" | "running" | "ended";

export interface Banner {
  kind: "error" | "info" | "auth";
  text: string;
  action: "restart" | null;
}

/** A test run in this chat: the Bash step that ran it, and what it found. */
export interface TestRunItem {
  id: string;
  command: string;
  run: TestRun;
}

/** A worker's branch the main agent asked the user to merge, and how that stands. */
export interface MergeProposal {
  worker: string;
  name: string;
  branch: string;
  into: string;
  summary: string;
  commits: number;
  files: { path: string; added: number; removed: number }[];
  /** Loose work in the worker's worktree, which approving commits first. */
  uncommitted: number;
  /** The loose files' names: what approving commits on top of the branch before it is merged. */
  loose: string[];
  status: "open" | "merged" | "declined";
  /** Why the last approval didn't merge (conflicting files, a dirty checkout); the proposal stays open to try again. */
  problem: string | null;
  /** How many times the backend has answered an approval: an attempt that fails the same way twice is still an answer. */
  attempts: number;
  /** When it arrived (ms): a card drawn soon after is one that just came, and says so. */
  at?: number;
}

export interface State {
  status: Status;
  /** This chat is the main agent of an orchestra: it can start workers. */
  orchestrator: boolean;
  /** Notes from Lantern for the main agent (a worker finished, crashed or waits on the user), sent when it is idle. */
  wakes: string[];
  /** Automatic turns in a row (from those notes) with nothing from the user between: the loop guard counts them. */
  autoStreak: number;
  /** The merges the main agent asked for, oldest first. */
  proposals: MergeProposal[];
  /** A Team's "Review and test what an agent builds" setting, as its Lead shows it (kept with the team). */
  review: ReviewSetting;
  /** Where the review and test of each builder's latest work stands, by builder (the Lead's). */
  reviews: ReviewInfo[];
  /** What Claude last set the Changes pane to compare with review_target, as Lantern was told live (a reopened chat has none until it calls it again; see reviewTargetOf). */
  reviewTarget: { pr: number | null; base: string | null } | null;
  /**
   * What this chat has cost in dollars: `costBase` from claude processes that have since ended (a restart starts the
   * count again), plus `costSeen`, the running total the current one last reported (claude's total_cost_usd counts the
   * whole process, not each turn). See `totalCost`.
   */
  costBase: number;
  costSeen: number;
  /** Tokens from claude processes that have since ended, as `costBase` is for cost; `sessionTokens` is the current one's. */
  tokenBase: number;
  /** Messages typed while Claude works, sent together when the turn ends. Per chat, so a background chat keeps its own. */
  queued: string[];
  claudePath: string | null;
  setupError: string | null;
  folder: string | null;
  sessionId: string | null;
  /** Tokens the conversation takes up, and the model's context window once a turn has reported it. */
  contextUsed: number | null;
  /** What the chat box offers after "/"; from claude when its process starts. */
  commands: SlashCommand[];
  /** The models claude offers, for the model menu. */
  models: ModelOption[];
  /** The MCP tools claude can use this session ("mcp__server__tool"). */
  mcpTools: string[];
  /** What the last turn cost per model (main, subagents', advisor's). */
  modelUsage: ModelCost[];
  /** The claude process's running totals (what the session has cost and used so far), null until a turn reports. */
  sessionCost: number | null;
  sessionTokens: number;
  /** /clear just emptied the conversation; its turn's end adds no marker. */
  cleared: boolean;
  contextWindow: number | null;
  mode: Mode;
  /** Permissions Auto on the Step by step workflow (the other workflows say it with `mode`): see `permissionsOf`. */
  autoApprove: boolean;
  /** A Team's Subagents setting, as its Lead shows it: where the Lead's built-in helpers run. */
  subagents: Subagents;
  /** Step by step: a flavour picked from the header and not yet sent (it goes with the next message). */
  flavourPick: Flavour | null;
  /** ...and whether Explain as you go is on with it (Build and Debug). */
  explainPick: boolean;
  /** Step by step: the flavour an older session was in, when its mode was Debug, Teach or Review. */
  flavourStart: Flavour | null;
  /** ...and Explain as you go, which a Teach session had on. */
  explainStart: boolean;
  model: string | null;
  items: ChatItem[];
  changedFiles: ChangedFile[];
  /** Every test run in the conversation, oldest first. */
  testRuns: TestRunItem[];
  editCount: number;
  selectedFile: string | null;
  lastEdited: string | null;
  follow: boolean;
  thinking: boolean;
  /** When Claude last said or did anything (any event from its run): how long a working agent has been quiet. */
  activityAt: number | null;
  banner: Banner | null;
  stopRequested: boolean;
  /** A worker the main agent stopped (stop_agent), until it is restarted: it isn't brought back at launch. */
  leadStopped: boolean;
  debug: string[];
  seq: number;
  /** What claude runs in the background (a command with run_in_background, a background agent), and since when. */
  backgroundTasks: BackgroundTask[];
  /** The background task that ended last, for the note on a reply Claude starts about it. */
  lastEndedTask: string | null;
  /** Steps that started a background task, by tool call: still running, or how they ended. */
  backgroundRuns: Record<string, BackgroundRun>;
  /** The last revert, which Undo can take back until the next message or quit. */
  revertUndo: RevertUndo | null;
  /** The last "Restore files to here", which Undo can take back until the next message or quit. */
  restoreUndo: { id: number; summary: string } | null;
  /** Files reverted since the last message, which Claude is told about with the next one. */
  revertNotes: RevertNote[];
  revertSeq: number;
  /** The folder this session was started in, when that was a place the folder moved from: Claude is told once. */
  movedFrom: string | null;
  /** The project's notes this chat was started with (null: none), shown at the top as "Project notes applied". */
  notesApplied: string | null;
  /** A worker whose worktree is being set up before it starts, or whose setup stopped and waits for the user. */
  setup: SetupCard | null;
  /** The project's Run command in this chat, as it was last started. */
  run: RunTask | null;
}

export interface BackgroundRun {
  /** "running", then claude's word for how it ended: "completed", "failed", "killed"… */
  status: string;
  /** How it ended, in claude's words ("Background command … completed (exit code 0)"). */
  summary?: string;
}

export interface BackgroundTask {
  id: string;
  /** claude's task type: "local_bash", "local_agent", … */
  taskType: string;
  description: string;
  /** When it was first listed (ms since the epoch). */
  since: number;
}

/** What the chat has cost so far, across restarts of its claude. */
export const totalCost = (s: Pick<State, "costBase" | "costSeen">) => s.costBase + s.costSeen;
/** Every token this chat's claude processes have read and written, its advisor's calls included. */
export const totalTokens = (s: Pick<State, "tokenBase" | "sessionTokens">) => s.tokenBase + s.sessionTokens;

export const initialState: State = {
  status: "locating",
  orchestrator: false,
  wakes: [],
  autoStreak: 0,
  proposals: [],
  review: NO_REVIEW,
  reviews: [],
  reviewTarget: null,
  costBase: 0,
  costSeen: 0,
  tokenBase: 0,
  queued: [],
  claudePath: null,
  setupError: null,
  folder: null,
  sessionId: null,
  contextUsed: null,
  commands: [],
  models: [],
  mcpTools: [],
  modelUsage: [],
  sessionCost: null,
  sessionTokens: 0,
  cleared: false,
  contextWindow: null,
  mode: "ask",
  autoApprove: false,
  subagents: "canvas",
  flavourPick: null,
  explainPick: false,
  flavourStart: null,
  explainStart: false,
  model: null,
  items: [],
  changedFiles: [],
  testRuns: [],
  editCount: 0,
  selectedFile: null,
  lastEdited: null,
  follow: true,
  thinking: false,
  activityAt: null,
  banner: null,
  stopRequested: false,
  leadStopped: false,
  debug: [],
  seq: 0,
  backgroundTasks: [],
  lastEndedTask: null,
  backgroundRuns: {},
  revertUndo: null,
  restoreUndo: null,
  revertNotes: [],
  revertSeq: 0,
  movedFrom: null,
  notesApplied: null,
  setup: null,
  run: null,
};

export type Action =
  | { type: "ui_event"; event: UiEvent }
  | { type: "claude_found"; path: string }
  | { type: "claude_missing"; error: string }
  | { type: "folder_opened"; folder: string }
  | { type: "folder_cleared" }
  | { type: "history_loaded"; sessionId: string; events: UiEvent[]; movedFrom?: string | null }
  | { type: "session_ready" }
  /** The chat started with the project's notes: what it was told (after the chat opened, so the open doesn't clear it). */
  | { type: "notes_applied"; text: string | null }
  /** `auto`: sent by Lantern from agents' notes, not typed by the user. */
  | { type: "user_sent"; text: string; switchedTo?: Flavour; explained?: boolean; draft?: string; auto?: boolean }
  | { type: "wakes_taken" }
  | { type: "orchestrator_set"; on: boolean }
  /** `autoApprove`: Step by step's Permissions (kept as it is when absent; other modes say it with the mode). */
  | { type: "mode_changed"; mode: Mode; autoApprove?: boolean; flavourStart?: Flavour | null; explainStart?: boolean }
  | { type: "subagents_set"; subagents: Subagents }
  | { type: "review_set"; review: ReviewSetting }
  | { type: "flavour_picked"; flavour: Flavour | null; explain?: boolean }
  | { type: "permission_decided"; id: string; allow: boolean; note?: string }
  | { type: "stop_requested" }
  | { type: "restarting" }
  | { type: "select_file"; path: string }
  | { type: "follow_latest" }
  | { type: "failed"; text: string }
  | { type: "turn_failed"; text: string }
  | { type: "stop_failed"; text: string }
  | { type: "dismiss_banner" }
  | { type: "queue_set"; items: string[] }
  | { type: "shell_started"; id: string; command: string }
  /** The Run button was pressed: the run starts (its output arrives as shell events with this id). */
  | { type: "run_started"; id: string; command: string }
  /** The Run panel was closed (a run that is still going is stopped by the caller). */
  | { type: "run_closed" }
  /** The backend numbered the turn the latest prompt started. */
  | { type: "turn_numbered"; turn: number }
  | { type: "revert_done"; since: string; outcomes: RevertOutcome[] }
  | { type: "revert_undone"; id: number; outcomes: RevertOutcome[] }
  /** The folder was put back to before a message: `id` is what Undo is asked with (null: it can't be undone). */
  | { type: "restore_done"; id: number | null; since: string; summary: string; files: { path: string; trashed: boolean }[] }
  | { type: "restore_undone"; id: number; text: string }
  | { type: "notice"; text: string }
  /** The changed files as they stand on disk (from the backend): true counts, and files back to their original gone. */
  | { type: "changes_synced"; files: ChangedFile[] };

function containsTool(items: ChatItem[], id: string): boolean {
  return items.some((it) => it.type === "tool" && (it.id === id || containsTool(it.children, id)));
}

function mapTools(items: ChatItem[], id: string, fn: (t: ToolItem) => ToolItem): ChatItem[] {
  return items.map((it): ChatItem => {
    if (it.type !== "tool") return it;
    if (it.id === id) return fn(it);
    return { ...it, children: mapTools(it.children, id, fn) };
  });
}

function insert(items: ChatItem[], parent: string | null, item: ChatItem): ChatItem[] {
  if (parent && containsTool(items, parent)) return mapTools(items, parent, (t) => ({ ...t, children: [...t.children, item] }));
  return [...items, item];
}

function containsAssistant(items: ChatItem[], id: string): boolean {
  return items.some((it) => (it.type === "assistant" && it.id === id) || (it.type === "tool" && containsAssistant(it.children, id)));
}

function mapAssistant(items: ChatItem[], id: string, fn: (text: string) => string): ChatItem[] {
  return items.map((it): ChatItem => {
    if (it.type === "assistant" && it.id === id) return { ...it, text: fn(it.text) };
    if (it.type === "tool") return { ...it, children: mapAssistant(it.children, id, fn) };
    return it;
  });
}

function upsertText(items: ChatItem[], parent: string | null, blockId: string, fn: (text: string) => string): ChatItem[] {
  if (containsAssistant(items, blockId)) return mapAssistant(items, blockId, fn);
  return insert(items, parent, { type: "assistant", id: blockId, text: fn("") });
}

function failRunning(items: ChatItem[]): ChatItem[] {
  return items.map((it): ChatItem =>
    it.type === "tool" ? { ...it, status: it.status === "running" ? "error" : it.status, children: failRunning(it.children) } : it,
  );
}

// A permission nobody answered can't be answered once claude is gone or stopping: denied, so the chat isn't left waiting.
function denyPending(items: ChatItem[]): ChatItem[] {
  return items.map((it): ChatItem => (it.type === "permission" && it.decision === null ? { ...it, decision: "denied" } : it));
}

function addChange(files: ChangedFile[], path: string, created: boolean, hunks: Hunk[]): ChangedFile[] {
  const { added, removed } = countChanges(hunks);
  if (!files.some((f) => f.path === path)) return [...files, { path, created, added, removed }];
  return files.map((f) => (f.path === path ? { ...f, created: f.created || created, added: f.added + added, removed: f.removed + removed } : f));
}

// A replayed step whose result isn't in the transcript (e.g. the session was interrupted) shouldn't spin forever.
function settleRunning(items: ChatItem[]): ChatItem[] {
  return items.map((it): ChatItem =>
    it.type === "tool" ? { ...it, status: it.status === "running" ? "done" : it.status, children: settleRunning(it.children) } : it,
  );
}

// Replayed steps were all "started" at load time: not when they ran.
function withoutTimes(items: ChatItem[]): ChatItem[] {
  return items.map((it): ChatItem => (it.type === "tool" ? { ...it, startedAt: undefined, endedAt: undefined, children: withoutTimes(it.children) } : it));
}

// An empty conversation for `folder`, as after opening it.
function freshSession(state: State, folder: string | null): State {
  return { ...state, folder, sessionId: null, contextUsed: null, queued: [], status: "starting", flavourPick: null, explainPick: false, flavourStart: null, explainStart: false, items: [], changedFiles: [], testRuns: [], editCount: 0, selectedFile: null, lastEdited: null, follow: true, banner: null, model: null, thinking: false, backgroundTasks: [], backgroundRuns: {}, modelUsage: [], sessionCost: null, sessionTokens: 0, lastEndedTask: null, stopRequested: false, leadStopped: false, cleared: false, revertUndo: null, restoreUndo: null, revertNotes: [], movedFrom: null, notesApplied: null, setup: null, run: null, wakes: [], autoStreak: 0, proposals: [], reviews: [], reviewTarget: null, costBase: 0, costSeen: 0, tokenBase: 0 };
}

// Claude replying with no prompt from here (a background task ended and it reports back) is a turn like any other,
// opened by a note in place of a prompt.
function wake(state: State): State {
  if (state.status !== "idle") return state;
  const seq = state.seq + 1;
  const text = state.lastEndedTask ? `After ${state.lastEndedTask} ended` : "Claude followed up on its own";
  return { ...state, status: "running", seq, lastEndedTask: null, items: [...state.items, { type: "user", id: `u${seq}`, text, at: Date.now(), auto: true }] };
}

/** The ids of the shells the Run button starts (the backend only runs those with this start as the project's Run command). */
export const RUN_PREFIX = "run-";

function mapShell(items: ChatItem[], id: string, fn: (s: ShellItem) => ShellItem): ChatItem[] {
  return items.map((it) => (it.type === "shell" && it.id === id ? fn(it) : it));
}

const isPlanFile = (path: string) => /\/\.claude\/plans\/[^/]+\.md$/.test(path);

function lastLine(text: string): string {
  return text.trim().split("\n").filter(Boolean).pop() ?? "";
}

function applyEvent(state: State, ev: UiEvent): State {
  switch (ev.kind) {
    case "session_started":
      return { ...state, model: ev.model, sessionId: ev.session_id, status: state.status === "starting" ? "idle" : state.status };
    case "user_text": {
      const seq = state.seq + 1;
      const sent = readShellContext(ev.text);
      const read = readFlavourNote(readPageNote(sent.text));
      const { flavour, explain } = read;
      const text = readSkillNote(read.text);
      const at = ev.at ?? 0;
      const shells = sent.shells.map((s, i): ShellItem => ({ type: "shell", id: `sh-u${seq}-${i}`, command: s.command, output: s.output, status: s.stopped ? "stopped" : s.running ? "unknown" : s.code ? "failed" : "done", code: s.code, startedAt: at, endedAt: at, shared: true }));
      // Commands alone (Claude Code's own `!` mode writes them so): no prompt to show after them.
      if (shells.length > 0 && !text.trim()) return { ...state, seq, items: [...state.items, ...shells] };
      return { ...state, seq, items: [...state.items, ...shells, { type: "user", id: `u${seq}`, text, at: ev.at, ...(flavour ? { switchedTo: flavour, ...(explain ? { explained: true } : {}) } : {}) }] };
    }
    case "shell_output":
      if (ev.id.startsWith(RUN_PREFIX)) {
        if (state.run?.id !== ev.id) return state;
        const output = (state.run.output + ev.text).slice(-KEEP_CHARS);
        return { ...state, run: { ...state.run, output, url: state.run.url ?? localUrlIn(ev.text) ?? localUrlIn(output) } };
      }
      return { ...state, items: mapShell(state.items, ev.id, (s) => ({ ...s, output: (s.output + ev.text).slice(-KEEP_CHARS) })) };
    case "shell_done":
      if (ev.id.startsWith(RUN_PREFIX)) {
        return state.run?.id === ev.id ? { ...state, run: { ...state.run, status: ev.stopped || ev.code === 0 ? "stopped" : "failed", code: ev.code } } : state;
      }
      return {
        ...state,
        items: mapShell(state.items, ev.id, (s) => ({ ...s, status: ev.stopped ? "stopped" : ev.code === 0 ? "done" : "failed", code: ev.code, endedAt: Date.now(), secret: false })),
      };
    case "shell_secret":
      if (ev.id.startsWith(RUN_PREFIX)) return state;
      return { ...state, items: mapShell(state.items, ev.id, (s) => ({ ...s, secret: ev.secret })) };
    case "thinking":
      return { ...wake(state), thinking: true };
    case "text_delta": {
      const s = wake(state);
      return { ...s, thinking: false, items: upsertText(s.items, ev.parent, ev.block_id, (t) => t + ev.text) };
    }
    case "assistant_text": {
      const s = wake(state);
      return { ...s, thinking: false, items: upsertText(s.items, ev.parent, ev.block_id, () => ev.text) };
    }
    case "tool_started": {
      const s = wake(state);
      return {
        ...s,
        thinking: false,
        items: insert(s.items, ev.parent, { type: "tool", id: ev.tool_use_id, name: ev.name, summary: ev.summary, status: "running", output: null, edit: null, children: [], startedAt: Date.now() }),
      };
    }
    // In plan mode Claude writes its plan to ~/.claude/plans; that's not a change to the project.
    case "edit_applied":
      if (isPlanFile(ev.path)) return state;
      return {
        ...state,
        editCount: state.editCount + 1,
        changedFiles: addChange(state.changedFiles, ev.path, ev.created, ev.hunks),
        lastEdited: ev.path,
        selectedFile: state.follow ? ev.path : state.selectedFile,
        items: mapTools(state.items, ev.tool_use_id, (t) => ({ ...t, edit: { path: ev.path, created: ev.created, hunks: ev.hunks } })),
      };
    case "tool_finished":
      return { ...state, items: mapTools(state.items, ev.tool_use_id, (t) => ({ ...t, status: ev.is_error ? "error" : "done", output: ev.output, endedAt: Date.now() })) };
    case "agent_started":
      return { ...state, items: mapTools(state.items, ev.tool_use_id, (t) => ({ ...t, agent: { ...t.agent, type: ev.subagent_type, description: ev.description, requested: ev.model } })) };
    case "agent_model":
      // The main thread's: what the chat runs on now (the model menu names it).
      if (!ev.parent) return { ...state, model: ev.model };
      return { ...state, items: mapTools(state.items, ev.parent, (t) => ({ ...t, agent: { type: "general-purpose", description: "", ...t.agent, model: ev.model } })) };
    case "agent_progress":
      return {
        ...state,
        items: mapTools(state.items, ev.tool_use_id, (t) => ({ ...t, agent: { type: "general-purpose", description: "", ...t.agent, progress: { description: ev.description, tokens: ev.tokens, toolUses: ev.tool_uses, durationMs: ev.duration_ms } } })),
      };
    // The advisor is a step like any other in the turn's work: running while it's consulted, then what it said.
    case "advisor_started": {
      const s = wake(state);
      return { ...s, thinking: false, items: insert(s.items, ev.parent, { type: "tool", id: ev.id, name: "advisor", summary: "", status: "running", output: null, edit: null, children: [], startedAt: Date.now() }) };
    }
    case "advisor_done": {
      const summary = ev.outcome === "unavailable" ? `unavailable${ev.error_code ? ` (${ev.error_code})` : ""}` : ev.outcome;
      return { ...state, items: mapTools(state.items, ev.id, (t) => ({ ...t, summary, status: ev.outcome === "unavailable" ? "error" : "done", endedAt: Date.now() })) };
    }
    case "model_usage":
      return { ...state, modelUsage: ev.models };
    case "test_run": {
      const run: TestRunItem = { id: ev.tool_use_id, command: ev.command, run: ev.run };
      const others = state.testRuns.filter((r) => r.id !== run.id);
      return { ...state, testRuns: [...others, run] };
    }
    case "retrying":
      return { ...state, banner: { kind: "info", text: `Retrying (${ev.attempt}/${ev.max_retries}): ${ev.error}`, action: null } };
    case "context_used":
      return { ...state, contextUsed: ev.tokens };
    case "task_started":
      return ev.tool_use_id ? { ...state, backgroundRuns: { ...state.backgroundRuns, [ev.tool_use_id]: { status: "running" } } } : state;
    case "task_ended":
      return ev.tool_use_id ? { ...state, backgroundRuns: { ...state.backgroundRuns, [ev.tool_use_id]: { status: ev.status || "completed", summary: ev.summary } } } : state;
    case "background_tasks": {
      const since = new Map(state.backgroundTasks.map((t) => [t.id, t.since]));
      const ended = state.backgroundTasks.filter((t) => !ev.tasks.some((n) => n.id === t.id)).pop();
      return { ...state, lastEndedTask: ended ? ended.description || "a background task" : state.lastEndedTask, backgroundTasks: ev.tasks.map((t) => ({ id: t.id, taskType: t.task_type, description: t.description, since: since.get(t.id) ?? Date.now() })) };
    }
    case "commands":
      return { ...state, commands: ev.commands };
    case "models":
      return { ...state, models: ev.models };
    case "mcp_tools":
      return { ...state, mcpTools: ev.tools };
    // /clear: a new conversation in the same folder. Changed files stay listed; the edits are still on disk.
    case "conversation_reset":
      return { ...state, items: [], sessionId: null, contextUsed: null, thinking: false, cleared: true, reviewTarget: null };
    case "turn_done": {
      const banner: Banner | null = ev.auth_hint
        ? { kind: "auth", text: "Claude isn't logged in. Run `claude /login` in a terminal, then send your message again.", action: null }
        : state.banner?.kind === "info"
          ? null
          : state.banner;
      const seq = state.seq + 1;
      // A total lower than the last one is a claude that started over (a restart): what the earlier one cost is kept.
      const reported = ev.cost_usd;
      const restarted = reported !== null && reported < state.costSeen;
      const tokens = ev.session_tokens ?? state.sessionTokens;
      return {
        ...state,
        status: "idle",
        thinking: false,
        banner,
        seq,
        costBase: restarted ? state.costBase + state.costSeen : state.costBase,
        costSeen: reported ?? state.costSeen,
        contextWindow: ev.context_window ?? state.contextWindow,
        // The turn that ran /clear ends in an empty conversation; a marker alone would leave a blank chat, not the start screen.
        cleared: false,
        items: state.cleared ? state.items : [...state.items, { type: "turn", id: `t${seq}`, isError: ev.is_error && !state.stopRequested, stopped: state.stopRequested, result: ev.is_error ? ev.result : null, durationMs: ev.duration_ms, denied: ev.denied, cost: ev.cost_usd, tokens: ev.tokens ?? null }],
        ...(ev.session_cost_usd != null ? { sessionCost: ev.session_cost_usd } : {}),
        sessionTokens: tokens,
        tokenBase: tokens < state.sessionTokens ? state.tokenBase + state.sessionTokens : state.tokenBase,
      };
    }
    case "permission_requested":
      return { ...state, items: [...state.items, { type: "permission", id: ev.request_id, toolName: ev.tool_name, input: ev.input, decision: null, at: Date.now() }] };
    case "permission_auto_allowed":
      return {
        ...state,
        items: [...state.items, { type: "permission", id: ev.request_id, toolName: ev.tool_name, input: ev.input, decision: "allowed", autoRule: { scope: ev.scope, rule: ev.rule } }],
      };
    case "permission_withdrawn":
      return {
        ...state,
        items: state.items.map((it): ChatItem => (it.type === "permission" && it.id === ev.request_id && it.decision === null ? { ...it, decision: "denied" } : it)),
      };
    case "session_ended": {
      const detail = lastLine(ev.stderr_tail);
      const text = `Claude stopped unexpectedly${ev.code === null ? "" : ` (exit code ${ev.code})`}.${detail ? ` ${detail}` : ""}`;
      return {
        ...state,
        status: "ended",
        thinking: false,
        backgroundTasks: [],
        items: denyPending(failRunning(state.items)),
        banner: state.stopRequested ? state.banner : { kind: "error", text, action: "restart" },
      };
    }
    case "agent_setup": {
      // Nothing is thinking while it sets up: the worker's claude starts when setup is done.
      if (ev.phase === "done") return state.setup ? { ...state, setup: null, thinking: true } : state;
      if (ev.phase === "failed") return { ...state, thinking: false, setup: { status: "failed", index: ev.index, total: ev.total, command: ev.command, line: "", reason: ev.reason, tail: ev.tail } };
      // A line starting names its command; a progress line after it only says what it printed.
      const before = state.setup?.status === "running" ? state.setup : null;
      return { ...state, thinking: false, setup: { status: "running", index: ev.index, total: ev.total, command: ev.command || before?.command || "", line: ev.command ? "" : ev.line, reason: "", tail: "" } };
    }
    case "agent_wake":
      return { ...state, wakes: [...state.wakes, ev.text] };
    // The main agent wrote to this worker: it shows as a message from it, and the worker is at work on it.
    case "agent_message": {
      const seq = state.seq + 1;
      return { ...state, seq, stopRequested: false, leadStopped: false, status: state.status === "idle" ? "running" : state.status, thinking: state.status === "idle" || state.thinking, items: [...state.items, { type: "user", id: `u${seq}`, text: ev.text, at: Date.now(), from: ev.from }] };
    }
    // Stopped by the main agent, which is a decision of its own: the user's earlier Stop (if any) must not turn it into a
    // restart (the app restarts a chat that ended after the user pressed Stop).
    case "agent_stopped":
      return {
        ...state,
        status: "ended",
        thinking: false,
        stopRequested: false,
        leadStopped: true,
        items: denyPending(failRunning(state.items)),
        banner: ev.reason ? { kind: "error", text: ev.reason, action: null } : { kind: "info", text: "The Lead stopped this agent. Restart it to carry on.", action: "restart" },
      };
    // Lantern closed it after it reported on a builder's work: nothing to restart, and it isn't brought back with the team.
    case "agent_tidied":
      return {
        ...state,
        status: "ended",
        thinking: false,
        stopRequested: false,
        leadStopped: true,
        items: denyPending(failRunning(state.items)),
        banner: { kind: "info", text: "Lantern closed this agent after it reported, and removed its copy of the code. What it said is above.", action: null },
      };
    case "review_update": {
      const info: ReviewInfo = { builder: ev.builder, name: ev.name, commit: ev.commit, checks: ev.checks, done: ev.done, at: Date.now() };
      return { ...state, reviews: [...state.reviews.filter((r) => r.builder !== ev.builder), info] };
    }
    // The main agent's mode was lowered, so this worker's was too (its claude restarted on the same conversation).
    case "agent_mode":
      return { ...state, mode: ev.mode, autoApprove: ev.mode === "steps" ? state.autoApprove : false };
    case "review_target":
      return { ...state, reviewTarget: { pr: ev.pr, base: ev.base } };
    case "merge_proposed": {
      const proposal: MergeProposal = { worker: ev.worker, name: ev.name, branch: ev.branch, into: ev.into, summary: ev.summary, commits: ev.commits, files: ev.files, uncommitted: ev.uncommitted, loose: ev.loose, status: "open", problem: null, attempts: 0, at: Date.now() };
      return { ...state, proposals: [...state.proposals.filter((p) => p.worker !== ev.worker), proposal] };
    }
    case "merge_resolved":
      return {
        ...state,
        proposals: state.proposals.map((p): MergeProposal => {
          if (p.worker !== ev.worker) return p;
          const answered = { attempts: p.attempts + 1 };
          if (ev.outcome === "merged") return { ...p, ...answered, status: "merged", problem: null };
          if (ev.outcome === "declined") return { ...p, ...answered, status: "declined", problem: null };
          // Not what the user was shown any more: the card goes, saying why.
          if (ev.outcome === "changed") return { ...p, ...answered, status: "declined", problem: ev.detail };
          return { ...p, ...answered, problem: ev.outcome === "conflicts" ? `Conflicts with ${p.into} in ${ev.detail}.` : ev.detail };
        }),
      };
    case "unknown":
      return { ...state, debug: [...state.debug.slice(-99), JSON.stringify(ev.raw)] };
    case "parse_error":
      return { ...state, debug: [...state.debug.slice(-99), ev.line] };
    default:
      // An event this version doesn't know (a newer backend's): left alone, never an empty chat.
      return state;
  }
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "ui_event": {
      // An event it doesn't know leaves the chat as it is (and isn't counted as Claude doing something).
      const next = applyEvent(state, action.event);
      // A dev server's output and a setup command's progress aren't Claude doing something.
      const ev = action.event;
      const aside = ev.kind === "agent_setup" || ((ev.kind === "shell_output" || ev.kind === "shell_done") && ev.id.startsWith(RUN_PREFIX));
      return next === state ? state : { ...next, activityAt: aside ? state.activityAt : Date.now() };
    }
    case "claude_found":
      return { ...state, claudePath: action.path, setupError: null, status: state.folder ? state.status : "no_folder" };
    case "claude_missing":
      return { ...state, claudePath: null, setupError: action.error, status: "setup" };
    case "folder_opened":
      return freshSession(state, action.folder);
    case "folder_cleared":
      return { ...freshSession(state, null), status: "no_folder" };
    case "history_loaded": {
      const replayed = action.events.reduce(applyEvent, { ...freshSession(state, state.folder), sessionId: action.sessionId });
      // The backend keeps the replayed session's last turn as turn 0; earlier turns' changes aren't known.
      const last = replayed.items.map((it) => it.type).lastIndexOf("user");
      const items = replayed.items.map((it, i): ChatItem => (i === last && it.type === "user" ? { ...it, turn: 0 } : it));
      return { ...replayed, status: "starting", thinking: false, items: settleRunning(withoutTimes(items)), movedFrom: action.movedFrom ?? null };
    }
    case "turn_numbered": {
      const at = state.items.map((it) => it.type === "user" && it.turn === undefined).lastIndexOf(true);
      if (at < 0) return state;
      return { ...state, items: state.items.map((it, i): ChatItem => (i === at && it.type === "user" ? { ...it, turn: action.turn } : it)) };
    }
    case "notes_applied":
      return state.notesApplied === action.text ? state : { ...state, notesApplied: action.text };
    case "session_ready":
      return state.status === "starting" ? { ...state, status: "idle" } : state;
    case "user_sent": {
      const seq = state.seq + 1;
      const item: ChatItem = { type: "user", id: `u${seq}`, text: action.text, at: Date.now(), ...(action.auto ? { auto: true } : {}), ...(action.switchedTo ? { switchedTo: action.switchedTo, ...(action.explained ? { explained: true } : {}) } : {}), ...(action.draft ? { draft: action.draft } : {}) };
      // A picked flavour went with this message.
      // The commands run since the last message went with this one (unless it's a slash command).
      const sent = takesShellContext(action.text) ? state.items.map((it): ChatItem => (it.type === "shell" && !it.shared ? { ...it, shared: true } : it)) : state.items;
      // The revert note went with this message (a slash command gets none, so the note waits for the next).
      const noted = takesShellContext(action.text) ? [] : state.revertNotes;
      // The moved-folder note goes with the first message that isn't a slash command, like the revert notes.
      const movedFrom = takesShellContext(action.text) ? null : state.movedFrom;
      // Anything the user sends ends a run of automatic turns; the guard counts only the unattended ones.
      const autoStreak = action.auto ? state.autoStreak + 1 : 0;
      return { ...state, status: "running", thinking: true, stopRequested: false, seq, autoStreak, flavourPick: action.switchedTo ? null : state.flavourPick, explainPick: action.switchedTo ? false : state.explainPick, items: [...sent, item], revertUndo: null, restoreUndo: null, revertNotes: noted, movedFrom };
    }
    case "wakes_taken":
      return { ...state, wakes: [] };
    case "orchestrator_set":
      return { ...state, orchestrator: action.on };
    case "mode_changed":
      return { ...state, mode: action.mode, autoApprove: action.mode === "steps" ? (action.autoApprove ?? state.autoApprove) : false, ...(action.flavourStart !== undefined ? { flavourStart: action.flavourStart } : {}), ...(action.explainStart !== undefined ? { explainStart: action.explainStart } : {}) };
    case "subagents_set":
      return { ...state, subagents: action.subagents };
    case "review_set":
      return { ...state, review: action.review };
    case "flavour_picked":
      return { ...state, flavourPick: action.flavour, explainPick: !!action.flavour && !!action.explain };
    case "permission_decided":
      // The agent was waiting on the user, not quiet: its clock starts again from the answer.
      return {
        ...state,
        activityAt: Date.now(),
        items: state.items.map((it): ChatItem => (it.type === "permission" && it.id === action.id ? { ...it, decision: action.allow ? "allowed" : "denied", note: action.note } : it)),
      };
    case "stop_requested":
      return {
        ...state,
        stopRequested: true,
        items: denyPending(state.items),
      };
    // The old claude's cost is kept: the new one counts from nothing, and its first total may be more than the old one's.
    case "restarting":
      return {
        ...state,
        status: "starting",
        banner: null,
        stopRequested: false,
        leadStopped: false,
        costBase: state.costBase + state.costSeen,
        costSeen: 0,
        tokenBase: state.tokenBase + state.sessionTokens,
        sessionTokens: 0,
        items: denyPending(state.items),
      };
    case "select_file":
      return { ...state, selectedFile: action.path, follow: false };
    case "follow_latest":
      return { ...state, follow: true, selectedFile: state.lastEdited ?? state.selectedFile };
    // A failed call (a model change, an update) leaves the chat's status as it was: a turn may well be going on.
    // A start that failed has nothing running, so it's ended, with a restart to try again.
    case "failed":
      if (state.status === "starting") return { ...state, status: "ended", thinking: false, banner: { kind: "error", text: action.text, action: "restart" } };
      return { ...state, banner: { kind: "error", text: action.text, action: null } };
    // A message or an answer that didn't reach claude: the turn can't go on from here, so the chat ends and a restart resumes it.
    case "turn_failed":
      return { ...state, status: "ended", thinking: false, items: denyPending(failRunning(state.items)), banner: { kind: "error", text: action.text, action: "restart" } };
    // Stop didn't reach claude: the turn runs on, so it isn't recorded as stopped.
    case "stop_failed":
      return { ...state, stopRequested: false, banner: { kind: "error", text: action.text, action: null } };
    case "dismiss_banner":
      return { ...state, banner: null };
    case "queue_set":
      return { ...state, queued: action.items };
    case "run_started":
      return { ...state, run: { id: action.id, command: action.command, status: "running", code: null, output: "", url: null, startedAt: Date.now() } };
    case "run_closed":
      return state.run ? { ...state, run: null } : state;
    case "shell_started":
      return { ...state, items: [...state.items, { type: "shell", id: action.id, command: action.command, output: "", status: "running", code: null, startedAt: Date.now(), shared: false }] };
    case "revert_done": {
      const id = state.revertSeq + 1;
      const undo = undoOf(action.outcomes);
      const summary = revertSummary(action.outcomes);
      const notes = action.outcomes
        .filter((o) => o.status === "reverted" || o.status === "trashed")
        .map((o): RevertNote => ({ path: o.path, trashed: o.status === "trashed", since: action.since, revert: id }));
      // Only a revert that changed something can be undone; one that only met conflicts says so in the banner instead.
      return {
        ...state,
        revertSeq: id,
        revertUndo: undo.length ? { id, files: undo, summary } : state.revertUndo,
        revertNotes: [...state.revertNotes, ...notes],
        banner: undo.length ? state.banner : { kind: "info", text: summary, action: null },
      };
    }
    case "revert_undone":
      return {
        ...state,
        revertUndo: state.revertUndo?.id === action.id ? null : state.revertUndo,
        revertNotes: state.revertNotes.filter((n) => n.revert !== action.id),
        banner: { kind: "info", text: undoSummary(action.outcomes), action: null },
      };
    case "restore_done": {
      // A restore's notes are filed under its undo's number, below the reverts' (which count up from 1); 0 if it can't be undone.
      const revert = action.id === null ? 0 : restoreNoteId(action.id);
      const notes = action.files.map((f): RevertNote => ({ path: f.path, trashed: f.trashed, since: action.since, revert }));
      return { ...state, restoreUndo: action.id === null ? null : { id: action.id, summary: action.summary }, revertNotes: [...state.revertNotes, ...notes], banner: action.id === null ? { kind: "info", text: action.summary, action: null } : state.banner };
    }
    case "restore_undone":
      return { ...state, restoreUndo: state.restoreUndo?.id === action.id ? null : state.restoreUndo, revertNotes: state.revertNotes.filter((n) => n.revert !== restoreNoteId(action.id)), banner: { kind: "info", text: action.text, action: null } };
    case "notice":
      return { ...state, banner: { kind: "info", text: action.text, action: null } };
    case "changes_synced": {
      const now = new Map(action.files.map((f) => [f.path, f]));
      // Keep the list's order (the order Claude touched things); anything the backend adds goes at the end.
      const kept = state.changedFiles.filter((f) => now.has(f.path)).map((f) => ({ ...f, ...now.get(f.path)! }));
      const added = action.files.filter((f) => !state.changedFiles.some((c) => c.path === f.path));
      const changedFiles = [...kept, ...added];
      const same = changedFiles.length === state.changedFiles.length && changedFiles.every((f, i) => JSON.stringify(f) === JSON.stringify(state.changedFiles[i]));
      if (same) return state;
      const selectedFile = changedFiles.some((f) => f.path === state.selectedFile) ? state.selectedFile : (changedFiles[changedFiles.length - 1]?.path ?? null);
      return { ...state, changedFiles, selectedFile, editCount: state.editCount + 1 };
    }
  }
}
