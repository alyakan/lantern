import { describe, expect, it } from "vitest";
import rulesRs from "../../src-tauri/src/permission/rules.rs?raw";
import * as mirror from "./permissionRules";
import { describeRule, isPlainCommand, isPrefix, programName, ruleChoices, rulePattern } from "./permissionRules";

/** The strings in a `const NAME: &[&str] = &[...]` list of rules.rs. */
function rustStrings(name: string): string[] {
  const list = new RegExp(`const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\]`).exec(rulesRs)?.[1];
  if (list === undefined) throw new Error(`rules.rs has no ${name}`);
  return [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** The `(program, [subcommands])` pairs of rules.rs's VETTED list. */
function rustVetted(): [string, string[]][] {
  const start = rulesRs.indexOf("const VETTED");
  const body = rulesRs.slice(start, rulesRs.indexOf("\n];", start));
  return [...body.matchAll(/\("([^"]+)", &\[([^\]]*)\]\)/g)].map((m) => [m[1], [...m[2].matchAll(/"([^"]+)"/g)].map((s) => s[1])]);
}

describe("the lists mirror the backend's", () => {
  it("match rules.rs", () => {
    expect(mirror.WRAPPERS).toEqual(rustStrings("WRAPPERS"));
    expect(mirror.DENIED_FIRST).toEqual(rustStrings("DENIED_FIRST"));
    expect(mirror.BASH_KEYS).toEqual(rustStrings("BASH_KEYS"));
    expect(mirror.NEVER_AUTO_TOOLS).toEqual(rustStrings("NEVER_AUTO"));
    expect(mirror.REFUSED_PREFIXES).toEqual(rustStrings("REFUSED_PREFIXES"));
    expect(mirror.REFUSED_NAMES).toEqual(rustStrings("REFUSED_NAMES"));
    expect(mirror.REFUSED_SHORT).toEqual(rustStrings("REFUSED_SHORT"));
    expect(mirror.VETTED).toEqual(rustVetted());
  });

  it("the file tools and their keys match rules.rs", () => {
    const rows = [...rulesRs.matchAll(/\("(\w+)", "(\w+)", &\[([^\]]*)\]\)/g)].map((m) => [m[1], m[2], [...m[3].matchAll(/"(\w+)"/g)].map((k) => k[1])]);
    expect(rows.length).toBe(Object.keys(mirror.FILE_TOOLS).length);
    for (const [tool, key, keys] of rows) expect(mirror.FILE_TOOLS[tool as string]).toEqual({ key, keys });
  });
});

describe("isPrefix", () => {
  it("accepts the vetted commands and plain readers", () => {
    for (const text of ["npm test", "git status", "git diff", "git log", "cargo test", "cargo build", "cargo check", "ls", "rg"]) {
      expect(isPrefix(text), text).toBe(true);
    }
  });

  it("refuses everything outside the vetted list, and every spelling of it", () => {
    for (const text of ["npm ci", "npm install", "npm audit", "yarn install", "docker ps", "gh pr", "brew install", "/bin/sh", "/usr/bin/git", "git3", "Git", "./git status", "~/git", "npm@10", "python3.12", "Python", "nodejs", "bash5", "Rm", "node.js", "sh", "npx", "git", "npm", "npm run", "npm exec", "docker exec", "find", "osascript", "git add", "git push"]) {
      expect(isPrefix(text), text).toBe(false);
    }
  });
});

describe("programName", () => {
  it("reduces the spellings to one name", () => {
    expect(programName("/usr/bin/python3")).toBe("python");
    expect(programName("python3.12")).toBe("python");
    expect(programName("Python")).toBe("python");
    expect(programName("nodejs")).toBe("node");
    expect(programName("bash5")).toBe("bash");
    expect(programName("js")).toBe("js");
  });
});

describe("ruleChoices", () => {
  it("offers the exact command and the first one or two words for a Bash command", () => {
    // Not "npm" alone: a subcommand tool's prefix names its subcommand.
    expect(ruleChoices("Bash", { command: "npm test" })).toEqual([
      { tool: "Bash", kind: "exact", text: "npm test" },
      { tool: "Bash", kind: "prefix", text: "npm test" },
    ]);
    // An option (-la) is never a prefix word.
    expect(ruleChoices("Bash", { command: "ls -la" })).toEqual([
      { tool: "Bash", kind: "exact", text: "ls -la" },
      { tool: "Bash", kind: "prefix", text: "ls" },
    ]);
  });

  it("offers only the exact command where a prefix would be refused", () => {
    expect(ruleChoices("Bash", { command: "npm run build" })).toEqual([{ tool: "Bash", kind: "exact", text: "npm run build" }]);
    expect(ruleChoices("Bash", { command: "python x.py" })).toEqual([{ tool: "Bash", kind: "exact", text: "python x.py" }]);
    expect(ruleChoices("Bash", { command: "./build.sh" })).toEqual([{ tool: "Bash", kind: "exact", text: "./build.sh" }]);
  });

  it("offers only the exact command when the prefix would be refused, quoted or writing", () => {
    expect(ruleChoices("Bash", { command: "git log --output=/tmp/x" })).toEqual([{ tool: "Bash", kind: "exact", text: "git log --output=/tmp/x" }]);
    expect(ruleChoices("Bash", { command: "git log --grep='fix bug'" })).toEqual([{ tool: "Bash", kind: "exact", text: "git log --grep='fix bug'" }]);
    expect(ruleChoices("Bash", { command: "git log --oneline -5" })).toEqual([
      { tool: "Bash", kind: "exact", text: "git log --oneline -5" },
      { tool: "Bash", kind: "prefix", text: "git log" },
    ]);
  });

  it("offers nothing for a command with shell operators, or input a rule can't read", () => {
    for (const input of [{ command: "npm test; rm -rf ~" }, { command: "npm test $(whoami)" }, { command: "npm test\nrm x" }, { command: "npm test", dangerouslyDisableSandbox: true }, { cmd: "npm test" }, "npm test", null]) {
      expect(ruleChoices("Bash", input), JSON.stringify(input)).toEqual([]);
    }
  });

  it("offers a file its own name's folder and any file, for a file tool", () => {
    expect(ruleChoices("Edit", { file_path: "/p/src/a.ts", old_string: "a", new_string: "b" })).toEqual([
      { tool: "Edit", kind: "any" },
      { tool: "Edit", kind: "dir", path: "/p/src" },
    ]);
    expect(ruleChoices("Write", { file_path: "/a.txt", content: "x" })).toEqual([{ tool: "Write", kind: "any" }]);
  });

  it("offers nothing for a relative path, a key a tool doesn't take, or the wrong path key", () => {
    expect(ruleChoices("Edit", { file_path: "src/a.ts" })).toEqual([]);
    expect(ruleChoices("Write", { file_path: "/p/a", content: "x", extra: 1 })).toEqual([]);
    expect(ruleChoices("NotebookEdit", { file_path: "/p/n.ipynb", notebook_path: "/p/n.ipynb" })).toEqual([]);
    expect(ruleChoices("NotebookEdit", { notebook_path: "/p/n.ipynb" })).toEqual([
      { tool: "NotebookEdit", kind: "any" },
      { tool: "NotebookEdit", kind: "dir", path: "/p" },
    ]);
  });

  it("offers any call for another tool, and never for a tool no rule answers", () => {
    expect(ruleChoices("mcp__linear__save_issue", { title: "x" })).toEqual([{ tool: "mcp__linear__save_issue", kind: "any" }]);
    for (const tool of ["ExitPlanMode", "AskUserQuestion", "Reproduce", "mcp__lantern__approve"]) {
      expect(ruleChoices(tool, {}), tool).toEqual([]);
    }
  });
});

describe("rule text", () => {
  it("says what a rule covers", () => {
    expect(rulePattern({ tool: "Bash", kind: "exact", text: "npm test" })).toBe("npm test");
    expect(rulePattern({ tool: "Bash", kind: "prefix", text: "npm test" })).toBe("npm test …");
    expect(rulePattern({ tool: "Edit", kind: "dir", path: "/p/src" })).toBe("/p/src/");
    expect(rulePattern({ tool: "Edit", kind: "any" })).toBe("any file");
    expect(rulePattern({ tool: "mcp__x__y", kind: "any" })).toBe("any call");
    expect(describeRule({ tool: "Bash", kind: "prefix", text: "git status" })).toBe("Bash: git status …");
  });

  it("is plain only without shell operators, substitutions or controls", () => {
    expect(isPlainCommand("npm test -- --grep \"a b\"")).toBe(true);
    for (const c of ["a;b", "a&b", "a|b", "a`b`", "a$b", "a\\b", "a*", "a{b}", "a\tb", "a\u0007b"]) expect(isPlainCommand(c), JSON.stringify(c)).toBe(false);
  });
});
