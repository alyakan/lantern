import type { AgentRole } from "./lib/roles";
import type { ReviewCheck } from "./lib/reviewChain";

/**
 * How a chat launches: Permissions Ask, Permissions Auto, or the Step by step workflow (a page per message, in a flavour:
 * see lib/flavour.ts), whose own Permissions are `auto_approve`. A chat's two settings, Permissions and Workflow, are
 * read from this with lib/workflow.ts.
 */
export type Mode = "ask" | "auto" | "steps";

/** Where an "Always allow" rule applies: this chat only, or every chat in the folder. */
export type RuleScope = "chat" | "folder";

/** What a rule matches within its tool's input (src-tauri/src/permission/rules.rs). */
/** What a project's files suggest for its setup lines and its Run command (see ProjectSetupDialog). */
export interface SetupSuggestion {
  commands: string[];
  run: string | null;
}

export type RuleMatcher = { kind: "any" } | { kind: "exact"; text: string } | { kind: "prefix"; text: string } | { kind: "dir"; path: string };

/** An "Always allow" rule: a tool and what of its calls it covers. */
export type Rule = { tool: string } & RuleMatcher;

/** A rule made from a card, and where it applies. */
export type NewRule = { scope: RuleScope } & Rule;

/** A rule as Settings lists it: `folder` is the folder a folder rule is for (null for a chat rule). */
export type RuleEntry = { scope: RuleScope; folder: string | null } & Rule;

export interface Hunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: string[];
}

/** What an agent provider (the CLI behind a chat) can do (src-tauri/src/provider/mod.rs): the window hides what it can't. */
export interface Capabilities {
  supports_auto_mode: boolean;
  supports_advisor: boolean;
  reports_cost_usd: boolean;
  supports_skills: boolean;
  supports_effort: boolean;
  model_switchable: boolean;
}

export interface ProviderInfo {
  id: string;
  capabilities: Capabilities;
}

export type UiEvent =
  | { kind: "session_started"; session_id: string; model: string; cwd: string; permission_mode: string; claude_version: string }
  | { kind: "user_text"; text: string; at?: number; sent_by?: string }
  | { kind: "thinking"; parent: string | null }
  | { kind: "text_delta"; parent: string | null; block_id: string; text: string }
  | { kind: "assistant_text"; parent: string | null; block_id: string; text: string }
  | { kind: "tool_started"; parent: string | null; tool_use_id: string; name: string; summary: string }
  | { kind: "edit_applied"; parent: string | null; tool_use_id: string; path: string; created: boolean; hunks: Hunk[] }
  | { kind: "tool_finished"; parent: string | null; tool_use_id: string; is_error: boolean; output: string }
  | { kind: "test_run"; parent: string | null; tool_use_id: string; command: string; run: TestRun }
  | { kind: "retrying"; attempt: number; max_retries: number; error: string }
  | { kind: "turn_done"; is_error: boolean; result: string | null; cost_usd: number | null; tokens?: number | null; session_cost_usd?: number | null; session_tokens?: number; duration_ms: number | null; auth_hint: boolean; denied: number; context_window: number | null }
  | { kind: "context_used"; tokens: number }
  | { kind: "background_tasks"; tasks: { id: string; task_type: string; description: string }[] }
  | { kind: "task_started"; task_id: string; tool_use_id: string }
  | { kind: "task_ended"; task_id: string; tool_use_id: string; status: string; summary: string }
  | { kind: "commands"; commands: SlashCommand[] }
  | { kind: "models"; models: ModelOption[] }
  | { kind: "mcp_tools"; tools: string[] }
  | { kind: "agent_model"; parent: string | null; model: string }
  | { kind: "agent_started"; tool_use_id: string; subagent_type: string; description: string; model: string | null }
  | { kind: "agent_progress"; tool_use_id: string; description: string; tokens: number; tool_uses: number; duration_ms: number }
  | { kind: "advisor_started"; parent: string | null; id: string }
  | { kind: "advisor_done"; parent: string | null; id: string; outcome: "reviewed" | "declined" | "unavailable"; error_code: string | null }
  | { kind: "model_usage"; models: ModelCost[] }
  | { kind: "conversation_reset" }
  | { kind: "permission_requested"; request_id: string; tool_name: string; input: unknown }
  | { kind: "permission_withdrawn"; request_id: string }
  | { kind: "permission_resolved"; request_id: string; allow: boolean; by: string }
  | { kind: "permission_auto_allowed"; request_id: string; tool_name: string; input: unknown; scope: RuleScope; rule: Rule }
  | { kind: "session_ended"; code: number | null; stderr_tail: string }
  | { kind: "shell_output"; id: string; text: string }
  | { kind: "shell_done"; id: string; code: number | null; stopped: boolean }
  | { kind: "shell_secret"; id: string; secret: boolean }
  /** On the main agent's chat: it started a worker, whose chat is the slot `worker` (open before its first event). */
  | { kind: "agent_spawned"; worker: string; name: string; brief: string; folder: string; branch: string | null; base: string | null; isolation: "worktree" | "shared"; mode: Mode; provider?: ProviderInfo; role?: AgentRole; review_of?: string }
  /** On the main agent's chat: a note from Lantern for it (a worker finished, crashed or waits on the user). */
  | { kind: "agent_wake"; text: string }
  /** On a worker: Lantern reviewed or tested a builder's work with it and closed it: its copy of the code is gone, its report stays. */
  | { kind: "agent_tidied" }
  /** On the Lead: where the review and test of a builder's latest work stands. */
  | { kind: "review_update"; builder: string; name: string; commit: string; checks: ReviewCheck[]; done: boolean }
  /** On a worker's chat: the main agent sent it this. */
  | { kind: "agent_message"; from: string; text: string }
  /** On a worker's chat: its claude was stopped to save memory (`asleep`), or started again: a message wakes it. */
  | { kind: "agent_asleep"; asleep: boolean }
  /** On a worker's chat: its claude was stopped on purpose, or never started (`reason`). */
  | { kind: "agent_stopped"; reason: string | null }
  /** On a worker's chat: it now runs on this mode, because its main agent's was lowered. */
  /** On a worker's slot: its worktree is being set up before it starts. "done": it starts now; "failed": it stopped at `command`. */
  | { kind: "agent_setup"; phase: "running" | "failed" | "done"; index: number; total: number; command: string; line: string; reason: string; tail: string }
  | { kind: "agent_mode"; mode: Mode }
  /** On the main agent's chat: it asks the user to merge a worker's branch. */
  | { kind: "merge_proposed"; worker: string; name: string; branch: string; into: string; summary: string; commits: number; files: { path: string; added: number; removed: number }[]; uncommitted: number; loose: string[] }
  /** How that ended: "merged" (detail: the branch merged into), "conflicts" (the files), "declined", "failed" (why), or
   * "changed" (what changed since it was proposed: nothing was merged and the proposal is gone). */
  /** The subscription's five-hour window (the account's, whichever chat says): `used` 0–1, `resets_at` unix seconds. */
  | { kind: "plan_usage"; used: number; resets_at: number | null; status: string }
  /** The chat's review_target call: what the Changes pane compares (a pull request, or the checked-out branch against `base`; null: Lantern finds it). */
  | { kind: "review_target"; pr: number | null; base: string | null }
  | { kind: "merge_resolved"; worker: string; outcome: "merged" | "conflicts" | "declined" | "failed" | "changed"; detail: string }
  | { kind: "unknown"; raw: unknown }
  | { kind: "parse_error"; line: string };

/** What a side chat's claude says (src-tauri/src/aside.rs): one of the events of an answer, or a note from Lantern (why an answer was stopped). Never a chat's own event. */
export interface AsideEvent {
  aside: string;
  event?: UiEvent;
  note?: string;
}

export interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
}

export interface SessionSummary {
  id: string;
  title: string;
  updated_ms: number;
  prompts: number;
}

export interface RecentFolder {
  path: string;
  updated_ms: number;
}

/** A folder that moved: the places it was before, most recent first. Its sessions are read from there too. */
export interface RelocationEntry {
  folder: string;
  aliases: string[];
}

/** A recent folder that no longer exists, and the one place it probably moved to (null: none, or more than one). */
export interface MovedFolder {
  old: string;
  suggested: string | null;
}

/** A place a folder's sessions were started in, that can be brought over (old_locations). */
export interface OldLocation {
  path: string;
  exists: boolean;
  sessions: number;
  updated_ms: number;
  /** Already brought over: its sessions are in History. */
  already: boolean;
}

/** A folder that has sessions, whether or not it still exists (known_folders). */
export interface FolderSessions {
  path: string;
  exists: boolean;
  sessions: number;
  updated_ms: number;
}

/** What moving a folder would bring over, read without changing anything. */
export interface RelocationPreview {
  sessions: number;
  bytes: number;
  project_entry: boolean;
  memory_files: number;
  rules: number;
  /** Links among the transcripts and memory files: skipped, not copied. */
  linked: number;
}

/** What to carry over with a move, besides its sessions and Lantern's own rules (always carried). */
export interface RelocateOptions {
  project_settings: boolean;
  memory: boolean;
}

export interface RelocateOutcome {
  project_keys: string[];
  memory_files: number;
  rules: number;
}

/** What closing a worker would throw away (the backend's CloseCheck): asked before anything is stopped or removed. */
export interface CloseCheck {
  /** It has a worktree of its own; a worker in the shared folder only gets stopped. */
  worktree: boolean;
  /** Its worktree's folder was removed outside Lantern: nothing in it can be lost, and only its branch is left to delete. */
  gone?: boolean;
  branch: string | null;
  /** Files changed in its worktree and not committed. */
  uncommitted: number;
  /** Commits on its branch that aren't in the branch it started from, or was proposed into. */
  unmerged_commits: number;
}

/** What the user agreed to lose by closing a worker: the numbers in the question they confirmed. */
export type CloseAgreed = Pick<CloseCheck, "uncommitted" | "unmerged_commits">;

/** What the user asks for when they start a worker from the canvas. */
export interface NewWorker {
  /** What the worker is asked to do: its brief. */
  task: string;
  /** Null: named from the task. */
  name: string | null;
  isolation: "worktree" | "shared";
  /** Null: Claude Code's default. */
  model: string | null;
  /** The role it is started in, which is also what is kept of it on its card; absent: none. A read-only one has only the tools that read files: no editing and no commands. */
  role?: AgentRole;
}

/**
 * A past session as it opened: its events; the folder it was started in, when that was a place this folder moved from
 * (null otherwise); and why it's only readable, when its copy into the folder failed (null: it can be resumed).
 */
export interface OpenedSession {
  events: UiEvent[];
  /** How many turns before `events` are still on disk, for "Show earlier messages" (absent: none). */
  earlier?: number;
  moved_from: string | null;
  read_only: string | null;
  /** The CLI the chat runs on, and what it can do. */
  provider?: ProviderInfo;
}

/** A run of a session's turns read from its transcript, and how many turns come before them. */
export interface HistoryPage {
  events: UiEvent[];
  hidden: number;
}

export interface FileDiff {
  path: string;
  original: string;
  current: string;
  created: boolean;
  deleted: boolean;
}

/** What a turn cost on one model (the main one, subagents', the advisor's). */
export interface ModelCost {
  model: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
}

/** A slash command claude offers: built-in, custom (.claude/commands) or a skill. */
export interface SlashCommand {
  name: string;
  description: string;
  argument_hint: string;
}

/** An MCP server as claude reports it (the mcp_status control request). */
export interface McpServer {
  name: string;
  /** "connected", "needs-auth", "failed", "pending", "disabled"… */
  status: string;
  serverInfo?: { name?: string; title?: string; version?: string; icons?: { src: string }[]; websiteUrl?: string };
  /** How it's reached: { type: "stdio", command, args, env } or { type: "http" | "sse", url, headers }, or a claude.ai connector. */
  config?: Record<string, unknown>;
  /** "user", "local", "project", "claudeai", "dynamic"… */
  scope?: string;
  /** "plugin", "claudeai"… */
  source?: string;
  error?: string;
}

/** A skill or custom command found on disk (see src-tauri/src/skills.rs). */
export interface SkillEntry {
  name: string;
  kind: "skill" | "command" | "agent";
  /** "synced" is claude.ai's skills, kept in ~/.claude/skills/synced. */
  source: "user" | "project" | "plugin" | "synced";
  plugin: string | null;
  path: string;
  description: string;
  /** The plugin it comes from is turned off in settings, so claude doesn't load it. */
  disabled: boolean;
}

/** A server to add with `claude mcp add`. */
export interface McpServerSpec {
  name: string;
  transport: "stdio" | "http" | "sse";
  target: string;
  scope: "local" | "user" | "project";
  env: string[];
  headers: string[];
}

/** A model claude offers, in its order (recommended picks first). `value` is what --model takes; "default" = none. */
export interface ModelOption {
  value: string;
  display_name: string;
  description: string;
  resolved_model: string;
  /** The thinking-effort levels it takes; empty when it has none (e.g. Haiku). */
  effort_levels: string[];
}

/** How claude runs in a chat. null model or effort = Claude Code's default. */
export interface Settings {
  mode: Mode;
  model: string | null;
  effort: string | null;
  /** In Step by step: Claude Code's auto mode approves actions instead of asking in the app. */
  auto_approve?: boolean;
  /** The harness: the advisor model and the subagents' model (null or absent = Claude Code's own settings). */
  advisor?: string | null;
  subagent_model?: string | null;
  /** Start the chat as the main agent of an orchestra: it can spawn workers. */
  orchestrator?: boolean;
  /** Reopen the chat as a worker of an open main agent (a team restored after Lantern was closed). */
  /** `branch`: the one Lantern made for it (null when it shares the folder); its worktree's HEAD is the worker's to switch. */
  worker?: { name: string; parent: string; branch: string | null; shared: boolean; read_only: boolean; role?: AgentRole };
  /** The user's notes for the project (the app cuts them to its limit): every new chat starts knowing them. A worker gets its Lead's. */
  project_notes?: string;
}

/** A file search result (see files::find): the file, and which characters of `rel` matched. */
export interface FoundFile {
  path: string;
  rel: string;
  hits: number[];
}

/** A text search across the folder's files (see files::search_text). */
export interface TextQuery {
  pattern: string;
  case_sensitive: boolean;
  whole_word: boolean;
  regex: boolean;
}

/** A run of a search result's text; `hit` marks what matched (see history_search.rs). */
export interface ChatPiece {
  text: string;
  hit: boolean;
}

/** A past chat whose text has what was searched for: its title, where it opens, and up to two lines around the match. */
export interface ChatHit {
  id: string;
  title: ChatPiece[];
  folder: string;
  project: string;
  updated_ms: number;
  snippets: { role: "user" | "assistant"; pieces: ChatPiece[] }[];
}

export interface ChatSearchResults {
  /** Newest first. */
  chats: ChatHit[];
  /** It stopped (its limit, or its time) before it had read every chat. */
  partial: boolean;
  /** A newer search replaced it: the answer is of no use. */
  cancelled: boolean;
}

export interface TextResults {
  files: { path: string; rel: string; lines: { line: number; pieces: { text: string; hit: boolean }[] }[]; more: number }[];
  /** More matches than listed. */
  truncated: boolean;
}

/** A test run read from a Bash step's output (see src-tauri/src/test_runs.rs). */
export interface TestRun {
  framework: string;
  /** Can be "failed" with no failed test: a suite that didn't load, a build error. */
  outcome: "passed" | "failed" | "unknown";
  passed: number;
  failed: number;
  skipped: number;
  duration_ms: number | null;
  /** Failed cases when the output names them; passed and skipped ones when it lists them. */
  cases: TestCase[];
  /** The end of the output, for when the cases couldn't be read. */
  tail: string;
}

export interface TestCase {
  name: string;
  suite: string | null;
  status: "passed" | "failed" | "skipped";
  duration_ms: number | null;
  message: string | null;
  /** `path:line` */
  location: string | null;
}

/** A downloaded update that's waiting (the backend's `UpdateInfo`). `notes`: the release's body, its "What's new". */
export interface UpdateInfo {
  version: string;
  notes?: string;
}

/** Where updating Lantern has got to (the backend's `UpdateState`). */
export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up_to_date" }
  | { kind: "downloading"; version: string; downloaded: number; total: number | null }
  | { kind: "ready"; version: string; notes?: string }
  | { kind: "installing"; version: string }
  | { kind: "restarting" }
  | { kind: "failed"; error: string };

/** One request Network Monitor captured, without its headers or bodies (see network.rs). */
export interface NetworkTx {
  id: string;
  revision: number;
  /** Milliseconds since 1970. */
  started_at: number;
  method: string;
  url: string;
  host: string;
  path: string;
  status: number | null;
  duration_ms: number | null;
  state: "pending" | "completed" | "failed";
  error: string | null;
  request_content_type: string | null;
  response_content_type: string | null;
  request_size: number;
  response_size: number;
}

/** A kind of request the user said matters, in a folder: any URL containing `url` (`*` for anything). */
export interface NetworkWatch {
  label: string;
  method: string | null;
  url: string;
}

/** Claude's summary of one response (markdown), with enough of the request to show after Network Monitor forgets it. */
export interface NetworkSummary {
  id: string;
  method: string;
  url: string;
  status: number | null;
  started_at: number;
  text: string;
  written_at: number;
}

export interface NetworkItem {
  tx: NetworkTx;
  /** The watch it matched; null when only its summary is left. */
  watch: string | null;
  summary: NetworkSummary | null;
  /** Lantern still has its response to show. */
  has_response: boolean;
}

export type NetworkLink = { status: "unknown" } | { status: "connected" } | { status: "not_running" } | { status: "error"; message: string };

/** What a folder's Network tab shows. */
export interface NetworkView {
  link: NetworkLink;
  watches: NetworkWatch[];
  /** Newest first. */
  items: NetworkItem[];
}

export type StorageKind = "worktree" | "repo" | "build_output" | "cache" | "simulator" | "download" | "trash";
/** How safe it is to delete: blocked items hold unsaved work and can't be deleted at all. */
export type StorageRisk = "safe" | "review" | "blocked";

/** One thing the Storage scan found that could be cleared. */
export interface StorageItem {
  id: string;
  kind: StorageKind;
  name: string;
  path: string;
  bytes: number;
  risk: StorageRisk;
  /** "permanent" is deleted for good; "trash" takes no space back until the Trash is emptied. */
  removal: "permanent" | "trash" | "worktree" | "simulator_device" | "simulator_runtime";
  /** What it is, and how it comes back if removed. */
  note: string;
  /** Why it isn't safe (review and blocked items). */
  warning: string | null;
  /** The scan ticks it to begin with. */
  ticked: boolean;
  idle_days: number | null;
  /** The id of the worktree or project it is inside, which deleting takes along. */
  within: string | null;
  /** Claude's reason for suggesting it. */
  suggestion: string | null;
}

/** What the Storage tab shows. */
export interface StorageView {
  items: StorageItem[];
  scanning: boolean;
  progress: string;
  /** When the last scan finished (ms since the epoch); null before the first. */
  scanned_at: number | null;
  free_bytes: number | null;
  /** Local Time Machine snapshots, which can keep deleted space from showing as free. */
  snapshots: number;
  notes: string[];
  deleting: boolean;
}

export interface StorageOutcome {
  id: string;
  name: string;
  ok: boolean;
  freed: number;
  error: string | null;
}

export type MemoryKind = "app" | "lantern" | "macos" | "other";

/** One app's part of the RAM: name, size, process count and share only (no paths, pids or arguments reach the screen). */
export interface MemoryApp {
  name: string;
  /** Resident memory of its processes, scaled so every app together adds up to the used memory. */
  bytes: number;
  processes: number;
  /** Its part of the Mac's whole RAM, 0 to 1. */
  share: number;
  kind: MemoryKind;
}

/** What the Storage panel's Memory tab shows (read-only). */
export interface MemorySnapshot {
  total_bytes: number;
  used_bytes: number;
  cached_bytes: number;
  free_bytes: number;
  compressed_bytes: number;
  swap_used_bytes: number | null;
  pressure: "normal" | "warning" | "critical";
  /** "kernel": macOS's own level; "estimated": worked out from the free, cached and compressed shares. */
  pressure_source: "kernel" | "estimated";
  /** The apps' resident sizes added up to more than is used (shared pages), so they were scaled down. */
  scaled: boolean;
  /** Largest first, "Other apps" last; their bytes add up to used_bytes. */
  apps: MemoryApp[];
}

/** What the menu bar panel shows of the Mac, a few milliseconds to read (no process list). */
export interface MenuBarStats {
  ram: { total_bytes: number; used_bytes: number; pressure: "normal" | "warning" | "critical" } | null;
  disk_free: number | null;
  disk_total: number | null;
}

/** What the menu bar panel may ask the main window to do (the backend checks it, then the window does). */
export type MenuBarAction =
  | { kind: "open" }
  | { kind: "chat"; slot: string }
  | { kind: "new_chat"; folder: string; text: string }
  | { kind: "storage" }
  | { kind: "settings" };

/** An open chat (or a team's Lead) as the menu bar panel lists it. */
export interface MenuBarChat {
  slot: string;
  title: string;
  /** The project's folder name. */
  project: string;
  /** As the sidebar's dot says it: working, waiting for you, a draft typed but not sent, or done. */
  state: "running" | "waiting" | "draft" | "done";
  team: boolean;
}

export interface NetworkBody {
  encoding: "utf8" | "base64";
  data: string;
  size: number;
  /** Cut short by Lantern (it keeps the first 2 MB). */
  truncated: boolean;
}

/** One request with its headers and bodies. */
export interface NetworkDetail {
  transaction: NetworkTx;
  request_headers: { name: string; value: string }[];
  request_body: NetworkBody;
  response_headers: { name: string; value: string }[];
  response_body: NetworkBody;
}

/** An open pull request, as the "Review a PR" picker lists it (from `gh pr list`). */
export interface OpenPr {
  number: number;
  title: string;
  author: string;
  branch: string;
  draft: boolean;
}

/** How a worker's tests went when the user ran them from its merge card. */
export interface MergeTestsReport {
  command: string[];
  result: "passed" | "failed" | "timed_out";
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  exit_code: number | null;
  took_ms: number;
  /** The last lines of the output. */
  tail: string;
  /** What the numbers don't say (no packages installed, stopped for time). */
  note: string | null;
  /** Files the run left in the worktree that weren't there before. */
  new_files: string[];
  /** When it ended (unix milliseconds). */
  at: number;
  /** The branch (or its loose work) isn't what it was when the tests ran. */
  stale: boolean;
}

/** What a merge card knows about its tests: how they would run, the run going now, and the last result. */
export interface MergeTestsInfo {
  /** The project's folder: the command a user types is remembered for it. */
  project: string;
  detected: { command: string[]; source: string } | null;
  running: { command: string[]; elapsed_ms: number; last_line: string } | null;
  last: MergeTestsReport | null;
}

/** What Ship it learns about the folder's repository, read-only: where a push would go and whether a pull request can be opened. */
export interface ShipInfo {
  /** The checked-out branch (null: not a repository, or a detached HEAD). */
  branch: string | null;
  remote: string | null;
  /** The remote's address, without any password or token in it. */
  remote_url: string | null;
  github: boolean;
  /** The GitHub CLI can be run. */
  gh: boolean;
  /** The branch a pull request would go into. */
  base: string | null;
}

/** One check of a pull request, as gh lists it (read-only). */
export interface PrCheck {
  name: string;
  state: string;
  /** gh's grouping: pass, fail, pending, skipping or cancel. */
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
  link: string | null;
  workflow: string | null;
  /** The GitHub Actions run the link points at, when it is one: its log can be read. */
  run_id: string | null;
}

/** The pull request of a folder's branch. */
export interface PullRequest {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  branch: string;
  base: string;
  /** The commit the branch is at on GitHub: a new one means a push happened. */
  head_sha: string | null;
}

/** What looking at a folder's pull request found. */
export type PrWatch = { kind: "no_gh" } | { kind: "logged_out" } | { kind: "no_pr" } | { kind: "found"; pr: PullRequest; checks: PrCheck[] };

export type GhAccess = "ready" | "missing" | "logged_out";
