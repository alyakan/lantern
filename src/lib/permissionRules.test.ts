import { describe, expect, it } from "vitest";
import rulesRs from "../../src-tauri/src/permission/rules.rs?raw";
import * as mirror from "./permissionRules";
import { describeRule, handRule, isPlainCommand, isPrefix, programName, ruleChoices, rulePattern, type HandForm } from "./permissionRules";

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

/** The flags of rules.rs's benign_flags match, by prefix (each arm can list several prefixes). */
function rustBenign(): Record<string, string[]> {
  const start = rulesRs.indexOf("fn benign_flags");
  const body = rulesRs.slice(start, rulesRs.indexOf("_ => &[]", start));
  const out: Record<string, string[]> = {};
  for (const arm of body.matchAll(/((?:"[^"]+"\s*\|\s*)*"[^"]+")\s*=>\s*&\[([^\]]*)\]/g)) {
    const flags = [...arm[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    for (const name of arm[1].matchAll(/"([^"]+)"/g)) out[name[1]] = flags;
  }
  return out;
}

describe("the lists mirror the backend's", () => {
  it("match rules.rs", () => {
    expect(mirror.WRAPPERS).toEqual(rustStrings("WRAPPERS"));
    expect(mirror.DENIED_FIRST).toEqual(rustStrings("DENIED_FIRST"));
    expect(mirror.BASH_KEYS).toEqual(rustStrings("BASH_KEYS"));
    expect(mirror.PROTECTED_NAMES).toEqual(rustStrings("PROTECTED_NAMES"));
    expect(mirror.NEVER_AUTO_TOOLS).toEqual(rustStrings("NEVER_AUTO"));
    expect(mirror.VETTED).toEqual(rustVetted());
    expect(mirror.BENIGN_FLAGS).toEqual(rustBenign());
  });

  it("the file tools and their keys match rules.rs", () => {
    const rows = [...rulesRs.matchAll(/\("(\w+)", "(\w+)", &\[([^\]]*)\]\)/g)].map((m) => [m[1], m[2], [...m[3].matchAll(/"(\w+)"/g)].map((k) => k[1])]);
    expect(rows.length).toBe(Object.keys(mirror.FILE_TOOLS).length);
    for (const [tool, key, keys] of rows) expect(mirror.FILE_TOOLS[tool as string]).toEqual({ key, keys });
  });
});

describe("isPrefix", () => {
  it("accepts the vetted commands and plain readers", () => {
    for (const text of ["npm test", "git status", "git diff", "git log", "git rev-parse", "cargo test", "cargo build", "cargo check", "cargo clippy", "go vet", "ls", "pwd"]) {
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
    for (const command of ["git log --output=/tmp/x", "git log --grep='fix bug'", "git log /etc/passwd", "git diff --output=x", "npm test -- --coverage", "cargo build --target-dir=/x", "git branch newname"]) {
      expect(ruleChoices("Bash", { command }), command).toEqual([{ tool: "Bash", kind: "exact", text: command }]);
    }
  });

  it("offers the prefix when its arguments are the flags or plain words it takes", () => {
    expect(ruleChoices("Bash", { command: "git log --oneline -5" })).toEqual([
      { tool: "Bash", kind: "exact", text: "git log --oneline -5" },
      { tool: "Bash", kind: "prefix", text: "git log" },
    ]);
    expect(ruleChoices("Bash", { command: "cargo test --release" })).toEqual([
      { tool: "Bash", kind: "exact", text: "cargo test --release" },
      { tool: "Bash", kind: "prefix", text: "cargo test" },
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

  it("offers nothing for a build or package file, whatever its case, so each one asks", () => {
    for (const path of ["/p/.GIT/config", "/p/.Claude/settings.json", "/p/.MCP.JSON", "/p/Package.JSON", "/p/.cargo/config.toml", "/p/package.json", "/p/Cargo.toml", "/p/build.rs", "/p/Makefile", "/p/go.mod", "/p/.yarn/releases/yarn.cjs"]) {
      expect(ruleChoices("Write", { file_path: path, content: "x" }), path).toEqual([]);
    }
    expect(ruleChoices("Write", { file_path: "/p/src/main.rs", content: "x" })).toHaveLength(2);
  });

  it("offers nothing for a file inside git or config folders, so each one asks", () => {
    for (const path of ["/p/.git/config", "/p/.git/hooks/pre-commit", "/p/.claude/settings.json", "/p/.mcp.json", "/p/.vscode/tasks.json", "/p/sub/.envrc"]) {
      expect(ruleChoices("Write", { file_path: path, content: "x" }), path).toEqual([]);
      expect(ruleChoices("Edit", { file_path: path, old_string: "a", new_string: "b" }), path).toEqual([]);
    }
    expect(ruleChoices("Write", { file_path: "/p/src/a.ts", content: "x" })).toHaveLength(2);
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

describe("handRule", () => {
  const form = (patch: Partial<HandForm>): HandForm => ({ tool: "Bash", otherName: "", match: "prefix", pattern: "", scope: "folder", ...patch });
  const ok = (patch: Partial<HandForm>) => {
    const made = handRule(form(patch));
    if ("error" in made) throw new Error(made.error);
    return made;
  };

  it("makes the same rules the card offers for the same call", () => {
    expect(ruleChoices("Bash", { command: "npm test src" })).toContainEqual(ok({ pattern: "npm test" }).rule);
    expect(ruleChoices("Bash", { command: "ls -la" })).toContainEqual(ok({ pattern: "ls" }).rule);
    expect(ruleChoices("Bash", { command: "npm run build" })).toContainEqual(ok({ match: "exact", pattern: "npm run build" }).rule);
    expect(ruleChoices("Edit", { file_path: "/Users/me/my project/src/a.ts" })).toContainEqual(ok({ tool: "Edit", match: "dir", pattern: "/Users/me/my project/src" }).rule);
    expect(ruleChoices("Read", { file_path: "/a/b" })).toContainEqual(ok({ tool: "Read", match: "any" }).rule);
    expect(ruleChoices("WebFetch", { url: "https://x.dev" })).toEqual([ok({ tool: "WebFetch", match: "any" }).rule]);
    expect(ruleChoices("mcp__linear__save_issue", { title: "x" })).toEqual([ok({ tool: "other", otherName: " mcp__linear__save_issue ", match: "any" }).rule]);
  });

  it("describes the rule in words", () => {
    expect(ok({ pattern: "npm  test" }).meaning).toBe("Always allow Bash commands starting with npm test");
    expect(ok({ match: "exact", pattern: "npm run build" }).meaning).toBe("Always allow the Bash command npm run build");
    expect(ok({ tool: "Edit", match: "dir", pattern: "/p/src/" }).meaning).toBe("Always allow Edit for files in /p/src");
  });

  it("refuses an empty pattern, a start the backend wouldn't make, and a pattern that covers everything", () => {
    for (const pattern of ["", "  ", "*", "Bash", "rm", "sh", "npm", "npm install", "git push", "npm test; rm x", "-x"]) {
      expect("error" in handRule(form({ pattern })), pattern).toBe(true);
    }
    for (const pattern of ["", "x", "npm test; rm x", "a\nb"]) {
      expect("error" in handRule(form({ match: "exact", pattern })), pattern).toBe(true);
    }
    for (const pattern of ["", "src", "/", "/a/../b", "/p/.git", "/p/.git/hooks", "/p/package.json"]) {
      expect("error" in handRule(form({ tool: "Write", match: "dir", pattern })), pattern).toBe(true);
    }
    for (const otherName of ["", "a b", "ExitPlanMode", "AskUserQuestion", "mcp__lantern__approve", "Bash", "Edit"]) {
      expect("error" in handRule(form({ tool: "other", otherName, match: "any" })), otherName).toBe(true);
    }
  });

  it("marks the very broad rules and not the narrow ones", () => {
    expect(ok({ tool: "Write", match: "any" }).broad).toMatch(/any file it writes without asking/);
    expect(ok({ tool: "WebSearch", match: "any" }).broad).toMatch(/every WebSearch call/);
    expect(ok({ tool: "other", otherName: "mcp__a__b", match: "any" }).broad).toMatch(/every mcp__a__b call/);
    expect(ok({ match: "exact", pattern: "rm -rf build" }).broad).toMatch(/delete files/);
    expect(ok({ match: "exact", pattern: "sudo ls" }).broad).toMatch(/run other programs/);
    expect(ok({ tool: "Edit", match: "dir", pattern: "/Users/me" }).broad).toMatch(/very large folder/);
    expect(ok({ pattern: "npm test" }).broad).toBeNull();
    expect(ok({ match: "exact", pattern: "npm run build" }).broad).toBeNull();
    expect(ok({ tool: "Edit", match: "dir", pattern: "/Users/me/proj/src" }).broad).toBeNull();
  });

  it("falls back to a way the tool has when the form holds another one's", () => {
    expect(ok({ tool: "WebFetch", match: "prefix", pattern: "x" }).rule).toEqual({ tool: "WebFetch", kind: "any" });
  });
});
