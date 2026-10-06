import type { Hunk, ModelOption, Mode, SlashCommand, UiEvent, TestRun } from "./types";
import { countChanges } from "./lib/diff";
import { withoutModeNote } from "./lib/steps";

export interface EditInfo {
  path: string;
  created: boolean;
  hunks: Hunk[];
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
    }
  | { type: "assistant"; id: string; text: string }
  | ToolItem
  | { type: "permission"; id: string; toolName: string; input: unknown; decision: "allowed" | "denied" | null; note?: string }
  | { type: "turn"; id: string; isError: boolean; stopped: boolean; result: string | null; durationMs: number | null; denied: number };

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

export interface State {
  status: Status;
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
  /** /clear just emptied the conversation; its turn's end adds no marker. */
  cleared: boolean;
  contextWindow: number | null;
  mode: Mode;
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
  banner: Banner | null;
  stopRequested: boolean;
  debug: string[];
  seq: number;
  /** What claude runs in the background (a command with run_in_background, a background agent), and since when. */
  backgroundTasks: BackgroundTask[];
  /** The background task that ended last, for the note on a reply Claude starts about it. */
  lastEndedTask: string | null;
  /** Steps that started a background task, by tool call: still running, or how they ended. */
  backgroundRuns: Record<string, BackgroundRun>;
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

export const initialState: State = {
  status: "locating",
  queued: [],
  claudePath: null,
  setupError: null,
  folder: null,
  sessionId: null,
  contextUsed: null,
  commands: [],
  models: [],
  cleared: false,
  contextWindow: null,
  mode: "ask",
  model: null,
  items: [],
  changedFiles: [],
  testRuns: [],
  editCount: 0,
  selectedFile: null,
  lastEdited: null,
  follow: true,
  thinking: false,
  banner: null,
  stopRequested: false,
  debug: [],
  seq: 0,
  backgroundTasks: [],
  lastEndedTask: null,
  backgroundRuns: {},
};

export type Action =
  | { type: "ui_event"; event: UiEvent }
  | { type: "claude_found"; path: string }
  | { type: "claude_missing"; error: string }
  | { type: "folder_opened"; folder: string }
  | { type: "folder_cleared" }
  | { type: "history_loaded"; sessionId: string; events: UiEvent[] }
  | { type: "session_ready" }
  | { type: "user_sent"; text: string }
  | { type: "mode_changed"; mode: Mode }
  | { type: "permission_decided"; id: string; allow: boolean; note?: string }
  | { type: "stop_requested" }
  | { type: "restarting" }
  | { type: "select_file"; path: string }
  | { type: "follow_latest" }
  | { type: "failed"; text: string }
  | { type: "dismiss_banner" }
  | { type: "queue_set"; items: string[] }
  /** The backend numbered the turn the latest prompt started. */
  | { type: "turn_numbered"; turn: number }
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

// An empty conversation for `folder`, as after opening it.
function freshSession(state: State, folder: string | null): State {
  return { ...state, folder, sessionId: null, contextUsed: null, queued: [], status: "starting", items: [], changedFiles: [], testRuns: [], editCount: 0, selectedFile: null, lastEdited: null, follow: true, banner: null, model: null, thinking: false, backgroundTasks: [], backgroundRuns: {} };
}

// Claude replying with no prompt from here (a background task ended and it reports back) is a turn like any other,
// opened by a note in place of a prompt.
function wake(state: State): State {
  if (state.status !== "idle") return state;
  const seq = state.seq + 1;
  const text = state.lastEndedTask ? `After ${state.lastEndedTask} ended` : "Claude followed up on its own";
  return { ...state, status: "running", seq, lastEndedTask: null, items: [...state.items, { type: "user", id: `u${seq}`, text, at: Date.now(), auto: true }] };
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
      return { ...state, seq, items: [...state.items, { type: "user", id: `u${seq}`, text: withoutModeNote(ev.text), at: ev.at }] };
    }
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
        items: insert(s.items, ev.parent, { type: "tool", id: ev.tool_use_id, name: ev.name, summary: ev.summary, status: "running", output: null, edit: null, children: [] }),
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
      return { ...state, items: mapTools(state.items, ev.tool_use_id, (t) => ({ ...t, status: ev.is_error ? "error" : "done", output: ev.output })) };
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
    // /clear: a new conversation in the same folder. Changed files stay listed; the edits are still on disk.
    case "conversation_reset":
      return { ...state, items: [], sessionId: null, contextUsed: null, thinking: false, cleared: true };
    case "turn_done": {
      const banner: Banner | null = ev.auth_hint
        ? { kind: "auth", text: "Claude isn't logged in. Run `claude /login` in a terminal, then send your message again.", action: null }
        : state.banner?.kind === "info"
          ? null
          : state.banner;
      const seq = state.seq + 1;
      return {
        ...state,
        status: "idle",
        thinking: false,
        banner,
        seq,
        contextWindow: ev.context_window ?? state.contextWindow,
        // The turn that ran /clear ends in an empty conversation; a marker alone would leave a blank chat, not the start screen.
        cleared: false,
        items: state.cleared ? state.items : [...state.items, { type: "turn", id: `t${seq}`, isError: ev.is_error && !state.stopRequested, stopped: state.stopRequested, result: ev.is_error ? ev.result : null, durationMs: ev.duration_ms, denied: ev.denied }],
      };
    }
    case "permission_requested":
      return { ...state, items: [...state.items, { type: "permission", id: ev.request_id, toolName: ev.tool_name, input: ev.input, decision: null }] };
    case "session_ended": {
      const detail = lastLine(ev.stderr_tail);
      const text = `Claude stopped unexpectedly${ev.code === null ? "" : ` (exit code ${ev.code})`}.${detail ? ` ${detail}` : ""}`;
      return {
        ...state,
        status: "ended",
        thinking: false,
        backgroundTasks: [],
        items: failRunning(state.items),
        banner: state.stopRequested ? state.banner : { kind: "error", text, action: "restart" },
      };
    }
    case "unknown":
      return { ...state, debug: [...state.debug.slice(-99), JSON.stringify(ev.raw)] };
    case "parse_error":
      return { ...state, debug: [...state.debug.slice(-99), ev.line] };
  }
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "ui_event":
      return applyEvent(state, action.event);
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
      return { ...replayed, status: "starting", thinking: false, items: settleRunning(items) };
    }
    case "turn_numbered": {
      const at = state.items.map((it) => it.type === "user" && it.turn === undefined).lastIndexOf(true);
      if (at < 0) return state;
      return { ...state, items: state.items.map((it, i): ChatItem => (i === at && it.type === "user" ? { ...it, turn: action.turn } : it)) };
    }
    case "session_ready":
      return state.status === "starting" ? { ...state, status: "idle" } : state;
    case "user_sent": {
      const seq = state.seq + 1;
      return { ...state, status: "running", thinking: true, stopRequested: false, seq, items: [...state.items, { type: "user", id: `u${seq}`, text: action.text, at: Date.now() }] };
    }
    case "mode_changed":
      return { ...state, mode: action.mode };
    case "permission_decided":
      return {
        ...state,
        items: state.items.map((it): ChatItem => (it.type === "permission" && it.id === action.id ? { ...it, decision: action.allow ? "allowed" : "denied", note: action.note } : it)),
      };
    case "stop_requested":
      return {
        ...state,
        stopRequested: true,
        items: state.items.map((it): ChatItem => (it.type === "permission" && it.decision === null ? { ...it, decision: "denied" } : it)),
      };
    case "restarting":
      return {
        ...state,
        status: "starting",
        banner: null,
        stopRequested: false,
        items: state.items.map((it): ChatItem => (it.type === "permission" && it.decision === null ? { ...it, decision: "denied" } : it)),
      };
    case "select_file":
      return { ...state, selectedFile: action.path, follow: false };
    case "follow_latest":
      return { ...state, follow: true, selectedFile: state.lastEdited ?? state.selectedFile };
    case "failed":
      return {
        ...state,
        status: state.status === "starting" ? "ended" : state.status === "running" ? "idle" : state.status,
        thinking: false,
        banner: { kind: "error", text: action.text, action: null },
      };
    case "dismiss_banner":
      return { ...state, banner: null };
    case "queue_set":
      return { ...state, queued: action.items };
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
