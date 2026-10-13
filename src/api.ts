import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ChangedFile } from "./store";
import type { DirEntry, FileDiff, FoundFile, McpServerSpec, Mode, NewRule, RecentFolder, RuleEntry, SessionSummary, Settings, SkillEntry, TextQuery, TextResults, UiEvent, UpdateState } from "./types";

/** What the Changes pane compares against: the chat's start, the last message sent, or git's last commit. */
export type ChangeScope = "session" | "turn" | "git" | "pr" | "branch";

/** A local branch under review: its commits (newest first) since it left `base`. */
export interface BranchReview {
  branch: string;
  base: string;
  commits: { sha: string; subject: string; author: string; at: number }[];
}

export type WriteResult = { status: "saved"; changed: boolean } | { status: "conflict"; current: string | null };

/** What reverting (or undoing a revert of) one file came to. `before` and `after` are the text either side of it (null: absent). */
export interface RevertOutcome {
  path: string;
  status: "reverted" | "trashed" | "conflict" | "not_revertible";
  before: string | null;
  after: string | null;
  reason: string | null;
}

/** Every chat-specific call names its slot: the chat (and claude process) it's about. */
export const api = {
  locateClaude: (pathOverride: string | null) => invoke<string>("locate_claude", { pathOverride }),
  startSession: (slot: string, claudePath: string, folder: string, settings: Settings) => invoke<void>("start_session", { slot, claudePath, folder, settings }),
  /** Restarts the chat's claude on the same session with another harness (main model and effort, advisor, subagents). */
  applyHarness: (slot: string, h: { model: string | null; effort: string | null; advisor: string | null; subagent_model: string | null }) =>
    invoke<void>("apply_harness", { slot, model: h.model, effort: h.effort, advisor: h.advisor, subagentModel: h.subagent_model }),
  closeSession: (slot: string) => invoke<void>("close_session", { slot }),
  setModel: (slot: string, model: string | null) => invoke<void>("set_model", { slot, model }),
  /** Resolves to the turn's number (see the Changes pane's per-turn views). */
  sendMessage: (slot: string, text: string) => invoke<number>("send_message", { slot, text }),
  /** Runs a command the user typed after "!" in the chat's folder; its output comes as shell_output, then shell_done. */
  runShell: (slot: string, id: string, command: string) => invoke<void>("run_shell", { slot, id, command }),
  /** Asks the chat's claude something for Settings (MCP status and actions, reloading skills); resolves to its reply. */
  claudeRequest: <T = unknown>(slot: string, request: { subtype: string; [k: string]: unknown }) => invoke<T>("claude_request", { slot, request }),
  /** The skills and custom commands on disk: yours, the chat folder's, plugins'. */
  skillIndex: (slot: string | null) => invoke<SkillEntry[]>("skill_index", { slot }),
  readSkill: (slot: string | null, path: string) => invoke<string>("read_skill", { slot, path }),
  mcpAdd: (slot: string, spec: McpServerSpec) => invoke<string>("mcp_add", { slot, spec }),
  /** `scope` null: whichever scope it's in. */
  mcpRemove: (slot: string, name: string, scope: string | null) => invoke<string>("mcp_remove", { slot, name, scope }),
  /** Types into a running command: a reply ending in "\r", or "\u0004" to end its input. */
  shellInput: (slot: string, id: string, text: string) => invoke<void>("shell_input", { slot, id, text }),
  stopShell: (slot: string, id: string) => invoke<void>("stop_shell", { slot, id }),
  interrupt: (slot: string) => invoke<void>("interrupt", { slot }),
  /** `autoApprove`: Step by step's auto-approve (null keeps the chat's current setting). */
  restartSession: (slot: string, mode: Mode, effort: string | null, autoApprove: boolean | null = null) => invoke<void>("restart_session", { slot, mode, effort, autoApprove }),
  /** `turn`: with the "turn" scope, which turn (the latest when null); `toTurn`: the end of a range of turns from it. */
  /** `pr`: with the "pr" scope, the pull request's number. */
  getFileDiff: (slot: string, path: string, scope: ChangeScope = "session", turn: number | null = null, toTurn: number | null = null, pr: number | null = null) =>
    invoke<FileDiff>("get_file_diff", { slot, path, scope, turn, toTurn, pr }),
  /** `hints`: with "pr" and "branch", the reviewed files, which pick the repository in a folder that holds several. */
  changeSummary: (slot: string, scope: ChangeScope = "session", turn: number | null = null, toTurn: number | null = null, pr: number | null = null, hints: string[] | null = null) =>
    invoke<ChangedFile[]>("change_summary", { slot, scope, turn, toTurn, pr, hints }),
  branchReview: (slot: string, hints: string[]) => invoke<BranchReview>("branch_review", { slot, hints }),
  /** `message` goes back to Claude: a reason, or the user's note on a reproduce request. */
  /** `updatedInput`: on allow, the tool's input as it should run (AskUserQuestion's, with the user's answers). */
  respondPermission: (slot: string, requestId: string, allow: boolean, message: string | null = null, updatedInput: Record<string, unknown> | null = null) =>
    invoke<void>("respond_permission", { slot, requestId, allow, message, updatedInput }),
  /** Makes an "Always allow" rule from a card (the request itself is answered by respondPermission). */
  addPermissionRule: (slot: string, rule: NewRule) => invoke<void>("add_permission_rule", { slot, rule }),
  /** The rules Settings lists: this chat's (when `slot` is open) and every folder's. */
  listPermissionRules: (slot: string | null) => invoke<RuleEntry[]>("list_permission_rules", { slot }),
  removePermissionRule: (slot: string | null, entry: RuleEntry) => invoke<void>("remove_permission_rule", { slot, entry }),
  gitBranch: (folder: string) => invoke<string | null>("git_branch", { folder }),
  /** The user's name for their messages (macOS full name, else git's user.name); null if none. */
  userName: () => invoke<string | null>("user_name"),
  /** Stops one of the chat's background tasks (a run_in_background command, a background agent). */
  stopTask: (slot: string, taskId: string) => invoke<void>("stop_task", { slot, taskId }),
  listSessions: (folder: string) => invoke<SessionSummary[]>("list_sessions", { folder }),
  /** A short title for the session (Claude Code's, one made before, or a new one from its first prompt); null if none. */
  titleSession: (claudePath: string, folder: string, sessionId: string, prompt: string) => invoke<string | null>("title_session", { claudePath, folder, sessionId, prompt }),
  recentFolders: () => invoke<RecentFolder[]>("recent_folders"),
  openSession: (slot: string, claudePath: string, folder: string, settings: Settings, sessionId: string) =>
    invoke<UiEvent[]>("open_session", { slot, claudePath, folder, settings, sessionId }),
  listDir: (slot: string, path: string) => invoke<DirEntry[]>("list_dir", { slot, path }),
  readFile: (slot: string, path: string) => invoke<string>("read_file", { slot, path }),
  /**
   * Saves the user's edit of a file in the chat's folder. `expected` is the text the editor was based on (null: the
   * file shouldn't exist): if the file isn't that any more nothing is written and the answer is a conflict, with what's
   * there now (null: gone).
   */
  writeFile: (slot: string, path: string, text: string, expected: string | null) => invoke<WriteResult>("write_file", { slot, path, text, expected }),
  /**
   * Puts the files back to how they stood before a range of turns (`scope` "turn", with `turn` and `toTurn`) or before
   * the chat ("session"). Each file comes with the text the user was shown as its current text (null: shown as deleted).
   */
  revertFiles: (slot: string, scope: ChangeScope, turn: number | null, toTurn: number | null, files: { path: string; expected: string | null }[]) =>
    invoke<RevertOutcome[]>("revert_files", { slot, scope, turn, toTurn, files }),
  /** Undoes a revert: each file goes back to `target` (null: absent), if it still holds `expected` (what the revert left). */
  undoRevert: (slot: string, files: { path: string; target: string | null; expected: string | null }[]) => invoke<RevertOutcome[]>("undo_revert", { slot, files }),
  /** Saves an exported document at a path from the save dialog (a markdown file, anywhere). */
  /** Opens the save dialog and writes the document where the user picks; the path picked, or null if they cancel. */
  exportText: (fileName: string, text: string) => invoke<string | null>("export_text", { fileName, text }),
  /** Files in the chat's folder whose paths fuzzy-match `query`, best first. */
  findFiles: (slot: string, query: string) => invoke<FoundFile[]>("find_files", { slot, query }),
  /** Lines matching `query` across the chat folder's files. A newer search cancels an older one (it rejects). */
  searchText: (slot: string, query: TextQuery) => invoke<TextResults>("search_text", { slot, query }),
  /** For each file mention in Claude's text, the file in the chat's folder it means (null: not a file there). */
  resolveFiles: (slot: string, mentions: string[]) => invoke<(string | null)[]>("resolve_files", { slot, mentions }),
  /** A newer Lantern already downloaded and verified, if there is one. */
  updateStatus: () => invoke<{ version: string } | null>("update_status"),
  /** Installs the downloaded update and relaunches Lantern (stopping every chat's claude). */
  restartToUpdate: () => invoke<void>("restart_to_update"),
  onUpdateReady: (cb: (update: { version: string }) => void): Promise<UnlistenFn> => listen<{ version: string }>("update-ready", (e) => cb(e.payload)),
  /** Where updating has got to, for a window that opened after it began. */
  updateState: () => invoke<UpdateState>("update_state"),
  /** Looks for a newer Lantern now and downloads it. If a check is already running, where that one has got to. */
  checkForUpdates: () => invoke<UpdateState>("check_for_updates"),
  /** The version of Lantern that's running. */
  appVersion: () => invoke<string>("app_version"),
  /** Every step of looking for, downloading and installing an update, as it happens. */
  onUpdateState: (cb: (state: UpdateState) => void): Promise<UnlistenFn> => listen<UpdateState>("update-state", (e) => cb(e.payload)),
  /** "Lantern ▸ Check for Updates…" was chosen in the app menu. */
  onCheckForUpdates: (cb: () => void): Promise<UnlistenFn> => listen("check-for-updates", () => cb()),
  onUiEvent: (cb: (slot: string, event: UiEvent) => void): Promise<UnlistenFn> =>
    listen<{ slot: string; event: UiEvent }>("ui-event", (e) => cb(e.payload.slot, e.payload.event)),
};
