import { describe, expect, it } from "vitest";
import type { ChatItem, ToolItem } from "../store";
import { describeStep, editsIn, failedCount, groupItems, runningStep, stepLabel, summarize } from "./activity";

const tool = (id: string, name: string, extra: Partial<ToolItem> = {}): ToolItem => ({
  type: "tool", id, name, summary: "/p/src/a.ts", status: "done", output: null, edit: null, children: [], ...extra,
});
const edit = { path: "/p/src/a.ts", created: false, hunks: [] };

const say = (id: string, text: string): ChatItem => ({ type: "assistant", id, text });
const done = { type: "turn", id: "end", isError: false, stopped: false, result: null, durationMs: 1, denied: 0 } as const;

describe("groupItems", () => {
  it("folds a turn's tools and narration into one block, keeping the reply after it", () => {
    const items: ChatItem[] = [
      { type: "user", id: "u1", text: "hi" },
      say("m0", "Let me look."),
      tool("t1", "Read"),
      say("m1", "Found it, running tests."),
      tool("t2", "Bash"),
      say("m2", "All green."),
      done,
    ];
    const rows = groupItems(items);
    expect(rows.map((r) => r.type)).toEqual(["user", "activity", "assistant", "turn"]);
    expect(rows[1]).toMatchObject({ id: "a:t1", live: false, steps: [{ id: "t1" }, { id: "t2" }] });
    expect((rows[1] as { entries: ChatItem[] }).entries.map((e) => e.id)).toEqual(["m0", "t1", "m1", "t2"]);
    expect(rows[2]).toMatchObject({ id: "m2" });
  });

  it("keeps the last text visible, where it was said, when the turn ended on a tool", () => {
    const rows = groupItems([{ type: "user", id: "u1", text: "hi" }, say("m1", "Done: the fix is in."), tool("t1", "Bash"), done]);
    expect(rows.map((r) => r.id)).toEqual(["u1", "m1", "a:t1", "end"]);
  });

  it("makes one block per turn, and only the running turn's block is live", () => {
    const items: ChatItem[] = [
      { type: "user", id: "u1", text: "a" }, tool("t1", "Read"), say("m1", "ok"), done,
      { type: "user", id: "u2", text: "b" }, tool("t2", "Read"), say("m2", "checking"), tool("t3", "Bash", { status: "running" }),
    ];
    const rows = groupItems(items, true);
    const blocks = rows.filter((r) => r.type === "activity");
    expect(blocks.map((b) => [b.id, b.live])).toEqual([["a:t1", false], ["a:t2", true]]);
    expect(rows.map((r) => r.id).slice(-2)).toEqual(["a:t2", "m2"]);
    expect(groupItems(items, false).some((r) => r.type === "activity" && r.live)).toBe(false);
    // It stays live while the reply streams, until the turn is fully done.
    const replying = groupItems([...items.slice(0, -1), tool("t3", "Bash"), say("m3", "All green")], true);
    expect(replying.find((r) => r.id === "a:t2")).toMatchObject({ live: true });
  });

  it("leaves a pending permission prompt outside the block and folds answered ones in", () => {
    const ask = (decision: "allowed" | null): ChatItem => ({ type: "permission", id: `p-${decision}`, toolName: "Bash", input: {}, decision });
    const rows = groupItems([{ type: "user", id: "u1", text: "a" }, tool("t1", "Bash"), ask("allowed"), tool("t2", "Bash"), ask(null)], true);
    expect(rows.map((r) => r.id)).toEqual(["u1", "a:t1", "p-null"]);
    expect((rows[1] as { entries: ChatItem[] }).entries.map((e) => e.id)).toEqual(["t1", "p-allowed", "t2"]);
  });

  it("keeps an answered plan in the conversation rather than folding it into the turn's activity", () => {
    const plan: ChatItem = { type: "permission", id: "plan-1", toolName: "ExitPlanMode", input: { plan: "1. do it" }, decision: "allowed" };
    const rows = groupItems([{ type: "user", id: "u1", text: "a" }, tool("t1", "Read"), plan, tool("t2", "ExitPlanMode", { summary: "" }), tool("t3", "Edit"), done]);
    expect(rows.map((r) => r.id)).toEqual(["u1", "a:t1", "plan-1", "end"]);
    expect(summarize((rows[1] as { steps: ToolItem[] }).steps)).toBe("Read 1 file, made 1 edit, proposed a plan");
    expect(describeStep(tool("t2", "ExitPlanMode", { summary: "" }), "/p")).toBe("Proposing a plan");
  });

  it("leaves a turn without tools alone", () => {
    const items: ChatItem[] = [{ type: "user", id: "u1", text: "hi" }, say("m1", "hello"), done];
    expect(groupItems(items)).toEqual(items);
  });

  it("does not mutate the input", () => {
    const items: ChatItem[] = [tool("t1", "Read"), tool("t2", "Read")];
    groupItems(items);
    expect(items).toHaveLength(2);
  });
});

describe("MCP tools", () => {
  it("are named by their server and tool", () => {
    const steps = [tool("1", "mcp__claude_ai_Linear__create_issue"), tool("2", "mcp__claude_ai_Linear__list_issues"), tool("3", "mcp__sentry__find_errors"), tool("4", "Read")];
    expect(summarize(steps)).toBe("Read 1 file, used Linear 2 times, used sentry");
    expect(stepLabel(steps[0])).toBe("Linear · create issue");
    expect(describeStep(steps[2], "/p")).toBe("Using sentry: find errors");
    expect(stepLabel(tool("5", "mcp__lantern__reproduce"))).toBe("mcp__lantern__reproduce");
  });
});

describe("summarize", () => {
  it("counts by category in a fixed order", () => {
    const steps = [tool("1", "Bash"), tool("2", "Read"), tool("3", "Read"), tool("4", "Glob"), tool("5", "TodoWrite"), tool("6", "Skill"), tool("7", "Skill")];
    expect(summarize(steps)).toBe("Read 2 files, searched 1 time, ran 1 command, used 2 skills, used 1 other tool");
  });

  it("leaves out applied edits but counts unapplied ones", () => {
    expect(summarize([tool("1", "Edit", { edit })])).toBe("");
    expect(summarize([tool("1", "Edit", { status: "error" })])).toBe("Made 1 edit");
  });
});

describe("step helpers", () => {
  it("counts failures and finds the latest running step", () => {
    const steps = [tool("1", "Read", { status: "running" }), tool("2", "Bash", { status: "error" }), tool("3", "Grep", { status: "running" })];
    expect(failedCount(steps)).toBe(1);
    expect(runningStep(steps)?.id).toBe("3");
    expect(runningStep([tool("1", "Read")])).toBeNull();
  });

  it("describes a step relative to the folder", () => {
    expect(describeStep(tool("1", "Read"), "/p")).toBe("Reading src/a.ts");
    expect(describeStep(tool("1", "Mystery", { summary: "" }), "/p")).toBe("Mystery");
  });

  it("collects edits including subagent edits", () => {
    const sub = tool("s1", "Edit", { edit: { ...edit, path: "/p/b.ts" } });
    const steps = [tool("1", "Edit", { edit }), tool("2", "Task", { children: [sub] })];
    expect(editsIn(steps).map((e) => e.id)).toEqual(["1", "s1"]);
  });
});
