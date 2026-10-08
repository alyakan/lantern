import { describe, expect, it } from "vitest";
import type { McpServer, SkillEntry } from "../types";
import { describeConfig, displayName, groupSkills, removable, sourceOf, toolsOf, withoutFrontmatter } from "./mcp";

const server = (over: Partial<McpServer>): McpServer => ({ name: "x", status: "connected", ...over });

describe("mcp helpers", () => {
  it("finds a server's tools by Claude Code's naming", () => {
    const tools = ["mcp__claude_ai_Linear__create_issue", "mcp__claude_ai_Linear__list_issues", "mcp__sentry__find", "Read"];
    expect(toolsOf("claude.ai Linear", tools)).toEqual(["create_issue", "list_issues"]);
    expect(toolsOf("sentry", tools)).toEqual(["find"]);
  });

  it("names servers and where they come from", () => {
    expect(displayName(server({ name: "claude.ai Linear" }))).toBe("Linear");
    expect(displayName(server({ name: "plugin:figma:figma" }))).toBe("figma");
    expect(displayName(server({ name: "x", serverInfo: { title: "Sentry" } }))).toBe("Sentry");
    expect(sourceOf(server({ scope: "claudeai" }))).toBe("claude.ai connector");
    expect(sourceOf(server({ scope: "dynamic", source: "plugin" }))).toBe("Plugin");
    expect(sourceOf(server({ scope: "local" }))).toBe("Yours, this project");
    expect(removable(server({ scope: "project" }))).toBe(true);
    expect(removable(server({ scope: "claudeai" }))).toBe(false);
  });

  it("never shows header or environment values", () => {
    const rows = describeConfig(server({ config: { type: "stdio", command: "npx", args: ["-y", "pg"], env: { PGPASSWORD: "hunter2" } } }));
    expect(rows).toEqual([
      { label: "Command", value: "npx -y pg" },
      { label: "Environment", value: "PGPASSWORD=•••" },
    ]);
    const http = describeConfig(server({ config: { type: "http", url: "https://x.dev/mcp", headers: { Authorization: "Bearer abc" } } }));
    expect(JSON.stringify(http)).not.toContain("Bearer");
  });

  it("groups skills: yours, the project's, then each plugin, skills before commands", () => {
    const e = (name: string, source: SkillEntry["source"], kind: SkillEntry["kind"] = "skill", plugin: string | null = null): SkillEntry => ({ name, source, kind, plugin, path: "", description: "" });
    const groups = groupSkills([e("z:b", "plugin", "skill", "z"), e("deploy", "project", "command"), e("b", "user", "command"), e("a", "user"), e("a:c", "plugin", "skill", "a")]);
    expect(groups.map((g) => [g.title, g.entries.map((x) => x.name)])).toEqual([
      ["Yours", ["a", "b"]],
      ["This project", ["deploy"]],
      ["Plugin · a", ["a:c"]],
      ["Plugin · z", ["z:b"]],
    ]);
  });

  it("drops a skill file's frontmatter", () => {
    expect(withoutFrontmatter("---\nname: a\n---\n# A")).toBe("# A");
    expect(withoutFrontmatter("# B")).toBe("# B");
  });
});
