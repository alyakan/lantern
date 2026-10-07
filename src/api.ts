import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ChangedFile } from "./store";
import type { DirEntry, FileDiff, FoundFile, Mode, RecentFolder, SessionSummary, Settings, TextQuery, TextResults, UiEvent } from "./types";

/** What the Changes pane compares against: the chat's start, the last message sent, or git's last commit. */
export type ChangeScope = "session" | "turn" | "git" | "pr" | "branch";

/** A local branch under review: its commits (newest first) since it left `base`. */
export interface BranchReview {
  branch: string;
  base: string;
  commits: { sha: string; subject: string; author: string; at: number }[];
}

/** Every chat-specific call names its slot: the chat (and claude process) it's about. */
export const api = {
  locateClaude: (pathOverride: string | null) => invoke<string>("locate_claude", { pathOverride }),
  startSession: (slot: string, claudePath: string, folder: string, settings: Settings) => invoke<void>("start_session", { slot, claudePath, folder, settings }),
  closeSession: (slot: string) => invoke<void>("close_session", { slot }),
  setModel: (slot: string, model: string | null) => invoke<void>("set_model", { slot, model }),
  /** Resolves to the turn's number (see the Changes pane's per-turn views). */
  sendMessage: (slot: string, text: string) => invoke<number>("send_message", { slot, text }),
  /** Runs a command the user typed after "!" in the chat's folder; its output comes as shell_output, then shell_done. */
  runShell: (slot: string, id: string, command: string) => invoke<void>("run_shell", { slot, id, command }),
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
  respondPermission: (slot: string, requestId: string, allow: boolean, message: string | null = null) =>
    invoke<void>("respond_permission", { slot, requestId, allow, message }),
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
  onUiEvent: (cb: (slot: string, event: UiEvent) => void): Promise<UnlistenFn> =>
    listen<{ slot: string; event: UiEvent }>("ui-event", (e) => cb(e.payload.slot, e.payload.event)),
};
