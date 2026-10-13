import { describe, expect, it } from "vitest";
import type { ChatItem, ToolItem } from "../store";
import type { SessionSummary } from "../types";
import { exportFileName, pinnedFirst, resumeCommand, sessionMarkdown, shellQuote } from "./sessionActions";

const tool = (id: string, name: string, extra: Partial<ToolItem> = {}): ToolItem => ({
  type: "tool", id, name, summary: "/p/src/a.ts", status: "done", output: null, edit: null, children: [], ...extra,
});

describe("resumeCommand", () => {
  it("names the folder and the session, quoted for a shell", () => {
    expect(resumeCommand("/Users/me/projects/web", "6a2d51bf")).toBe("cd '/Users/me/projects/web' && claude --resume '6a2d51bf'");
  });

  it("keeps a folder with a space and a quote in it as one word", () => {
    expect(shellQuote("/Users/me/My Projects/it's here")).toBe("'/Users/me/My Projects/it'\\''s here'");
    expect(resumeCommand("/Users/me/My Projects/it's here", "abc")).toBe("cd '/Users/me/My Projects/it'\\''s here' && claude --resume 'abc'");
  });
});

describe("pinnedFirst", () => {
  const s = (id: string): SessionSummary => ({ id, title: id, updated_ms: 0, prompts: 1 });

  it("puts the pinned sessions on top, each group in the order it was listed", () => {
    expect(pinnedFirst([s("a"), s("b"), s("c"), s("d")], ["c", "a"]).map((x) => x.id)).toEqual(["a", "c", "b", "d"]);
    expect(pinnedFirst([s("a"), s("b")], []).map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("exportFileName", () => {
  it("makes a readable file name from the title", () => {
    expect(exportFileName("Add retries to fetchJson!")).toBe("add-retries-to-fetchjson.md");
    expect(exportFileName("  Review: PR 128  ")).toBe("review-pr-128.md");
    expect(exportFileName("!!!")).toBe("session.md");
  });
});

describe("sessionMarkdown", () => {
  it("writes prompts and replies as they were, and each tool step on one line", () => {
    const items: ChatItem[] = [
      { type: "user", id: "u1", text: "Add retries" },
      { type: "tool", id: "t1", name: "Read", summary: "/p/src/a.ts", status: "done", output: "x", edit: null, children: [] } as ToolItem,
      tool("t2", "Edit", { summary: "/p/src/a.ts", edit: { path: "/p/src/a.ts", created: false, hunks: [{ old_start: 1, old_lines: 1, new_start: 1, new_lines: 2, lines: ["-a", "+b", "+c"] }] } }),
      tool("t3", "Bash", { summary: "npm test", status: "error" }),
      { type: "assistant", id: "a1", text: "Done, with **retries**." },
    ];
    expect(sessionMarkdown("Retries", items, "/p")).toBe(
      ["# Retries", "", "**You**", "", "Add retries", "", "- Read: src/a.ts", "- Edited src/a.ts (+2 −1)", "- Bash: npm test (failed)", "", "**Claude**", "", "Done, with **retries**.", ""].join("\n"),
    );
  });

  it("says a stopped or failed turn, with what it used when known", () => {
    const items: ChatItem[] = [
      { type: "user", id: "u1", text: "Hi" },
      { type: "turn", id: "t1", isError: false, stopped: true, result: null, durationMs: 1, denied: 0, cost: 0.04, tokens: 12_345 },
      { type: "user", id: "u2", text: "Again" },
      { type: "turn", id: "t2", isError: true, stopped: false, result: "Invalid API key", durationMs: 1, denied: 0 },
    ];
    const md = sessionMarkdown("Chat", items, "/p");
    expect(md).toContain("_Stopped. · $0.04 · 12k tokens_");
    expect(md).toContain("_The turn ended with an error: Invalid API key_");
  });

  it("marks a reply Claude started on its own, not as something the user typed", () => {
    const md = sessionMarkdown("Chat", [{ type: "user", id: "u1", text: "After the build ended", auto: true }, { type: "assistant", id: "a1", text: "Built." }], "/p");
    expect(md).toContain("_After the build ended_");
    expect(md).not.toContain("**You**");
  });

  it("writes a shell command the user ran, with how it ended", () => {
    const md = sessionMarkdown("Chat", [{ type: "shell", id: "s1", command: "git status", output: "", status: "done", code: 0, startedAt: 0, shared: true }], "/p");
    expect(md).toContain("- Ran `git status` (exit 0)");
  });
});
