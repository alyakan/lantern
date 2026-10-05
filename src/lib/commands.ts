/**
 * Which Bash commands matter to the task: ones that change or check the project (installs, migrations, generators,
 * builds, tests, writes), as opposed to looking around (cd, ls, cat, grep, gh pr view…) and git bookkeeping
 * (add, commit, switch, push…).
 */

/** Commands that only read or move around. */
const READ_ONLY = new Set([
  "cd", "pushd", "popd", "ls", "pwd", "cat", "bat", "head", "tail", "less", "more", "grep", "egrep", "rg", "ag", "ack", "find", "fd", "wc",
  "echo", "printf", "which", "whereis", "type", "command", "stat", "file", "tree", "sleep", "true", "false", "sort", "uniq", "diff", "cmp",
  "du", "df", "env", "printenv", "whoami", "id", "date", "basename", "dirname", "realpath", "readlink", "jq", "yq", "column", "cut", "tr",
  "nl", "od", "xxd", "hexdump", "strings", "ps", "lsof", "uname", "sw_vers", "man", "open", "export", "set", "unset", "awk", "base64", "test", "[",
]);

/** git subcommands that change the code itself; the rest is looking around or bookkeeping (add, commit, branch, push…). */
const GIT_CHANGES_CODE = new Set(["apply", "am", "merge", "rebase", "cherry-pick", "revert", "pull"]);

/** gh subcommands that only read; `gh api` reads unless it sends something. */
const GH_READS = new Set(["view", "diff", "list", "status", "checks", "search", "browse"]);

/** Shell keywords in front of a command (`for x in …; do cmd; done`): they don't decide, the command does. */
const KEYWORDS = new Set(["do", "done", "then", "else", "elif", "fi", "esac", "{", "}", "(", ")"]);

/** Wrappers that run the command after them. */
const WRAPPERS = new Set(["sudo", "time", "nice", "nohup", "xargs", "exec"]);

/** Output redirected into a file (not a descriptor, not /dev/null). */
const WRITES_FILE = /(^|[^\d&>])>{1,2}\s*(?!&|\/dev\/null)[^\s|;&]/;

/** The command without heredoc bodies (a script fed to python isn't commands), and with quoted text blanked out. */
function masked(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]);
    const tag = /<<-?\s*(['"]?)(\w+)\1/.exec(lines[i])?.[2];
    if (tag) while (i + 1 < lines.length && lines[++i].trim() !== tag);
  }
  let out = "";
  let quote: string | null = null;
  const text = kept.join("\n");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') {
        out += "__";
        i++;
      } else if (c === quote) {
        out += c;
        quote = null;
      } else out += "_";
    } else {
      if (c === "'" || c === '"') quote = c;
      if (c === "\\" && text[i + 1] === "\n") {
        out += " ";
        i++;
        continue;
      }
      out += c;
    }
  }
  return out;
}

function readOnlyPart(part: string): boolean {
  if (WRITES_FILE.test(part)) return false;
  let words = part.trim().split(/\s+/).filter(Boolean);
  // Leading keywords, variable assignments (FOO=1 cmd) and wrappers don't decide.
  while (words.length && (KEYWORDS.has(words[0]) || /^\w+=/.test(words[0]) || WRAPPERS.has(words[0].split("/").pop()!))) {
    const wrapper = WRAPPERS.has(words[0].split("/").pop()!);
    words = words.slice(1);
    // A wrapper's own options (time -p, nice -n 10) aren't the command.
    while (wrapper && words.length && words[0].startsWith("-")) words = words.slice(words[0] === "-n" || words[0] === "-u" ? 2 : 1);
  }
  if (!words.length) return true;
  // `for x in a b` and `while cond` are the loop, not a command.
  if (words[0] === "for" || words[0] === "select") return true;
  if (words[0] === "while" || words[0] === "until" || words[0] === "if" || words[0] === "case") words = words.slice(1);
  if (!words.length) return true;
  const cmd = words[0].split("/").pop()!;
  if (cmd === "git") {
    // The subcommand is the first word that isn't an option, or the value of one that takes a value (-C dir).
    let i = 1;
    while (i < words.length && words[i].startsWith("-")) i += ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(words[i]) ? 2 : 1;
    const sub = words[i];
    // `git apply --stat` / `--numstat` / `--check` only report.
    if (sub === "apply" && words.some((w) => /^--(stat|numstat|summary|check)$/.test(w)) && !words.includes("--apply")) return true;
    return !sub || !GIT_CHANGES_CODE.has(sub);
  }
  if (cmd === "gh") {
    const [group, action] = words.slice(1).filter((w) => !w.startsWith("-"));
    if (group === "api") {
      const at = words.findIndex((w) => w === "-X" || w === "--method");
      const method = at >= 0 ? words[at + 1] : undefined;
      const sends = words.some((w) => /^(-[fF]|--field|--raw-field|--input)$/.test(w));
      return method ? method.toUpperCase() === "GET" : !sends;
    }
    return group === "search" || group === "status" || (group === "auth" && action === "status") || GH_READS.has(action ?? "");
  }
  if (cmd === "curl") return !words.some((w) => /^(-X|--request|-d|--data.*|-F|--form|-T|--upload-file|-o|-O|--output|--remote-name)$/.test(w));
  if (cmd === "sed") return !words.some((w) => /^-[a-zA-Z]*i/.test(w) || w === "--in-place");
  if (cmd === "docker") return ["ps", "images", "logs", "inspect", "version", "info"].includes(words[1] ?? "");
  return READ_ONLY.has(cmd);
}

/** Whether a Bash command changes or checks the project, rather than only reading around or git bookkeeping. */
export function mattersToTask(command: string): boolean {
  const parts = masked(command).split(/&&|\|\||;|\||\n/);
  return parts.some((p) => p.trim() && !readOnlyPart(p));
}
