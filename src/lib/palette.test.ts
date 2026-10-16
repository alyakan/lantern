import { describe, expect, it } from "vitest";
import { filterEntries, fuzzyScore, sentenceCase, type PaletteEntry } from "./palette";

const entry = (title: string): PaletteEntry => ({ id: title, title, group: "View", shortcut: null, run: () => {} });

describe("sentenceCase", () => {
  it("lowercases every word after the first, keeping names", () => {
    expect(sentenceCase("Switch Canvas and Chat View")).toBe("Switch canvas and chat view");
    expect(sentenceCase("Review a PR…")).toBe("Review a PR…");
    expect(sentenceCase("Stop Claude")).toBe("Stop Claude");
    expect(sentenceCase("Show/Hide Side Panel")).toBe("Show/Hide side panel");
    expect(sentenceCase("Open Folder…")).toBe("Open folder…");
  });
});

describe("fuzzyScore", () => {
  it("matches the letters of the query in order, with or without case", () => {
    expect(fuzzyScore("stg", "Settings…")).not.toBeNull();
    expect(fuzzyScore("SET", "settings")).not.toBeNull();
    expect(fuzzyScore("gts", "Settings")).toBeNull();
    expect(fuzzyScore("zz", "Settings")).toBeNull();
  });

  it("scores a match at a word start above one buried in a word", () => {
    expect(fuzzyScore("c", "Command Palette")).toBeGreaterThan(fuzzyScore("c", "Macro") ?? -Infinity);
    expect(fuzzyScore("p", "Command Palette")).toBeGreaterThan(fuzzyScore("p", "Snapshot") ?? -Infinity);
  });

  it("scores consecutive letters above scattered ones", () => {
    expect(fuzzyScore("ses", "Session History")).toBeGreaterThan(fuzzyScore("ses", "Show the Settings Ending") ?? -Infinity);
  });

  it("an empty query matches everything, at no score", () => {
    expect(fuzzyScore("   ", "anything")).toBe(0);
  });
});

describe("filterEntries", () => {
  const entries = [entry("Settings…"), entry("Session History"), entry("Toggle Changes Pane"), entry("New Session")];

  it("returns every entry, in order, for an empty search", () => {
    expect(filterEntries(entries, "")).toEqual(entries);
  });

  it("keeps only the matches, best first", () => {
    // "Settings…" also has the letters, spread out, so it comes last.
    expect(filterEntries(entries, "ses").map((e) => e.title)).toEqual(["Session History", "New Session", "Settings…"]);
    expect(filterEntries(entries, "tcp").map((e) => e.title)).toEqual(["Toggle Changes Pane"]);
    expect(filterEntries(entries, "nothing like this")).toEqual([]);
  });

  it("keeps the order entries came in when they score the same", () => {
    const same = [entry("Files"), entry("Files")];
    same[1] = { ...same[1], id: "second" };
    expect(filterEntries(same, "f").map((e) => e.id)).toEqual(["Files", "second"]);
  });
});
