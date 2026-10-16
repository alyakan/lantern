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
/** Programs that run other commands (a second layer behind VETTED). */
export const WRAPPERS = ["sh", "bash", "zsh", "dash", "fish", "ksh", "env", "sudo", "su", "doas", "xargs", "eval", "exec", "command", "nohup", "time", "timeout", "nice", "ssh", "npx", "bunx", "pnpx", "uvx", "pipx"];
/** Programs a prefix can't start with (a second layer behind VETTED). */
export const DENIED_FIRST = [
  "python", "node", "deno", "bun", "ruby", "perl", "php", "awk", "gawk", "sed", "find", "rm", "rmdir", "mv", "cp", "dd", "chmod", "chown", "curl", "wget", "tee", "make", "osascript", "open", "ln", "truncate", "shred", "tar", "unzip", "rsync", "scp", "nc", "ncat", "telnet", "kill", "killall", "pkill", "launchctl", "defaults", "security", "networksetup", "diskutil", "hdiutil", "crontab", "at", "tmux", "screen", "script", "expect", "swift", "xcodebuild", "gcc", "clang", "cc",
];
/** The Bash prefixes a rule can be made of: a program and its subcommand, or a program that only reads (see VETTED in rules.rs). */
export const VETTED: [string, string[]][] = [
  ["git", ["status", "diff", "log", "show", "branch", "rev-parse"]],
  ["npm", ["test"]],
  ["cargo", ["test", "check", "build", "clippy"]],
  ["go", ["test", "vet"]],
  ["ls", []],
  ["pwd", []],
  ["which", []],
  ["whoami", []],
  ["date", []],
];

/** The flags a vetted command takes after its prefix (see benign_flags in rules.rs). */
export const BENIGN_FLAGS: Record<string, string[]> = {
  "git status": ["--oneline", "--stat", "--name-only", "--name-status", "--porcelain", "--short", "--no-color", "--cached"],
  "git diff": ["--oneline", "--stat", "--name-only", "--name-status", "--porcelain", "--short", "--no-color", "--cached"],
  "git log": ["--oneline", "--stat", "--name-only", "--name-status", "--porcelain", "--short", "--no-color", "--cached"],
  "git show": ["--oneline", "--stat", "--name-only", "--name-status", "--porcelain", "--short", "--no-color", "--cached"],
  "git branch": ["--oneline", "--stat", "--name-only", "--name-status", "--porcelain", "--short", "--no-color", "--cached"],
  ls: ["-l", "-a", "-la", "-lh", "-R"],
  "cargo test": ["--release", "--all", "--workspace", "--lib", "--quiet", "-q"],
  "cargo check": ["--release", "--all", "--workspace", "--lib", "--quiet", "-q"],
  "cargo build": ["--release", "--all", "--workspace", "--lib", "--quiet", "-q"],
  "cargo clippy": ["--release", "--all", "--workspace", "--lib", "--quiet", "-q"],
  "go test": ["-v"],
  "go vet": ["-v"],
};

const WORD = /^[A-Za-z0-9_\-./:@=+,]+$/;
// The characters that keep a command from matching a rule (shell operators, substitutions, globs, escapes, controls).
const NOT_PLAIN = /[;&|<>()$`\\*?[\]{}\u0000-\u001f\u007f-\u009f]/;

/** Whether a command is plain enough to match a rule. */
export function isPlainCommand(command: string): boolean {
  return !NOT_PLAIN.test(command);
}

/** A plain token: letters, digits and `_ - . / : @ + ,`. */
function plainToken(s: string): boolean {
  return s !== "" && /^[A-Za-z0-9_\-./:@+,]+$/.test(s);
}

/** Whether a flag after a vetted prefix is one it takes. */
function flagAllowed(prefix: string, flag: string): boolean {
  if ((BENIGN_FLAGS[prefix] ?? []).includes(flag)) return true;
  if (!prefix.startsWith("git ")) return false;
  const digits = flag.startsWith("-") ? flag.slice(1) : "";
  return flag === "-n" || (digits !== "" && /^[0-9]+$/.test(digits)) || (flag.startsWith("--format=") && plainToken(flag.slice("--format=".length)));
}

/** Whether the arguments after a vetted prefix are all allowed: flags it takes, and plain positional tokens inside the folder. */
export function argumentsAllowed(prefix: string, args: string[]): boolean {
  return args.every((arg) => (arg.startsWith("-") ? flagAllowed(prefix, arg) : prefix !== "git branch" && !arg.startsWith("/") && !arg.includes("..") && plainToken(arg)));
}

/** A prefix the backend would make: a vetted command (VETTED) of plain words, and not a wrapper or a denied program. */
export function isPrefix(text: string): boolean {
  const words = text.split(" ");
  const [program, sub] = words;
  const entry = VETTED.find(([name]) => name === program);
  const vetted = words.length === 1 ? !!entry && entry[1].length === 0 : words.length === 2 ? !!entry && entry[1].includes(sub) : false;
  const name = programName(program);
  return text.length >= 2 && vetted && !WRAPPERS.includes(name) && !DENIED_FIRST.includes(name) && words.every((w) => w !== "" && !w.startsWith("-") && WORD.test(w));
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

/** A path the backend would match on: absolute, with no `..` in it. */
function isPlainPath(path: string): boolean {
  return path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\u0000");
}

/** Names no file-tool rule covers, git, editor and Claude config and the build and package files (see PROTECTED_NAMES in rules.rs). */
export const PROTECTED_NAMES = [
  ".git", ".claude", ".mcp.json", ".vscode", ".idea", ".husky", ".gitmodules", ".gitattributes", ".gitconfig", ".envrc", ".cargo", ".npmrc", ".yarnrc", ".yarnrc.yml", ".yarn", ".pnpmfile.cjs", ".githooks", ".pre-commit-config.yaml", ".cursor", ".zed", "package.json", "Cargo.toml", "build.rs", "Makefile", "go.mod",
];

/** Whether a path has a protected component. Names match in any case, as on a case-insensitive filesystem. */
function isProtectedPath(path: string): boolean {
  return path.split("/").some((part) => PROTECTED_NAMES.some((name) => name.toLowerCase() === part.toLowerCase()));
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
    // A prefix never matches a command with a quote in it, nor one whose arguments aren't allowed (see rules.rs).
    if (/['"]/.test(command)) return out;
    const two = words.slice(0, 2).join(" ");
    if (words.length >= 2 && isPrefix(two) && argumentsAllowed(two, words.slice(2))) out.push({ tool, kind: "prefix", text: two });
    if (isPrefix(words[0]) && argumentsAllowed(words[0], words.slice(1))) out.push({ tool, kind: "prefix", text: words[0] });
    return out;
  }
  const file = FILE_TOOLS[tool];
  if (file) {
    if (Object.keys(o).some((k) => !file.keys.includes(k))) return [];
    const path = o[file.key];
    if (typeof path !== "string" || !isPlainPath(path) || isProtectedPath(path)) return [];
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

/** The tools Settings offers a hand-made rule for; "other" is a tool typed by name (an MCP tool, say). */
export const HAND_TOOLS = ["Bash", "Read", "Edit", "Write", "WebFetch", "WebSearch", "other"] as const;
export type HandTool = (typeof HAND_TOOLS)[number];

/** What a hand-made rule covers: a Bash command's start or the exact command, a folder's files, or every call. */
export type HandMatch = "prefix" | "exact" | "dir" | "any";

/** What the Add a rule form holds. */
export type HandForm = { tool: HandTool; otherName: string; match: HandMatch; pattern: string; scope: RuleScope };

/** The ways a tool's rule can cover calls, first one the default. */
export function handMatches(tool: HandTool): HandMatch[] {
  if (tool === "Bash") return ["prefix", "exact"];
  if (tool === "Read" || tool === "Edit" || tool === "Write") return ["dir", "any"];
  return ["any"];
}

/** The rule a form makes, in the shape the cards make (see ruleChoices), with what it means in words, or why it can't be made.
 *  `broad` is a rule that lets Claude do a lot without asking, which Settings makes the user confirm. */
export type HandRule = { error: string } | { rule: Rule; meaning: string; broad: string | null };

const trim = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

/** Checks a form against what the backend accepts (validate in rules.rs) so a rule is refused here in plain words, not by an error. */
export function handRule(form: HandForm): HandRule {
  const tool = form.tool === "other" ? form.otherName.trim() : form.tool;
  if (!tool) return { error: "Type the tool's name, like mcp__linear__save_issue." };
  if (/\s/.test(tool) || tool.length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(tool)) return { error: "A tool's name has no spaces in it, like mcp__linear__save_issue." };
  if (NEVER_AUTO_TOOLS.includes(tool) || tool.startsWith("mcp__lantern__")) return { error: `${tool} always asks, because its card has something for you to read or answer.` };
  if (form.tool === "other" && (tool === "Bash" || FILE_TOOLS[tool])) return { error: `Pick ${tool} from the list: it needs a command or a folder.` };
  const match = handMatches(form.tool).includes(form.match) ? form.match : handMatches(form.tool)[0];
  const pattern = form.pattern.trim();
  if (match === "any") {
    const everything = FILE_TOOLS[tool] ? `any file ${tool === "Read" ? "it reads" : tool === "Edit" ? "it edits" : "it writes"}` : `every ${tool} call`;
    return { rule: { tool, kind: "any" }, meaning: `Always allow ${tool} for ${FILE_TOOLS[tool] ? "any file" : "every call"}`, broad: `This lets Claude use ${tool} on ${everything} without asking${FILE_TOOLS[tool] ? " (git, editor and config files still ask)" : ""}.` };
  }
  if (!pattern) return { error: match === "dir" ? "Type the folder the rule covers." : "Type the command." };
  if (tool === "Bash") {
    if (pattern === "*" || pattern === "Bash") return { error: "A rule can't cover every command. Type a command's start, like npm test, or one exact command." };
    if (match === "exact") {
      if (pattern.length < 2) return { error: "That command is too short to make a rule for." };
      if (!isPlainCommand(pattern)) return { error: "Rules only match plain commands: no ; & | < > $ ` \\ * ? ( ) [ ] { } and no line breaks." };
      const first = programName(pattern.split(" ")[0]);
      const risky = WRAPPERS.includes(first) || DENIED_FIRST.includes(first);
      return { rule: { tool, kind: "exact", text: pattern }, meaning: `Always allow the Bash command ${pattern}`, broad: risky ? `This lets Claude run \`${pattern}\` without asking. It can run other programs or change or delete files.` : null };
    }
    const text = pattern.split(/ +/).join(" ");
    if (!isPrefix(text)) return { error: "A command's start can only be a read-only, build or test command, like git status, npm test, cargo build or ls. For anything else, choose This exact command." };
    return { rule: { tool, kind: "prefix", text }, meaning: `Always allow Bash commands starting with ${text}`, broad: null };
  }
  if (FILE_TOOLS[tool]) {
    const path = trim(pattern);
    if (!path.startsWith("/")) return { error: "Type the folder's full path, starting with /." };
    if (!isPlainPath(path)) return { error: "A folder path can't have .. in it." };
    if (path === "/") return { error: "A rule can't cover the whole disk. Pick a folder." };
    if (isProtectedPath(path)) return { error: "Rules don't cover git, editor, Claude or build config folders (.git, .claude, .vscode, package.json…)." };
    const shallow = path.split("/").filter(Boolean).length <= 2;
    return { rule: { tool, kind: "dir", path }, meaning: `Always allow ${tool} for files in ${path}`, broad: shallow ? `This lets Claude ${tool === "Read" ? "read" : tool === "Edit" ? "edit" : "write"} every file in ${path}, a very large folder, without asking.` : null };
  }
  return { error: "That tool's rule covers every call." };
}
