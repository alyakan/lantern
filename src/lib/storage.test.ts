import { describe, expect, it } from "vitest";
import type { StorageItem } from "../types";
import { GROUPS, groupOf, idleText, isTicked, kindColour, layout, MIN_SEGMENT, outcomeText, rowWidth, segments, selection, shareText, sizeText, summaryText } from "./storage";

const item = (id: string, over: Partial<StorageItem> = {}): StorageItem => ({
  id,
  kind: "cache",
  name: id,
  path: `/p/${id}`,
  bytes: 1_000_000,
  risk: "safe",
  removal: "permanent",
  note: "",
  warning: null,
  ticked: false,
  idle_days: null,
  within: null,
  suggestion: null,
  ...over,
});

describe("storage", () => {
  it("writes sizes as the backend does", () => {
    expect([sizeText(999), sizeText(1_500_000), sizeText(12_345_678_901)]).toEqual(["999 B", "1.5 MB", "12.3 GB"]);
    // The unit rolls over when the rounded value would read 1000.
    expect([sizeText(999_950), sizeText(999.6), sizeText(999.4), sizeText(999_940)]).toEqual(["1.0 MB", "1.0 KB", "999 B", "999.9 KB"]);
  });

  it("ticks what the scan or Claude ticked until the user chooses, and never a blocked item", () => {
    const touched = new Map<string, boolean>();
    expect(isTicked(item("a", { ticked: true }), touched)).toBe(true);
    expect(isTicked(item("b", { suggestion: "merged" }), touched)).toBe(true);
    expect(isTicked(item("c"), touched)).toBe(false);
    touched.set("a", false);
    touched.set("c", true);
    expect(isTicked(item("a", { ticked: true }), touched)).toBe(false);
    expect(isTicked(item("c"), touched)).toBe(true);
    touched.set("d", true);
    expect(isTicked(item("d", { risk: "blocked", ticked: true }), touched)).toBe(false);
  });

  it("totals what is ticked, counting what sits inside a ticked worktree once, and splits out the Trash", () => {
    const items = [
      item("wt", { kind: "worktree", removal: "worktree", bytes: 5_000_000, ticked: true }),
      item("nm", { kind: "build_output", bytes: 3_000_000, ticked: true, within: "wt" }),
      item("other", { kind: "build_output", bytes: 2_000_000, ticked: true }),
      item("repo", { kind: "repo", removal: "trash", bytes: 4_000_000, ticked: true }),
      item("off", { bytes: 9_000_000 }),
    ];
    const sel = selection(items, new Map());
    expect(sel.ids).toEqual(["wt", "nm", "other", "repo"]);
    expect(sel.bytes).toBe(11_000_000);
    expect([sel.permanent, sel.toTrash, sel.toTrashBytes]).toEqual([3, 1, 4_000_000]);
    // Unticking the worktree makes what is inside it count again.
    expect(selection(items, new Map([["wt", false]])).bytes).toBe(9_000_000);
  });

  it("groups by kind and leaves nested items out of a group's total", () => {
    const g = groupOf([item("a", { bytes: 5 }), item("b", { bytes: 7, within: "x" }), item("c", { kind: "trash" })], "cache");
    expect([g.items.length, g.bytes]).toEqual([2, 5]);
  });

  it("says how long ago something changed", () => {
    expect([idleText(null), idleText(0), idleText(1), idleText(12), idleText(90), idleText(900)]).toEqual([null, "changed today", "idle 1 day", "idle 12 days", "idle 3 months", "idle 2 years"]);
  });

  it("says what a delete freed, what went to the Trash, and why anything was refused", () => {
    const items = [item("a", { bytes: 2_000_000_000 }), item("r", { kind: "repo", removal: "trash", bytes: 1_000_000_000 }), item("w", { kind: "worktree" })];
    const { text, failures } = outcomeText(
      [
        { id: "a", name: "a", ok: true, freed: 2_000_000_000, error: null },
        { id: "r", name: "r", ok: true, freed: 1_000_000_000, error: null },
        { id: "w", name: "w", ok: false, freed: 0, error: "1 uncommitted change that exist nowhere else." },
      ],
      items,
    );
    expect(text).toBe("Freed 2.0 GB. 1.0 GB went to the Trash: delete the Trash items below to get that space back.");
    expect(failures).toEqual([{ name: "w", error: "1 uncommitted change that exist nowhere else." }]);
    expect(outcomeText([], []).text).toBe("Nothing was deleted.");
  });
});

const GB = 1_000_000_000;
const KINDS = GROUPS.map((g) => g.kind);

describe("the stacked bar's segments", () => {
  it("has one segment per kind with something in it, in the list's order, and counts what is inside another item once", () => {
    const items = [
      item("c", { kind: "cache", bytes: 3 * GB }),
      item("w", { kind: "worktree", bytes: 5 * GB }),
      item("inner", { kind: "worktree", bytes: 4 * GB, within: "w" }),
      item("t", { kind: "trash", bytes: 2 * GB }),
    ];
    const parts = segments(items);
    expect(parts.map((p) => p.kind)).toEqual(["worktree", "cache", "trash"]);
    expect(parts.map((p) => p.bytes)).toEqual([5 * GB, 3 * GB, 2 * GB]);
    expect(parts.map((p) => p.share)).toEqual([50, 30, 20]);
    expect(parts.map((p) => p.title)).toEqual(["Git worktrees", "Caches and logs", "Trash"]);
  });

  it("is empty when nothing was found", () => {
    expect(segments([])).toEqual([]);
    expect(segments([item("z", { bytes: 0 })])).toEqual([]);
  });

  it("makes the shares whole percents that always add up to 100", () => {
    // Thirds don't divide: 33 + 33 + 33 leaves one to hand out.
    const thirds = segments(KINDS.slice(0, 3).map((kind, i) => item(`k${i}`, { kind, bytes: GB })));
    expect(thirds.map((p) => p.share).sort()).toEqual([33, 33, 34]);
    for (let n = 1; n <= KINDS.length; n++) {
      for (const sizes of [[7, 11, 13, 17, 19, 23, 29], [1, 1, 1, 1, 1, 1, 1], [900, 80, 5, 3, 1, 1, 1], [1_234_567, 7_654_321, 99, 1_000_000_000, 5, 42, 8_888_888]]) {
        const parts = segments(KINDS.slice(0, n).map((kind, i) => item(kind, { kind, bytes: sizes[i] * 1000 })));
        expect(parts.reduce((t, p) => t + p.share, 0)).toBe(100);
        expect(parts.reduce((t, p) => t + p.width, 0)).toBeCloseTo(100, 6);
      }
    }
  });

  it("gives a tiny kind a visible minimum width and takes the room from the big ones", () => {
    const parts = segments([item("big", { kind: "worktree", bytes: 400 * GB }), item("mid", { kind: "cache", bytes: 100 * GB }), item("tiny", { kind: "trash", bytes: 1_000_000 })]);
    const tiny = parts.find((p) => p.kind === "trash")!;
    expect(tiny.width).toBe(MIN_SEGMENT);
    expect(tiny.share).toBe(0);
    const [big, mid] = [parts[0], parts[1]];
    expect(big.width).toBeLessThan(80);
    expect(big.width / mid.width).toBeCloseTo(4, 5);
    expect(parts.reduce((t, p) => t + p.width, 0)).toBeCloseTo(100, 6);
  });

  it("keeps every width at the minimum or more even when raising the small ones squeezes another under it", () => {
    const parts = segments([item("a", { kind: "worktree", bytes: 1000 * GB }), item("b", { kind: "cache", bytes: 20.5 * GB }), item("c", { kind: "trash", bytes: 5 * GB }), item("d", { kind: "download", bytes: 1 * GB })]);
    for (const p of parts) expect(p.width).toBeGreaterThanOrEqual(MIN_SEGMENT - 1e-9);
    expect(parts.reduce((t, p) => t + p.width, 0)).toBeCloseTo(100, 6);
  });

  it("writes a share as a percent, and never calls something that is there 0%", () => {
    expect([shareText(41), shareText(100), shareText(0)]).toEqual(["41%", "100%", "<1%"]);
  });

  it("gives each kind its own colour token, --storage-1 to --storage-7 in the list's order", () => {
    expect(KINDS.map(kindColour)).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => `var(--storage-${n})`));
    expect(new Set(KINDS.map(kindColour)).size).toBe(7);
  });
});

describe("layout, the stacked bars' arithmetic", () => {
  it("gives whole percents that add up to 100 and widths that fill the bar, with a floor for a sliver", () => {
    const out = layout([1, 1, 1]);
    expect(out.map((o) => o.share)).toEqual([34, 33, 33]);
    expect(out.reduce((n, o) => n + o.width, 0)).toBeCloseTo(100, 5);
    const sliver = layout([10_000, 1]);
    expect(sliver[1].width).toBe(MIN_SEGMENT);
    expect(sliver[0].width).toBeCloseTo(100 - MIN_SEGMENT, 5);
    expect(sliver.reduce((n, o) => n + o.share, 0)).toBe(100);
  });

  it("is all zero for nothing", () => {
    expect(layout([0, 0])).toEqual([{ share: 0, width: 0 }, { share: 0, width: 0 }]);
    expect(layout([])).toEqual([]);
  });
});

describe("an item's own bar", () => {
  it("is its size against the biggest item of the scan, and never thinner than the minimum", () => {
    expect(rowWidth(10 * GB, 10 * GB)).toBe(100);
    expect(rowWidth(5 * GB, 10 * GB)).toBe(50);
    expect(rowWidth(1, 10 * GB)).toBe(MIN_SEGMENT);
    expect(rowWidth(0, 10 * GB)).toBe(MIN_SEGMENT);
    expect(rowWidth(5, 0)).toBe(0);
  });
});

describe("the summary line", () => {
  const sel = (over: Partial<ReturnType<typeof selection>>) => ({ ids: ["a"], bytes: 5 * GB, toTrashBytes: 0, permanent: 1, toTrash: 0, ...over });

  it("says what was scanned, what is selected, what that frees and what goes to the Trash first", () => {
    expect(summaryText(41.2 * GB, sel({}))).toBe("Total scanned 41.2 GB, selected to delete 5.0 GB (frees 5.0 GB)");
    expect(summaryText(41.2 * GB, sel({ toTrashBytes: 2 * GB, toTrash: 1 }))).toBe("Total scanned 41.2 GB, selected to delete 5.0 GB (frees 3.0 GB; 2.0 GB goes to Trash first)");
  });

  it("says nothing is selected when nothing is", () => {
    expect(summaryText(41.2 * GB, sel({ ids: [], bytes: 0 }))).toBe("Total scanned 41.2 GB, nothing selected to delete");
  });
});
