import type { NewRule, Rule, RuleScope } from "../types";

// What the card offers as "Always allow…" choices. The backend decides what a rule matches (src-tauri/src/permission/
// rules.rs), and refuses any rule it wouldn't make; these lists mirror its lists, so the card only offers rules it accepts.
// permissionRules.test.ts checks the two agree.

/** Tools no rule answers: their card carries something to read or answer, or it's Lantern's own. */
export const NEVER_AUTO_TOOLS = ["ExitPlanMode", "AskUserQuestion", "Reproduce"];
/** The Bash input keys a rule can read. */
export const BASH_KEYS = ["command", "description", "timeout", "run_in_background"];
/** Claude Code's file tools, with the path key each acts on and every key its input may have. */
export const FILE_TOOLS: Record<string, { key: string; keys: string[] }> = {
  Read: { key: "file_path", keys: ["file_path", "offset", "limit", "pages"] },
  Write: { key: "file_path", keys: ["file_path", "content"] },
  Edit: { key: "file_path", keys: ["file_path", "old_string", "new_string", "replace_all"] },
  MultiEdit: { key: "file_path", keys: ["file_path", "edits"] },
  NotebookEdit: { key: "notebook_path", keys: ["notebook_path", "cell_id", "cell_type", "edit_mode", "new_source"] },
};
/** Programs that run other commands. */
export const WRAPPERS = ["sh", "bash", "zsh", "dash", "fish", "ksh", "env", "sudo", "su", "doas", "xargs", "eval", "exec", "command", "nohup", "time", "timeout", "nice", "ssh", "npx", "bunx", "pnpx", "uvx", "pipx"];
/** Programs a prefix can't start with: interpreters, and tools whose flags run or destroy things. */
export const DENIED_FIRST = [
  "python", "node", "deno", "bun", "ruby", "perl", "php", "awk", "gawk", "sed", "find", "rm", "rmdir", "mv", "cp", "dd", "chmod", "chown", "curl", "wget", "tee", "make", "osascript", "open", "ln", "truncate", "shred", "tar", "unzip", "rsync", "scp", "nc", "ncat", "telnet", "kill", "killall", "pkill", "launchctl", "defaults", "security", "networksetup", "diskutil", "hdiutil", "crontab", "at", "tmux", "screen", "script", "expect", "swift", "xcodebuild", "gcc", "clang", "cc",
];
/** The Bash prefixes a rule can be made of: a program and its subcommand, or a program that only reads (see VETTED in rules.rs). */
export const VETTED: [string, string[]][] = [
  ["git", ["status", "diff", "log", "show", "branch", "remote", "rev-parse", "ls-files", "blame"]],
  ["npm", ["test", "outdated", "ls"]],
  ["yarn", ["test", "outdated", "ls"]],
  ["pnpm", ["test", "outdated", "ls"]],
  ["cargo", ["test", "check", "build", "clippy", "fmt", "doc", "tree"]],
  ["go", ["test", "build", "vet", "list"]],
  ["ls", []],
  ["pwd", []],
  ["cat", []],
  ["head", []],
  ["tail", []],
  ["wc", []],
  ["which", []],
  ["whoami", []],
  ["date", []],
  ["echo", []],
  ["tsc", []],
  ["vitest", []],
  ["jest", []],
  ["pytest", []],
  ["eslint", []],
  ["rg", []],
  ["grep", []],
  ["diff", []],
  ["file", []],
  ["stat", []],
  ["du", []],
  ["df", []],
];
/** Arguments that make a command write somewhere or run a program of its choice; a prefix never matches a command with one. */
export const REFUSED_PREFIXES = ["--out", "--exec", "--upload-pack", "--receive-pack", "--ssh-command", "--editor", "--pager", "--config", "--git-dir", "--work-tree"];
export const REFUSED_NAMES = ["--ext-diff", "--textconv", "--pre", "--pre-glob"];
export const REFUSED_SHORT = ["-o", "-c", "-C"];

/** Whether an argument after a prefix makes its command write somewhere or run a program of its choice. */
export function refusedArgument(arg: string): boolean {
  const name = arg.split("=")[0];
  return REFUSED_PREFIXES.some((p) => name.startsWith(p)) || REFUSED_NAMES.includes(name) || REFUSED_SHORT.some((s) => arg.startsWith(s));
}

const WORD = /^[A-Za-z0-9_\-./:@=+,]+$/;
// The characters that keep a command from matching a rule (shell operators, substitutions, globs, escapes, controls).
const NOT_PLAIN = /[;&|<>()$`\\*?[\]{}\u0000-\u001f\u007f-\u009f]/;

/** Whether a command is plain enough to match a rule. */
export function isPlainCommand(command: string): boolean {
  return !NOT_PLAIN.test(command);
}

/** The program a first word names, spelled plainly (see `program_name` in rules.rs). */
export function programName(word: string): string {
  let name = (word.split("/").pop() ?? word).toLowerCase();
  for (;;) {
    const trimmed = name.replace(/[0-9.]+$/, "");
    const next = trimmed.endsWith("js") && trimmed.length > 2 ? trimmed.slice(0, -2) : trimmed;
    if (next.length === name.length) return name;
    name = next;
  }
}

/** A prefix the backend would make: a vetted command (VETTED) of plain words, none an option, and not a wrapper or a denied program. */
export function isPrefix(text: string): boolean {
  const words = text.split(" ");
  const [program, sub] = words;
  const entry = VETTED.find(([name]) => name === program);
  const vetted = words.length === 1 ? !!entry && entry[1].length === 0 : words.length === 2 ? !!entry && entry[1].includes(sub) : false;
  const name = programName(program);
  return text.length >= 2 && vetted && !WRAPPERS.includes(name) && !DENIED_FIRST.includes(name) && words.every((w) => w !== "" && !w.startsWith("-") && WORD.test(w));
}

/** A path the backend would match on: absolute, with no `..` in it. */
function isPlainPath(path: string): boolean {
  return path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\u0000");
}

/** The rules the card can offer for a tool call: none when the input isn't one a rule can read. Scope comes from the menu. */
export function ruleChoices(tool: string, input: unknown): Rule[] {
  if (!input || typeof input !== "object" || NEVER_AUTO_TOOLS.includes(tool) || tool.startsWith("mcp__lantern__")) return [];
  const o = input as Record<string, unknown>;
  if (tool === "Bash") {
    const command = o.command;
    if (typeof command !== "string" || Object.keys(o).some((k) => !BASH_KEYS.includes(k)) || !isPlainCommand(command) || command.length < 2) return [];
    const words = command.split(" ").filter(Boolean);
    const out: Rule[] = [{ tool, kind: "exact", text: command }];
    // A prefix never matches a command with a quote in it, nor one whose arguments write or run code (see rules.rs).
    if (/['"]/.test(command)) return out;
    const two = words.slice(0, 2).join(" ");
    if (words.length >= 2 && isPrefix(two) && !words.slice(2).some(refusedArgument)) out.push({ tool, kind: "prefix", text: two });
    if (isPrefix(words[0]) && !words.slice(1).some(refusedArgument)) out.push({ tool, kind: "prefix", text: words[0] });
    return out;
  }
  const file = FILE_TOOLS[tool];
  if (file) {
    if (Object.keys(o).some((k) => !file.keys.includes(k))) return [];
    const path = o[file.key];
    if (typeof path !== "string" || !isPlainPath(path)) return [];
    const out: Rule[] = [{ tool, kind: "any" }];
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir.length > 1) out.push({ tool, kind: "dir", path: dir });
    return out;
  }
  return [{ tool, kind: "any" }];
}

/** What a rule covers, in words: the command or its start, a folder, or any call. */
export function rulePattern(rule: Rule): string {
  switch (rule.kind) {
    case "exact":
      return rule.text;
    case "prefix":
      return `${rule.text} …`;
    case "dir":
      return `${rule.path}/`;
    case "any":
      return FILE_TOOLS[rule.tool] ? "any file" : "any call";
  }
}

/** A rule as a short line: the tool, then what it covers. */
export function describeRule(rule: Rule): string {
  return `${rule.tool}: ${rulePattern(rule)}`;
}

/** The menu's two scopes, with their headings. */
export const RULE_SCOPES: [RuleScope, string][] = [
  ["chat", "This chat"],
  ["folder", "This folder"],
];

/** A rule made in a scope, as the backend takes it. */
export function newRule(scope: RuleScope, rule: Rule): NewRule {
  return { scope, ...rule };
}
