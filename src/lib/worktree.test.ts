import { describe, expect, it } from "vitest";
import type { ChatItem, ToolItem } from "../store";
import { forgetWorktree, worktreeCalls, worktreeOf, worktreeToRestore } from "./worktree";

const tool = (name: string, status: ToolItem["status"], summary = ""): ChatItem => ({ type: "tool", id: `${name}-${status}-${summary}`, name, summary, status, output: null, edit: null, children: [] });

describe("worktreeCalls", () => {
  it("counts the enter_worktree calls Lantern has answered, and no others", () => {
    const items = [tool("mcp__lantern__enter_worktree", "done"), tool("mcp__lantern__enter_worktree", "error"), tool("mcp__lantern__enter_worktree", "running"), tool("EnterWorktree", "done"), tool("mcp__lantern__review_target", "done")];
    expect(worktreeCalls(items)).toBe(2);
    expect(worktreeCalls([])).toBe(0);
  });
});

describe("worktreeOf", () => {
  const enter = (path: string, status: ToolItem["status"] = "done") => tool("mcp__lantern__enter_worktree", status, path);
  it("is the path of the last enter_worktree call that worked, and null once one left the worktree", () => {
    expect(worktreeOf([])).toBeUndefined();
    expect(worktreeOf([enter("/wt/a"), tool("Bash", "done", "/wt/b"), enter("/wt/c")])).toBe("/wt/c");
    expect(worktreeOf([enter("/wt/a"), enter("")])).toBeNull();
    // A refused or unfinished call changed nothing.
    expect(worktreeOf([enter("/wt/a"), enter("/gone", "error"), enter("/wt/b", "running")])).toBe("/wt/a");
  });
});

describe("worktreeToRestore", () => {
  it("prefers what was saved for the session, then the transcript", () => {
    const items = [tool("mcp__lantern__enter_worktree", "done", "/wt/from-transcript")];
    expect(worktreeToRestore("/wt/saved", items)).toBe("/wt/saved");
    expect(worktreeToRestore(undefined, items)).toBe("/wt/from-transcript");
    // The user picked none: the transcript's call doesn't bring it back.
    expect(worktreeToRestore("", items)).toBeNull();
    expect(worktreeToRestore(undefined, [tool("mcp__lantern__enter_worktree", "done", "")])).toBeNull();
    expect(worktreeToRestore(undefined, [])).toBeNull();
  });
});

describe("forgetWorktree", () => {
  it("drops one session's worktree and keeps the others", () => {
    expect(forgetWorktree({ a: "/wt/a", b: "/wt/b" }, "a")).toEqual({ b: "/wt/b" });
    expect(forgetWorktree({ b: "/wt/b" }, "a")).toEqual({ b: "/wt/b" });
  });
});
