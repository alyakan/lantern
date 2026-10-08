/**
 * How Claude may act: ask before actions, auto-approve, or step by step (a page per message, in a flavour: see
 * lib/flavour.ts).
 */
export type Mode = "ask" | "auto" | "steps";

export interface Hunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: string[];
}

export type UiEvent =
  | { kind: "session_started"; session_id: string; model: string; cwd: string; permission_mode: string; claude_version: string }
  | { kind: "user_text"; text: string; at?: number }
  | { kind: "thinking"; parent: string | null }
  | { kind: "text_delta"; parent: string | null; block_id: string; text: string }
  | { kind: "assistant_text"; parent: string | null; block_id: string; text: string }
  | { kind: "tool_started"; parent: string | null; tool_use_id: string; name: string; summary: string }
  | { kind: "edit_applied"; parent: string | null; tool_use_id: string; path: string; created: boolean; hunks: Hunk[] }
  | { kind: "tool_finished"; parent: string | null; tool_use_id: string; is_error: boolean; output: string }
  | { kind: "test_run"; parent: string | null; tool_use_id: string; command: string; run: TestRun }
  | { kind: "retrying"; attempt: number; max_retries: number; error: string }
  | { kind: "turn_done"; is_error: boolean; result: string | null; cost_usd: number | null; duration_ms: number | null; auth_hint: boolean; denied: number; context_window: number | null }
  | { kind: "context_used"; tokens: number }
  | { kind: "background_tasks"; tasks: { id: string; task_type: string; description: string }[] }
  | { kind: "task_started"; task_id: string; tool_use_id: string }
  | { kind: "task_ended"; task_id: string; tool_use_id: string; status: string; summary: string }
  | { kind: "commands"; commands: SlashCommand[] }
  | { kind: "models"; models: ModelOption[] }
  | { kind: "mcp_tools"; tools: string[] }
  | { kind: "conversation_reset" }
  | { kind: "permission_requested"; request_id: string; tool_name: string; input: unknown }
  | { kind: "session_ended"; code: number | null; stderr_tail: string }
  | { kind: "shell_output"; id: string; text: string }
  | { kind: "shell_done"; id: string; code: number | null; stopped: boolean }
  | { kind: "shell_secret"; id: string; secret: boolean }
  | { kind: "unknown"; raw: unknown }
  | { kind: "parse_error"; line: string };

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

export interface FileDiff {
  path: string;
  original: string;
  current: string;
  created: boolean;
  deleted: boolean;
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
  kind: "skill" | "command";
  source: "user" | "project" | "plugin";
  plugin: string | null;
  path: string;
  description: string;
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
