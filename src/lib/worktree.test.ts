import { describe, expect, it } from "vitest";
import type { ChatItem, ToolItem } from "../store";
import { worktreeCalls } from "./worktree";

const tool = (name: string, status: ToolItem["status"]): ChatItem => ({ type: "tool", id: `${name}-${status}`, name, summary: "", status, output: null, edit: null, children: [] });

describe("worktreeCalls", () => {
  it("counts the enter_worktree calls Lantern has answered, and no others", () => {
    const items = [tool("mcp__lantern__enter_worktree", "done"), tool("mcp__lantern__enter_worktree", "error"), tool("mcp__lantern__enter_worktree", "running"), tool("EnterWorktree", "done"), tool("mcp__lantern__review_target", "done")];
    expect(worktreeCalls(items)).toBe(2);
    expect(worktreeCalls([])).toBe(0);
  });
});
