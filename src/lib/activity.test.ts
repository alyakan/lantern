import { describe, expect, it } from "vitest";
import type { ChatItem, ToolItem } from "../store";
import { describeStep, editsIn, failedCount, groupItems, runningStep, sameRow, stepLabel, summarize, type Row } from "./activity";

const tool = (id: string, name: string, extra: Partial<ToolItem> = {}): ToolItem => ({
  type: "tool", id, name, summary: "/p/src/a.ts", status: "done", output: null, edit: null, children: [], ...extra,
});
const edit = { path: "/p/src/a.ts", created: false, hunks: [] };

const say = (id: string, text: string): ChatItem => ({ type: "assistant", id, text });
const done = { type: "turn", id: "end", isError: false, stopped: false, result: null, durationMs: 1, denied: 0 } as const;

describe("groupItems", () => {
  it("folds a turn's tools and narration into one block, keeping what came before the work and the reply after it", () => {
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
    expect(rows.map((r) => r.type)).toEqual(["user", "assistant", "activity", "assistant", "turn"]);
    expect(rows[1]).toMatchObject({ id: "m0" });
    expect(rows[2]).toMatchObject({ id: "a:t1", live: false, steps: [{ id: "t1" }, { id: "t2" }] });
    expect((rows[2] as { entries: ChatItem[] }).entries.map((e) => e.id)).toEqual(["t1", "m1", "t2"]);
    expect(rows[3]).toMatchObject({ id: "m2" });
  });

  it("keeps an answer Claude gives before it goes on to work, even when the turn ends on a summary of that work", () => {
    const items: ChatItem[] = [
      { type: "user", id: "u1", text: "Can the AI also manage todos?" },
      say("m0", "Yes. The plan will gain to-do changes alongside its block changes."),
      tool("t1", "Read"),
      say("m1", "Now tests."),
      tool("t2", "Bash"),
      say("m2", "Done: to-dos can be created, completed and deleted."),
      done,
    ];
    const rows = groupItems(items);
    expect(rows.map((r) => r.type)).toEqual(["user", "assistant", "activity", "assistant", "turn"]);
    expect(rows[1]).toMatchObject({ id: "m0" });
    expect((rows[2] as { entries: ChatItem[] }).entries.map((e) => e.id)).toEqual(["t1", "m1", "t2"]);
  });

  it("folds a post-hook and what Claude did for it into one row, and leaves the turn's closing note after it", () => {
    const items: ChatItem[] = [
      { type: "user", id: "u1", text: "fix it" },
      tool("t1", "Edit", { edit }),
      say("m1", "Fixed."),
      { type: "hook", id: "h1", text: "Update the brain if needed" },
      tool("t2", "Bash"),
      say("m2", "Nothing to save."),
      done,
    ];
    const rows = groupItems(items);
    expect(rows.map((r) => r.type)).toEqual(["user", "activity", "assistant", "hook", "turn"]);
    const hook = rows[3] as Extract<Row, { type: "hook" }>;
    expect(hook).toMatchObject({ id: "h1", text: "Update the brain if needed", waiting: false });
    expect(hook.rows.map((r) => r.type)).toEqual(["activity", "assistant"]);
    // The user's own answer is still a row of its own, outside the hook.
    expect(rows[2]).toMatchObject({ id: "m1" });
  });

  it("keeps each of two hooks in one turn as its own row, and the answer before them as the reply", () => {
    const items: ChatItem[] = [
      { type: "user", id: "u1", text: "any more reports?" },
      tool("t1", "Bash"),
      say("m1", "Yes, 44 users."),
      { type: "hook", id: "h1", text: "Before you finish: save it." },
      tool("t2", "Bash"),
      say("m2", "I saved one note."),
      { type: "hook", id: "h2", text: "Update the brain if needed" },
      tool("t3", "Bash"),
      say("m3", "Nothing more to save."),
      done,
    ];
    const rows = groupItems(items);
    expect(rows.map((r) => r.type)).toEqual(["user", "activity", "assistant", "hook", "hook", "turn"]);
    expect(rows[2]).toMatchObject({ id: "m1" });
    expect((rows[3] as Extract<Row, { type: "hook" }>).rows.map((r) => r.id)).toEqual(["a:t2", "m2"]);
    expect((rows[4] as Extract<Row, { type: "hook" }>).rows.map((r) => r.id)).toEqual(["a:t3", "m3"]);
  });

  it("says a post-hook is waiting when a prompt in it has no answer, and is live while its turn runs", () => {
    const ask: ChatItem = { type: "permission", id: "p1", toolName: "Bash", input: { command: "brain add" }, decision: null };
    const items: ChatItem[] = [{ type: "user", id: "u1", text: "go" }, say("m1", "Done."), { type: "hook", id: "h1", text: "save" }, tool("t2", "Bash", { status: "running" }), ask];
    const [, , hook] = groupItems(items, true) as [Row, Row, Extract<Row, { type: "hook" }>];
    expect(hook.waiting).toBe(true);
    expect(hook.rows.find((r) => r.type === "activity")).toMatchObject({ live: true });
    // Not live once the stream isn't.
    const [, , still] = groupItems(items, false) as [Row, Row, Extract<Row, { type: "hook" }>];
    expect(still.rows.find((r) => r.type === "activity")).toMatchObject({ live: false });
  });

  it("a hook row is the same row when what it holds is the same, and not when it holds something more", () => {
    const base: ChatItem[] = [{ type: "user", id: "u1", text: "go" }, say("m1", "Done."), { type: "hook", id: "h1", text: "save" }, tool("t2", "Bash")];
    const a = groupItems(base, true)[2];
    expect(a).toMatchObject({ type: "hook" });
    expect(sameRow(a, groupItems(base, true)[2])).toBe(true);
    expect(sameRow(a, groupItems([...base, tool("t3", "Read")], true)[2])).toBe(false);
  });

  it("a hook that arrives while the turn is still at work is a note, and the turn's work and answer stay out in the open", () => {
    // A message typed while a compaction ended: the hook for the compaction's turn is sent into it, before any reply.
    const items: ChatItem[] = [
      { type: "user", id: "u1", text: "why are the links broken?" },
      tool("t1", "Read"),
      { type: "hook", id: "h1", text: "Update the brain if needed" },
      tool("t2", "Bash"),
      tool("t3", "Edit", { edit }),
      say("m1", "The renderer only read http links."),
      done,
    ];
    const rows = groupItems(items);
    expect(rows.map((r) => r.type)).toEqual(["user", "activity", "hook", "activity", "assistant", "turn"]);
    expect(rows[2]).toMatchObject({ id: "h1", rows: [], waiting: false });
    expect(rows[4]).toMatchObject({ id: "m1" });
    // Even right after the message, before any work.
    expect(groupItems([{ type: "user", id: "u1", text: "go" }, { type: "hook", id: "h1", text: "save" }, tool("t2", "Bash")], true).map((r) => r.type)).toEqual(["user", "hook", "activity"]);
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

  it("keeps an answered approval in the conversation, and names the tool for what it did", () => {
    const approval: ChatItem = { type: "permission", id: "ap-1", toolName: "Approval", input: { action: "Merge PR #144" }, decision: "allowed" };
    const rows = groupItems([{ type: "user", id: "u1", text: "a" }, tool("t1", "Read"), approval, tool("t2", "mcp__lantern__request_approval", { summary: "Merge PR #144" }), tool("t3", "Edit"), done]);
    expect(rows.map((r) => r.id)).toEqual(["u1", "a:t1", "ap-1", "end"]);
    expect(summarize((rows[1] as { steps: ToolItem[] }).steps)).toBe("Read 1 file, made 1 edit, asked for your approval");
    expect(describeStep(tool("t2", "mcp__lantern__request_approval", { summary: "Merge PR #144" }), "/p")).toBe("Waiting for your approval Merge PR #144");
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

describe("sameRow", () => {
  const turn: ChatItem[] = [{ type: "user", id: "u1", text: "a" }, tool("t1", "Read"), say("m1", "ok"), tool("t2", "Bash", { status: "running" })];

  it("is the same for an activity row made again from the same items", () => {
    const [, before] = groupItems(turn, true);
    const [, after] = groupItems([...turn], true);
    expect(before).not.toBe(after);
    expect(sameRow(before, after)).toBe(true);
  });

  it("changes when a step changes, a step is added, or the turn stops being live", () => {
    const [, before] = groupItems(turn, true);
    const finished = [...turn.slice(0, -1), tool("t2", "Bash", { status: "done" })];
    expect(sameRow(before, groupItems(finished, true)[1])).toBe(false);
    expect(sameRow(before, groupItems([...turn, tool("t3", "Read")], true)[1])).toBe(false);
    expect(sameRow(before, groupItems(turn, false)[1])).toBe(false);
  });

  it("compares any other row by identity: a message whose text grew is a new object", () => {
    const m: Row = { type: "assistant", id: "m9", text: "Hel" };
    expect(sameRow(m, m)).toBe(true);
    expect(sameRow(m, { ...m })).toBe(false);
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

  it("Lantern's network tools read as Network Monitor", () => {
    const steps = [tool("1", "mcp__lantern__network_requests"), tool("2", "mcp__lantern__network_summarize")];
    expect(summarize(steps)).toBe("Used Network Monitor 2 times");
    expect(stepLabel(steps[1])).toBe("Network Monitor · summarize");
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
