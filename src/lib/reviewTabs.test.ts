import { describe, expect, it } from "vitest";
import { DEFAULT_PINNED, migrateTab, validPinned } from "./reviewTabs";

describe("migrateTab", () => {
  it("sends Summary and Map to Plan, and the tabs that left the pane (and anything unknown) to Changes", () => {
    expect(["summary", "map"].map(migrateTab)).toEqual(["plan", "plan"]);
    expect(["activity", "agents", "storage", "x", ""].map(migrateTab)).toEqual(["changes", "changes", "changes", "changes", "changes"]);
    expect(["files", "tests", "checks", "network"].map(migrateTab)).toEqual(["files", "tests", "checks", "network"]);
  });
});

describe("validPinned", () => {
  it("keeps the saved order, dropping unknown names and repeats", () => {
    expect(validPinned(["network", "storage", "plan", "network", 4, null, "changes"])).toEqual(["network", "plan", "changes"]);
  });

  it("is the default when nothing usable was saved", () => {
    for (const bad of [undefined, null, "plan", 1, {}, [], ["activity"], [1, 2]]) expect(validPinned(bad)).toEqual(DEFAULT_PINNED);
    expect(DEFAULT_PINNED).toEqual(["changes", "files", "plan"]);
  });
});
