import { describe, expect, it } from "vitest";
import type { StorageItem } from "../types";
import { groupOf, idleText, isTicked, outcomeText, selection, sizeText } from "./storage";

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
