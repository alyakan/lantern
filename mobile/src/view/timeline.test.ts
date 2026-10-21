import type { Item } from "../sync/reducer";
import { stepChips, timeline, turnLine } from "./timeline";

type Step = Extract<Item, { kind: "step" }>;
const step = (id: string, name: string, over: Partial<Step> = {}): Step => ({ kind: "step", id, name, summary: "", done: true, isError: false, edits: [], tests: null, ...over });
const said = (id: string, text: string, streaming = false): Item => ({ kind: "assistant", id, text, streaming });
const you = (id: string, text: string): Item => ({ kind: "user", id, text, at: 1, sentBy: null });

describe("a run of steps as chips", () => {
  it("counts reads, searches and edits (files once, lines summed)", () => {
    const chips = stepChips([
      step("1", "Read"),
      step("2", "Read"),
      step("3", "Grep"),
      step("4", "Edit", { edits: [{ path: "/a.ts", created: false, added: 2, removed: 1 }] }),
      step("5", "Edit", { edits: [{ path: "/a.ts", created: false, added: 1, removed: 0 }, { path: "/b.ts", created: true, added: 5, removed: 0 }] }),
    ]);
    expect(chips.map((c) => c.label)).toEqual(["Read 2 files", "Searched 1 time", "Edited 2 files +8 −1"]);
    expect(chips[2].files).toEqual(["/a.ts", "/b.ts"]);
  });

  it("says tests as passed in green, or the failures in red", () => {
    expect(stepChips([step("1", "Bash", { tests: { passed: 412, failed: 0, skipped: 2 } })])).toEqual([{ key: "tests", label: "412 tests passed", tone: "ok" }]);
    expect(stepChips([step("1", "Bash", { tests: { passed: 10, failed: 3, skipped: 0 } })])).toEqual([{ key: "tests", label: "3 failed, 10 passed", tone: "bad" }]);
    expect(stepChips([step("1", "Bash", { tests: { passed: 1, failed: 0, skipped: 0 } })])[0].label).toBe("1 test passed");
  });

  it("says other commands and tools in a few words, and failed steps in red", () => {
    const chips = stepChips([step("1", "Bash", { summary: "git push origin release/0.1.53 --force-with-lease" }), step("2", "Agent"), step("3", "mcp__x__y", { summary: "go" }), step("4", "Bash", { summary: "ls", isError: true })]);
    expect(chips.map((c) => c.label)).toEqual(["Ran git push origin release/0…", "Ran a helper", "mcp__x__y go", "Ran ls", "1 step failed"]);
    expect(chips.at(-1)?.tone).toBe("bad");
  });

  it("looks up web pages apart from searching files", () => {
    expect(stepChips([step("1", "WebFetch"), step("2", "WebSearch")])[0].label).toBe("Looked up 2 pages");
  });
});

describe("the timeline", () => {
  it("folds each run of steps into one row, between the messages around it", () => {
    const rows = timeline([you("u1", "go"), step("1", "Read"), step("2", "Edit"), said("a1", "Done."), step("3", "Bash")]);
    expect(rows.map((r) => r.kind)).toEqual(["user", "steps", "assistant", "steps"]);
  });

  it("shows a finished page as a page, and only the last one is live", () => {
    const rows = timeline([said("a1", "# Step 1 of 2 — one"), you("u1", "Next"), said("a2", "# Step 2 of 2 — two")]);
    expect(rows.map((r) => (r.kind === "page" ? r.live : null))).toEqual([false, null, true]);
  });

  it("keeps a page that is still streaming as text until it is whole", () => {
    expect(timeline([said("a", "# Step 1 of 2 — on", true)])[0].kind).toBe("assistant");
  });

  it("carries prompts, what only the Mac can answer, and turns' ends through", () => {
    const rows = timeline([
      { kind: "prompt", id: "p", toolName: "Bash", input: {}, state: "open", by: null },
      { kind: "desktop", id: "d", what: "Builder wants to merge its branch." },
      { kind: "turn", id: "t", isError: false, result: null, durationMs: 3000 },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["prompt", "desktop", "turn"]);
  });

  it("gives every row a key of its own", () => {
    const rows = timeline([you("u1", "a"), you("u2", "b"), said("x", "c"), step("s1", "Read"), step("s2", "Read")]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});

describe("a turn's end", () => {
  it("says how long it took, or what went wrong", () => {
    expect(turnLine({ kind: "turn", id: "t", isError: false, result: null, durationMs: 3100 })).toEqual({ text: "Finished in 3 s", bad: false });
    expect(turnLine({ kind: "turn", id: "t", isError: false, result: null, durationMs: 72_000 }).text).toBe("Finished in 1 min 12 s");
    expect(turnLine({ kind: "turn", id: "t", isError: false, result: null, durationMs: null }).text).toBe("Finished");
    expect(turnLine({ kind: "turn", id: "t", isError: true, result: "rate limited", durationMs: 1 })).toEqual({ text: "Stopped with an error: rate limited", bad: true });
  });
});
