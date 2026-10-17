import { describe, expect, it } from "vitest";
import type { ChatItem } from "../store";
import { pagesOf } from "./steps";
import { gistOf, summarize } from "./stepsSummary";

const u = (id: string, text: string, turn: number): ChatItem => ({ type: "user", id, text, turn });
const a = (id: string, text: string): ChatItem => ({ type: "assistant", id, text });

/** A conversation as pages: each reply is [heading and text], the prompts are numbered turns. */
function chat(...replies: string[]): ChatItem[] {
  return replies.flatMap((text, i) => [u(`u${i}`, i === 0 ? "Do the thing" : "Next", i), a(`a${i}`, text)]);
}
const summaryOf = (...replies: string[]) => summarize(pagesOf(chat(...replies)));

const PLAN = (n: number, title: string, change: string) => `# Plan step ${n} — ${title}\n\n\`\`\`\nFile:   src/x.ts\nChange: ${change}\nVerify: a test.\n\`\`\``;

describe("gistOf", () => {
  it("takes the first line of prose, without its markup but keeping its code marked", () => {
    expect(gistOf("- `src/client/retry.ts:1`: added **RETRYABLE**.\n\nMore.")).toBe("`src/client/retry.ts:1`: added RETRYABLE.");
    expect(gistOf("1. Do [the thing](http://x) first")).toBe("Do the thing first");
  });

  it("skips code, quotes, tables and rules", () => {
    expect(gistOf("```ts\nconst a = 1;\n```\n\n> [!NOTE]\n> aside\n\n| a | b |\n---\nThe real line.")).toBe("The real line.");
    expect(gistOf("```\n\n```")).toBeNull();
    expect(gistOf("   \n")).toBeNull();
  });

  it("cuts a long line at a readable length", () => {
    const gist = gistOf("word ".repeat(80))!;
    expect(gist.length).toBeLessThanOrEqual(140);
    expect(gist.endsWith("…")).toBe(true);
  });
});

describe("summarize a Build chat", () => {
  const frame = "# Frame — Retry fetchJson\n\n**Task:** retry transient errors.";

  it("shows each planned step once, with what was done for it, and the plan's progress", () => {
    const s = summaryOf(frame, PLAN(1, "Name the statuses", "Add RETRYABLE."), PLAN(2, "Retry with backoff", "Loop up to attempts."), "# Plan complete — 2 steps", "# Step 1 of 2 — Name the statuses\n\n- `retry.ts:1`: added RETRYABLE.\n\nMore text.");
    expect(s.rows.map((r) => [r.kind, r.label, r.title, r.built, r.current])).toEqual([
      ["frame", "Frame", "Retry fetchJson", true, false],
      ["step", "Step 1", "Name the statuses", true, true],
      ["step", "Step 2", "Retry with backoff", false, false],
    ]);
    expect(s.headline).toBe("Plan: 2 steps · locked · 1 built");
    // Built: what the step page says, and both pages to open. Planned: what the plan says it will change.
    const [, one, two] = s.rows;
    expect(one.gist).toBe("`retry.ts:1`: added RETRYABLE.");
    expect([one.page, one.planPage]).toEqual(["u4", "u1"]);
    expect(one.range).toEqual({ from: 4, to: 4 });
    expect(one.changes).toBe(true);
    expect(two.gist).toBe("Loop up to attempts.");
    expect([two.page, two.planPage, two.range, two.changes]).toEqual(["u2", null, null, false]);
  });

  it("marks the plan's last step current while its plan page is the newest, and every built step done after", () => {
    const planned = summaryOf(frame, PLAN(1, "A", "a"), PLAN(2, "B", "b"));
    expect(planned.rows.map((r) => r.current)).toEqual([false, false, true]);
    const built = summaryOf(frame, PLAN(1, "A", "a"), "# Plan complete — 1 step", "# Step 1 of 1 — A\n\nDone it.", "# Done — all of it\n\nShipped.");
    expect(built.rows.map((r) => [r.kind, r.built, r.current])).toEqual([
      ["frame", true, false],
      ["step", true, false],
      ["done", true, true],
    ]);
    expect(built.headline).toBe("Plan: 1 step · locked · all built");
  });

  it("counts the steps from the plan-complete page, then from the step pages, then from what it has", () => {
    expect(summaryOf(frame, PLAN(1, "A", "a"), "# Plan complete — 4 steps").headline).toBe("Plan: 4 steps · 0 built");
    expect(summaryOf(PLAN(1, "A", "a"), "# Step 1 of 3 — A\n\nok").headline).toBe("Plan: 3 steps · 1 built");
    expect(summaryOf(PLAN(1, "A", "a"), PLAN(2, "B", "b")).headline).toBe("Plan: 2 steps · 0 built");
  });

  it("keeps the latest plan for a step planned again, and shows a step that was never planned", () => {
    const s = summaryOf(PLAN(1, "First try", "old"), PLAN(2, "B", "b"), PLAN(1, "Second try", "new"));
    expect(s.rows.map((r) => [r.label, r.title, r.gist])).toEqual([
      ["Step 1", "Second try", "new"],
      ["Step 2", "B", "b"],
    ]);
    const unplanned = summaryOf("# Step 1 of 1 — Straight in\n\nDid it.");
    expect(unplanned.rows.map((r) => [r.label, r.built, r.planPage])).toEqual([["Step 1", true, null]]);
  });

  it("lists the steps in step order, however they were written: a step revised after the ones that follow it still comes first", () => {
    // As a real chat went: pages from step 5, step 1 posted again after step 8, and step 6 posted again much later.
    const s = summaryOf(PLAN(5, "E", "e"), PLAN(6, "F", "f"), PLAN(7, "G", "g"), PLAN(8, "H", "h"), PLAN(1, "A revised", "a2"), PLAN(9, "I", "i"), PLAN(6, "F revised", "f2"));
    expect(s.rows.map((r) => [r.label, r.title])).toEqual([
      ["Step 1", "A revised"],
      ["Steps 2–4", "No pages for these steps"],
      ["Step 5", "E"],
      ["Step 6", "F revised"],
      ["Step 7", "G"],
      ["Step 8", "H"],
      ["Step 9", "I"],
    ]);
    // The newest page is the revised step 6, so that's the current row.
    expect(s.rows.map((r) => r.current)).toEqual([false, false, false, true, false, false, false]);
  });

  it("marks steps that were never written as pages, so the numbers add up and nothing is left to open", () => {
    const s = summaryOf(PLAN(3, "C", "c"), PLAN(5, "E", "e"), PLAN(6, "F", "f"));
    expect(s.rows.map((r) => [r.kind, r.label])).toEqual([["gap", "Steps 1–2"], ["step", "Step 3"], ["gap", "Step 4"], ["step", "Step 5"], ["step", "Step 6"]]);
    const gap = s.rows[0];
    expect([gap.page, gap.planPage, gap.range, gap.built, gap.current, gap.changes]).toEqual(["", null, null, false, false, false]);
    expect(gap.gist).toMatch(/nothing to open/);
    // They aren't counted as planned steps: the plan is as long as its highest number, built is the pages with a step.
    expect(s.headline).toBe("Plan: 6 steps · 0 built");
  });

  it("has no gaps in a plan that starts at one and has every number", () => {
    const s = summaryOf(PLAN(2, "B", "b"), PLAN(1, "A", "a"), PLAN(3, "C", "c"));
    expect(s.rows.map((r) => [r.kind, r.label])).toEqual([["step", "Step 1"], ["step", "Step 2"], ["step", "Step 3"]]);
  });

  it("orders each run of steps by itself, so what comes between plans keeps them apart", () => {
    const s = summaryOf("# Frame — one", PLAN(2, "B", "b"), PLAN(1, "A", "a"), "# Done — one built", "# Frame — two", PLAN(2, "B2", "b"), PLAN(1, "A2", "a"));
    expect(s.rows.map((r) => `${r.kind}:${r.label}:${r.title}`)).toEqual(["frame:Frame:one", "step:Step 1:A", "step:Step 2:B", "done:Done:one built", "frame:Frame:two", "step:Step 1:A2", "step:Step 2:B2"]);
  });

  it("doesn't mark steps already shown earlier as missing when a later run of the same plan starts higher", () => {
    const s = summaryOf(PLAN(1, "A", "a"), PLAN(2, "B", "b"), PLAN(3, "C", "c"), PLAN(4, "D", "d"), "# Evidence 1 — a snag\n\nLogged.", PLAN(5, "E", "e"), PLAN(6, "F", "f"));
    expect(s.rows.map((r) => r.label)).toEqual(["Step 1", "Step 2", "Step 3", "Step 4", "Evidence 1", "Step 5", "Step 6"]);
    // Numbers that were never written still get their marker, once.
    const t = summaryOf(PLAN(1, "A", "a"), "# Evidence 1 — a snag\n\nLogged.", PLAN(5, "E", "e"), "# Evidence 2 — again\n\nLogged.", PLAN(8, "H", "h"));
    expect(t.rows.map((r) => r.label)).toEqual(["Step 1", "Evidence 1", "Steps 2–4", "Step 5", "Evidence 2", "Steps 6–7", "Step 8"]);
  });

  it("puts the first Frame at the top even when it was written after other pages", () => {
    const s = summaryOf(PLAN(5, "E", "e"), PLAN(6, "F", "f"), PLAN(1, "A", "a"), frame, PLAN(2, "B", "b"));
    expect(s.rows.map((r) => r.label)).toEqual(["Frame", "Step 1", "Step 2", "Steps 3–4", "Step 5", "Step 6"]);
    expect(s.rows.find((r) => r.current)?.label).toBe("Step 2");
  });

  it("leaves out suggestions, the plan-complete pause and replies with no heading", () => {
    const s = summaryOf("# Switch to Build — a feature\n\nShall I?", frame, "no heading here, just chat", "# Plan complete — 1 step");
    expect(s.rows.map((r) => r.kind)).toEqual(["frame"]);
    // The frame is still the page the chat is on: the pause after the plan isn't a row to be on.
    expect(s.rows[0].current).toBe(true);
    expect(summarize([])).toEqual({ headline: null, rows: [] });
  });
});

describe("summarize Review and Debug chats", () => {
  const file = (n: number, total: number, path: string, body: string) => `# File ${n} of ${total} — ${path} (+4 −1)\n\n${body}`;

  it("gives a row per reviewed file, with its findings and size", () => {
    const s = summaryOf(
      "# Frame — PR #12\n\nTwo files.",
      file(1, 3, "src/a.ts", "### What changed\nAdds a retry.\n\n### Findings\n⚠ line 4 (blocker): loops forever.\n⚠ line 9 (nit): name.\n\n### Notes\nok"),
      file(2, 3, "src/b.ts", "### What changed\nRenames b.\n\n### Findings\nNone."),
    );
    expect(s.headline).toBe("2 of 3 files reviewed");
    const [, one, two] = s.rows;
    expect(one).toMatchObject({ kind: "file", label: "File 1 of 3", title: "src/a.ts", gist: "Adds a retry.", findings: { count: 2, clean: false }, stats: { added: 4, removed: 1 }, changes: false, range: null });
    expect(two).toMatchObject({ title: "src/b.ts", findings: { count: 0, clean: true }, current: true });
  });

  it("names the review's own summary page so it isn't mistaken for the tab", () => {
    const s = summaryOf(file(1, 1, "src/a.ts", "### What changed\nx\n\n### Findings\nNone."), "# Summary — 1 file reviewed, no findings");
    expect(s.rows.map((r) => [r.kind, r.label])).toEqual([["file", "File 1 of 1"], ["review-summary", "Review summary"]]);
  });

  it("gives Debug a row per evidence round and the fix, with their changes", () => {
    const s = summaryOf("# Frame — it crashes\n\nH1, H2.", "# Evidence 1 — H1 vs H2\n\nAdded logging.", "# Evidence 2 — narrowing\n\nIt's H2.", "# Fix — guard the null\n\nOne line.", "# Done — null guard\n\nRemoved logging.");
    expect(s.rows.map((r) => [r.kind, r.label, r.changes])).toEqual([
      ["frame", "Frame", false],
      ["evidence", "Evidence 1", true],
      ["evidence", "Evidence 2", true],
      ["fix", "Fix", true],
      ["done", "Done", false],
    ]);
    expect(s.headline).toBe("2 evidence rounds");
    expect(s.rows[3].range).toEqual({ from: 3, to: 3 });
  });

  it("keeps both halves of a chat that went from Build to Debug", () => {
    const s = summaryOf("# Frame — feature\n\nx", PLAN(1, "A", "a"), "# Step 1 of 1 — A\n\nbuilt", "# Frame — the crash\n\nhypotheses", "# Evidence 1 — logs\n\nadded");
    expect(s.rows.map((r) => r.kind)).toEqual(["frame", "step", "frame", "evidence"]);
    expect(s.headline).toBe("Plan: 1 step · all built · 1 evidence round");
  });

  it("has no changes to show for a page whose turns aren't known (an earlier turn of a reopened chat)", () => {
    const items: ChatItem[] = [{ type: "user", id: "u0", text: "Next" }, a("a0", "# Step 1 of 1 — A\n\nbuilt")];
    const [row] = summarize(pagesOf(items)).rows;
    expect([row.changes, row.range]).toEqual([true, null]);
  });

  describe("the plan's lock", () => {
    const frame = "# Frame — feature\n\nx";

    it("says locked once the Plan complete page was approved, and not before", () => {
      expect(summaryOf(frame, PLAN(1, "A", "a"), "# Plan complete — 1 step").headline).toBe("Plan: 1 step · 0 built");
      expect(summaryOf(frame, PLAN(1, "A", "a"), "# Plan complete — 1 step", "# Step 1 of 1 — A\n\nbuilt").headline).toBe("Plan: 1 step · locked · all built");
    });

    it("isn't locked by a question about the page, or a change to a plan step, which don't approve it", () => {
      const base: ChatItem[] = [u("u0", "Do the thing", 0), a("a0", frame), u("u1", "Next", 1), a("a1", PLAN(1, "A", "a")), u("u2", "Next", 2), a("a2", "# Plan complete — 1 step")];
      const asked = summarize(pagesOf([...base, u("u3", "Why one step?", 3), a("a3", "Because it's small.")]));
      expect(asked.headline).toBe("Plan: 1 step · 0 built");
      const changed = summarize(pagesOf([...base, u("u3", "Make step 1 smaller", 3), a("a3", PLAN(1, "A smaller", "a"))]));
      expect(changed.headline).toBe("Plan: 1 step · 0 built");
    });

    it("has nothing to lock when the chat built without a plan", () => {
      expect(summaryOf("# Step 1 of 2 — A\n\nbuilt", "# Step 2 of 2 — B\n\nbuilt").headline).toBe("Plan: 2 steps · all built");
    });

    it("unlocks while a plan update waits for you, shows it as a row, and locks again when the revised plan is approved", () => {
      const locked = [frame, PLAN(1, "A", "a"), "# Plan complete — 1 step", "# Step 1 of 1 — A\n\nbuilt"];
      const update = "# Plan update — the 404 case needs its own step\n\nAdd a step for 404s.";
      const pending = summaryOf(...locked, update);
      expect(pending.headline).toBe("Plan: 1 step · all built");
      const row = pending.rows.find((r) => r.kind === "plan-update")!;
      expect([row.label, row.title, row.gist, row.built, row.current, row.changes]).toEqual(["Plan update", "the 404 case needs its own step", "Add a step for 404s.", true, true, false]);
      // Posted again but not yet approved: still not locked. Approved by going on: locked, with the new step counted.
      const revised = [...locked, update, PLAN(2, "404s", "b"), "# Plan complete — 2 steps"];
      expect(summaryOf(...revised).headline).toBe("Plan: 2 steps · 1 built");
      expect(summaryOf(...revised, "# Step 2 of 2 — 404s\n\nbuilt").headline).toBe("Plan: 2 steps · locked · all built");
    });

    it("lists a plan update right after the step that was built before it, in the order they were written", () => {
      const head = [frame, PLAN(1, "A", "a"), PLAN(2, "B", "b"), "# Plan complete — 2 steps", "# Step 1 of 2 — A\n\nbuilt"];
      const s = summaryOf(...head, "# Plan update — first\n\nx", "# Plan update — second\n\ny", "# Step 2 of 2 — B\n\nbuilt", "# Done — all\n\nz");
      expect(s.rows.map((r) => r.label)).toEqual(["Frame", "Step 1", "Plan update", "Plan update", "Step 2", "Done"]);
      expect(s.rows.filter((r) => r.kind === "plan-update").map((r) => r.title)).toEqual(["first", "second"]);
    });

    it("leaves a plan update that came before any step was built where it is", () => {
      const s = summaryOf(frame, PLAN(1, "A", "a"), "# Plan complete — 1 step", "# Plan update — early\n\nx");
      expect(s.rows.map((r) => r.label)).toEqual(["Frame", "Step 1", "Plan update"]);
    });

    it("stays locked when work went on after an update (it was declined)", () => {
      const s = summaryOf(frame, PLAN(1, "A", "a"), PLAN(2, "B", "b"), "# Plan complete — 2 steps", "# Step 1 of 2 — A\n\nbuilt", "# Plan update — maybe split\n\nSplit step 2?", "# Step 2 of 2 — B\n\nbuilt");
      expect(s.headline).toBe("Plan: 2 steps · locked · all built");
    });
  });
});
