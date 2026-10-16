import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ChangedFile } from "./store";
import type { FlavourGuide } from "./lib/pageNote";
import type { CloseAgreed, CloseCheck, DirEntry, FileDiff, FolderSessions, FoundFile, McpServerSpec, MovedFolder, Mode, NetworkDetail, NetworkView, NewRule, NewWorker, OldLocation, OpenedSession, OpenPr, ProviderInfo, PrWatch, GhAccess, RecentFolder, RelocateOptions, RelocateOutcome, RelocationEntry, RelocationPreview, RuleEntry, SessionSummary, Settings, ShipInfo, SkillEntry, TextQuery, TextResults, UiEvent, UpdateInfo, UpdateState } from "./types";

/** What the Changes pane compares against: the chat's start, the last message sent, or git's last commit. */
export type ChangeScope = "session" | "turn" | "git" | "pr" | "branch";

/** A local branch under review: its commits (newest first) since it left `base`. */
export interface BranchReview {
  branch: string;
  /** What it is compared with: the branch it is stacked on, or the default branch. */
  base: string;
  /** Why it isn't the base the review named, when that one couldn't be found. */
  note?: string;
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

/** Whether claude is logged in, and as whom. */
export interface ClaudeLogin {
  logged_in: boolean;
  account: string | null;
}

/** Every chat-specific call names its slot: the chat (and claude process) it's about. */
export const api = {
  locateClaude: (pathOverride: string | null) => invoke<string>("locate_claude", { pathOverride }),
  /** Whether the claude at this path is logged in, and as whom; rejects when claude can't say. */
  claudeLogin: (claudePath: string) => invoke<ClaudeLogin>("claude_login", { claudePath }),
  startSession: (slot: string, claudePath: string, folder: string, settings: Settings) => invoke<ProviderInfo | null>("start_session", { slot, claudePath, folder, settings }),
  /** Restarts the chat's claude on the same session with another harness (main model and effort, advisor, subagents). */
  applyHarness: (slot: string, h: { model: string | null; effort: string | null; advisor: string | null; subagent_model: string | null }) =>
    invoke<void>("apply_harness", { slot, model: h.model, effort: h.effort, advisor: h.advisor, subagentModel: h.subagent_model }),
  closeSession: (slot: string) => invoke<void>("close_session", { slot }),
  setModel: (slot: string, model: string | null) => invoke<void>("set_model", { slot, model }),
  /** Resolves to the turn's number (see the Changes pane's per-turn views). */
  sendMessage: (slot: string, text: string) => invoke<number>("send_message", { slot, text }),
  /** The user approves a worker's merge: its branch goes into the main checkout (the outcome comes as `merge_resolved`). */
  approveMerge: (worker: string) => invoke<void>("orchestra_approve_merge", { worker }),
  declineMerge: (worker: string) => invoke<void>("orchestra_decline_merge", { worker }),
  /** Removes a worker's worktree; loose work needs `force`, and an unmerged branch is kept either way. */
  discardWorktree: (worker: string, force: boolean) => invoke<void>("orchestra_discard", { worker, force }),
  /** What closing a worker would throw away. Nothing is stopped or removed by asking. */
  closeWorkerCheck: (worker: string) => invoke<CloseCheck>("orchestra_close_check", { worker }),
  /** Stops a worker and removes its worktree and branch (and tells its main agent). Work that would be thrown away needs `agreed`: the numbers the user confirmed, which a worker that has gone on since is refused over. */
  /** How many workers may run at once across all of Lantern (Settings → General). */
  setAgentLimit: (limit: number) => invoke<void>("set_agent_limit", { limit }),
  closeWorker: (worker: string, agreed?: CloseAgreed) => invoke<void>("orchestra_close_worker", { worker, agreed: agreed ?? null }),
  /** Starts a worker for the main agent `main`, as the user's own doing (the main agent is told). Resolves to the worker's id. */
  spawnWorker: (main: string, w: NewWorker) => invoke<string>("orchestra_spawn", { main, task: w.task, name: w.name, isolation: w.isolation, model: w.model }),
  /** Runs a command the user typed after "!" in the chat's folder; its output comes as shell_output, then shell_done. */
  runShell: (slot: string, id: string, command: string) => invoke<void>("run_shell", { slot, id, command }),
  /** Asks the chat's claude something for Settings (MCP status and actions, reloading skills); resolves to its reply. */
  claudeRequest: <T = unknown>(slot: string, request: { subtype: string; [k: string]: unknown }) => invoke<T>("claude_request", { slot, request }),
  /** The skills and custom commands on disk: yours, the chat folder's, plugins'. */
  skillIndex: (slot: string | null) => invoke<SkillEntry[]>("skill_index", { slot }),
  readSkill: (slot: string | null, path: string) => invoke<string>("read_skill", { slot, path }),
  /** Makes a skill (a folder with a SKILL.md) or a command (a .md file) in yours (`user`) or the project's; resolves to its file. */
  skillCreate: (slot: string | null, kind: "skill" | "command", scope: "user" | "project", name: string, description: string) =>
    invoke<string>("skill_create", { slot, kind, scope, name, description }),
  /** Moves a skill's folder or a command's file to the Trash, where it can be put back; resolves to where it went. */
  skillDelete: (slot: string | null, path: string) => invoke<string>("skill_delete", { slot, path }),
  /** Saves a skill or command file's full text if the file is still `expected` (what was read); otherwise a conflict, nothing written. */
  skillSave: (slot: string | null, path: string, text: string, expected: string) => invoke<WriteResult>("skill_save", { slot, path, text, expected }),
  mcpAdd: (slot: string, spec: McpServerSpec) => invoke<string>("mcp_add", { slot, spec }),
  /** `scope` null: whichever scope it's in. */
  mcpRemove: (slot: string, name: string, scope: string | null) => invoke<string>("mcp_remove", { slot, name, scope }),
  /** A server's stored settings for the edit form: its secret values come back as "•••" (kept as they are when saved). */
  mcpForm: (slot: string, name: string, scope: string) => invoke<McpServerSpec>("mcp_form", { slot, name, scope }),
  /** Saves an edited server from where it is (`from`) to `spec`: the new entry is added before the old one is removed. */
  mcpEdit: (slot: string, from: { name: string; scope: string }, spec: McpServerSpec) => invoke<string>("mcp_edit", { slot, fromName: from.name, fromScope: from.scope, spec }),
  /** Types into a running command: a reply ending in "\r", or "\u0004" to end its input. */
  shellInput: (slot: string, id: string, text: string) => invoke<void>("shell_input", { slot, id, text }),
  stopShell: (slot: string, id: string) => invoke<void>("stop_shell", { slot, id }),
  interrupt: (slot: string) => invoke<void>("interrupt", { slot }),
  /**
   * `autoApprove`: Permissions Auto on Step by step (null keeps the chat's current setting). `team`: Workflow Team, which
   * makes the chat the Lead of a team (true) or an ordinary chat again (false); null leaves its role alone.
   */
  restartSession: (slot: string, mode: Mode, effort: string | null, autoApprove: boolean | null = null, team: boolean | null = null) => invoke<void>("restart_session", { slot, mode, effort, autoApprove, team }),
  /** `turn`: with the "turn" scope, which turn (the latest when null); `toTurn`: the end of a range of turns from it. */
  /** `pr`: with the "pr" scope, the pull request's number. */
  /** `base`: with the "branch" scope, the branch it is compared with (null: Lantern works it out). */
  getFileDiff: (slot: string, path: string, scope: ChangeScope = "session", turn: number | null = null, toTurn: number | null = null, pr: number | null = null, base: string | null = null) =>
    invoke<FileDiff>("get_file_diff", { slot, path, scope, turn, toTurn, pr, base }),
  /** `hints`: with "pr" and "branch", the reviewed files, which pick the repository in a folder that holds several. */
  changeSummary: (slot: string, scope: ChangeScope = "session", turn: number | null = null, toTurn: number | null = null, pr: number | null = null, hints: string[] | null = null, base: string | null = null) =>
    invoke<ChangedFile[]>("change_summary", { slot, scope, turn, toTurn, pr, hints, base }),
  /** `base`: the branch the review says it is stacked on; null lets Lantern work it out. */
  branchReview: (slot: string, hints: string[], base: string | null = null) => invoke<BranchReview>("branch_review", { slot, hints, base }),
  /** `message` goes back to Claude: a reason, or the user's note on a reproduce request. */
  /** `updatedInput`: on allow, the tool's input as it should run (AskUserQuestion's, with the user's answers). */
  respondPermission: (slot: string, requestId: string, allow: boolean, message: string | null = null, updatedInput: Record<string, unknown> | null = null) =>
    invoke<void>("respond_permission", { slot, requestId, allow, message, updatedInput }),
  /** Step by step's flavours as the prompt Claude runs with has them: each one's instructions and its pages' headings. */
  stepsGuide: () => invoke<FlavourGuide[]>("steps_guide"),
  /** Where the main agent's helpers run from now on in this chat (null: ask each time again). */
  /** The team's Subagents setting, on its Lead: where the Lead's built-in helpers run. */
  setSubagents: (slot: string, subagents: "canvas" | "inline") => invoke<void>("set_subagents", { slot, subagents }),
  /** Makes an "Always allow" rule from a card (the request itself is answered by respondPermission). */
  addPermissionRule: (slot: string, rule: NewRule) => invoke<void>("add_permission_rule", { slot, rule }),
  /** The rules Settings lists: this chat's (when `slot` is open) and every folder's. */
  listPermissionRules: (slot: string | null) => invoke<RuleEntry[]>("list_permission_rules", { slot }),
  removePermissionRule: (slot: string | null, entry: RuleEntry) => invoke<void>("remove_permission_rule", { slot, entry }),
  gitBranch: (folder: string) => invoke<string | null>("git_branch", { folder }),
  /** Ship it's read-only look at the folder's repository: branch, remote, base branch, and whether gh is there. */
  shipInfo: (folder: string) => invoke<ShipInfo>("ship_info", { folder }),
  /** The pull request on the folder's branch and how its checks stand (read-only). Rejects when gh failed for a reason that may pass. */
  prWatch: (folder: string) => invoke<PrWatch>("pr_watch", { folder }),
  /** The end of the log of a failed check's run (`runId` is digits). */
  prFailureLog: (folder: string, runId: string) => invoke<string>("pr_failure_log", { folder, runId }),
  /** Whether the GitHub CLI is installed and logged in. */
  ghAccess: () => invoke<GhAccess>("gh_access"),
  /** The user's name for their messages (macOS full name, else git's user.name); null if none. */
  userName: () => invoke<string | null>("user_name"),
  /** Stops one of the chat's background tasks (a run_in_background command, a background agent). */
  stopTask: (slot: string, taskId: string) => invoke<void>("stop_task", { slot, taskId }),
  listSessions: (folder: string) => invoke<SessionSummary[]>("list_sessions", { folder }),
  /** Names a past session in Lantern (its History menu's Rename). The name beats every other title the session has. */
  renameSession: (sessionId: string, title: string) => invoke<void>("rename_session", { sessionId, title }),
  /** A past session's events, read from its transcript without starting claude (for Export as Markdown). */
  sessionEvents: (folder: string, sessionId: string) => invoke<UiEvent[]>("session_events", { folder, sessionId }),
  /** A short title for the session (Claude Code's, one made before, or a new one from its first prompt); null if none. */
  titleSession: (claudePath: string, folder: string, sessionId: string, prompt: string) => invoke<string | null>("title_session", { claudePath, folder, sessionId, prompt }),
  recentFolders: () => invoke<RecentFolder[]>("recent_folders"),
  /** Replays a past session into the chat and resumes it. A session only in a folder's old place is copied into the folder first. */
  openSession: (slot: string, claudePath: string, folder: string, settings: Settings, sessionId: string) =>
    invoke<OpenedSession>("open_session", { slot, claudePath, folder, settings, sessionId }),
  /** Which of the folders no longer exist. */
  foldersGone: (folders: string[]) => invoke<string[]>("folders_gone", { folders }),
  /** Where each folder was before it moved, as Lantern recorded it. */
  relocationsList: () => invoke<RelocationEntry[]>("relocations_list"),
  /** The recent folders that are gone, each with the place it probably moved to. */
  movedFolderCandidates: () => invoke<MovedFolder[]>("moved_folder_candidates"),
  /** The places the folder was before whose sessions can be brought over: named like it, or already brought over. */
  oldLocations: (folder: string) => invoke<OldLocation[]>("old_locations", { folder }),
  /** The open pull requests of the folder's repository (gh); rejects with a message for the user when gh is missing, logged out or the folder isn't on GitHub. */
  openPrs: (folder: string) => invoke<OpenPr[]>("list_open_prs", { folder }),
  /** Every folder with sessions, gone ones included, for choosing where a folder was before. */
  knownFolders: () => invoke<FolderSessions[]>("known_folders"),
  /** What moving `old` to `next` would bring over. Nothing is changed. */
  relocationPreview: (old: string, next: string) => invoke<RelocationPreview>("relocation_preview", { old, new: next }),
  /** Records that the folder at `old` is now at `next`, carrying over what `options` chooses. Nothing is deleted or overwritten. */
  relocateFolder: (old: string, next: string, options: RelocateOptions) => invoke<RelocateOutcome>("relocate_folder", { old, new: next, options }),
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
  updateStatus: () => invoke<UpdateInfo | null>("update_status"),
  /** Installs the downloaded update and relaunches Lantern (stopping every chat's claude). */
  restartToUpdate: () => invoke<void>("restart_to_update"),
  onUpdateReady: (cb: (update: UpdateInfo) => void): Promise<UnlistenFn> => listen<UpdateInfo>("update-ready", (e) => cb(e.payload)),
  /** Where updating has got to, for a window that opened after it began. */
  updateState: () => invoke<UpdateState>("update_state"),
  /** Looks for a newer Lantern now and downloads it. If a check is already running, where that one has got to. */
  checkForUpdates: () => invoke<UpdateState>("check_for_updates"),
  /** The version of Lantern that's running. */
  appVersion: () => invoke<string>("app_version"),
  /** Help ▸ Report a Bug…: copies the diagnostics block to the clipboard and returns it. */
  copyDiagnostics: (claudePath: string | null, model: string | null, lastError: string | null) => invoke<string>("copy_diagnostics", { claudePath, model, lastError }),
  /** Every step of looking for, downloading and installing an update, as it happens. */
  onUpdateState: (cb: (state: UpdateState) => void): Promise<UnlistenFn> => listen<UpdateState>("update-state", (e) => cb(e.payload)),
  /** "Lantern ▸ Check for Updates…" was chosen in the app menu. */
  onCheckForUpdates: (cb: () => void): Promise<UnlistenFn> => listen("check-for-updates", () => cb()),
  /** The sidebar is now hidden, or collapsed: View's two sidebar items say what choosing them does. */
  sidebarMenu: (hidden: boolean, compact: boolean) => invoke<void>("sidebar_menu", { hidden, compact }),
  /** Anything is working (and the user allows it): the Mac is kept from idle sleep until it isn't. */
  keepAwake: (working: boolean, allowed: boolean) => invoke<void>("keep_awake", { working, allowed }),
  /** A menu bar item backed by an action was chosen: the action's id (see src/lib/actions.ts). */
  onMenuAction: (cb: (id: string) => void): Promise<UnlistenFn> => listen<string>("menu-action", (e) => cb(e.payload)),
  /** A folder in File ▸ Open Recent was chosen. */
  onOpenRecent: (cb: (path: string) => void): Promise<UnlistenFn> => listen<string>("open-recent", (e) => cb(e.payload)),
  /** The folder's Network tab: its watches, the requests that matched them (and summaries), and Network Monitor's state. */
  networkState: (folder: string) => invoke<NetworkView>("network_state", { folder }),
  /** One request's headers and bodies (rejects with why, e.g. Network Monitor no longer has it). */
  networkResponse: (folder: string, id: string) => invoke<NetworkDetail>("network_response", { folder, id }),
  /** Removes a watch; false if the folder had none by that label. */
  networkUnwatch: (folder: string, label: string) => invoke<boolean>("network_unwatch", { folder, label }),
  networkRewatch: (folder: string, label: string, method: string | null, url: string) => invoke<void>("network_rewatch", { folder, label, method, url }),
  /** A folder's Network tab has something new: a match, a summary, a watch, or Network Monitor going up or down. */
  onNetworkChanged: (cb: () => void): Promise<UnlistenFn> => listen("network-changed", () => cb()),
  onUiEvent: (cb: (slot: string, event: UiEvent) => void): Promise<UnlistenFn> =>
    listen<{ slot: string; event: UiEvent }>("ui-event", (e) => cb(e.payload.slot, e.payload.event)),
};
