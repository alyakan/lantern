import { describe, expect, it } from "vitest";
import { diffRows, excerpt, type DiffRow } from "./lineDiff";

const show = (rows: DiffRow[] | null) => rows?.map((r) => (r.kind === "ctx" ? ` ${r.newNo} ${r.text}` : r.kind === "add" ? `+${r.newNo} ${r.text}` : `-${r.oldNo} ${r.text}`));

describe("diffRows", () => {
  it("keeps every line of two equal versions", () => {
    expect(show(diffRows("a\nb\n", "a\nb\n"))).toEqual([" 1 a", " 2 b", " 3 "]);
  });

  it("puts removed lines before the lines added in their place", () => {
    expect(show(diffRows("a\nold\nc", "a\nnew\nc"))).toEqual([" 1 a", "-2 old", "+2 new", " 3 c"]);
  });

  it("numbers added lines in the new file and removed ones in the old", () => {
    expect(show(diffRows("a\nb\nc\nd", "a\nx\ny\nc\nd\ne"))).toEqual([" 1 a", "-2 b", "+2 x", "+3 y", " 4 c", " 5 d", "+6 e"]);
  });

  it("reads a created file as all added and a deleted one as all removed", () => {
    expect(show(diffRows("", "one\ntwo"))).toEqual(["+1 one", "+2 two"]);
    expect(show(diffRows("one\ntwo", ""))).toEqual(["-1 one", "-2 two"]);
  });

  it("finds the shortest change between lines that move around", () => {
    const rows = diffRows("a\nb\nc\na\nb\nb\na", "c\nb\na\nb\na\nc")!;
    // Myers' example: 5 edits, and every kept line is the same in both.
    expect(rows.filter((r) => r.kind !== "ctx")).toHaveLength(5);
    for (const r of rows) if (r.kind === "ctx") expect("abc".includes(r.text)).toBe(true);
    expect(rows.filter((r) => r.kind !== "del").map((r) => r.text)).toEqual(["c", "b", "a", "b", "a", "c"]);
    expect(rows.filter((r) => r.kind !== "add").map((r) => r.text)).toEqual(["a", "b", "c", "a", "b", "b", "a"]);
  });

  it("gives up on versions too far apart rather than taking long", () => {
    const a = Array.from({ length: 1500 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 1500 }, (_, i) => `b${i}`).join("\n");
    expect(diffRows(a, b)).toBeNull();
  });
});

describe("excerpt", () => {
  const rows = diffRows(["1", "2", "3", "4", "old5", "6", "7", "8", "9", "10"].join("\n"), ["1", "2", "3", "4", "new5", "6", "7", "8", "9", "10"].join("\n"))!;

  it("shows the lines around a finding, with what was removed there", () => {
    expect(show(excerpt(rows, 5, 5, 2))).toEqual([" 3 3", " 4 4", "-5 old5", "+5 new5", " 6 6", " 7 7"]);
  });

  it("keeps the removed lines a finding's first line replaced", () => {
    expect(show(excerpt(rows, 5, 5, 0))).toEqual(["-5 old5", "+5 new5"]);
  });

  it("is empty for lines the file doesn't have", () => {
    expect(excerpt(rows, 40, 41)).toEqual([]);
  });

  it("stops at its most rows", () => {
    expect(excerpt(rows, 1, 10, 0, 4)).toHaveLength(4);
  });
});
