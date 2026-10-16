import { describe, expect, it } from "vitest";
import { commentsMessage, findLine, kindOf, newLineOf, ordered, quoteLine, reconcile, removedBlockAfter, type DiffComment, type LineChange } from "./diffComments";

const comment = (over: Partial<DiffComment> = {}): DiffComment => ({ id: "c1", path: "/p/src/a.ts", side: "new", line: 2, lineText: "const a = 1;", kind: "added", text: "Why 1?", ...over });

// Two lines changed at 3-4 (two became three), one line removed after line 9 of the new file (a removal names the line before it).
const changes: LineChange[] = [
  { originalStartLineNumber: 3, originalEndLineNumber: 4, modifiedStartLineNumber: 3, modifiedEndLineNumber: 5 },
  { originalStartLineNumber: 8, originalEndLineNumber: 8, modifiedStartLineNumber: 9, modifiedEndLineNumber: 0 },
  { originalStartLineNumber: 12, originalEndLineNumber: 0, modifiedStartLineNumber: 12, modifiedEndLineNumber: 12 },
];

describe("kindOf", () => {
  it("is removed on the old side, added inside a change on the new side, and unchanged elsewhere", () => {
    expect(kindOf("old", 3, changes)).toBe("removed");
    expect(kindOf("new", 4, changes)).toBe("added");
    expect(kindOf("new", 12, changes)).toBe("added");
    expect(kindOf("new", 2, changes)).toBe("context");
    // A pure removal has no lines on the new side.
    expect(kindOf("new", 9, changes)).toBe("context");
  });
});

describe("removedBlockAfter", () => {
  it("names the new-file line a removed block is drawn after", () => {
    expect(removedBlockAfter(4, changes)).toBe(2);
    expect(removedBlockAfter(8, changes)).toBe(9);
  });
  it("is null for a line no change removes", () => {
    expect(removedBlockAfter(5, changes)).toBeNull();
    expect(removedBlockAfter(12, changes)).toBeNull();
  });
});

describe("newLineOf", () => {
  it("moves an unchanged old line by what the changes above it added or removed", () => {
    expect(newLineOf(2, changes)).toBe(2);
    // Lines 3-4 became 3-5 (one more), so old 6 is new 7; old 8 was removed (one fewer), so old 10 is new 10; the insertion after 12 adds one.
    expect(newLineOf(6, changes)).toBe(7);
    expect(newLineOf(10, changes)).toBe(10);
    expect(newLineOf(13, changes)).toBe(14);
  });
});

describe("findLine", () => {
  const lines = ["a", "b", "c", "b", "d"];
  it("keeps the line when it still has the text", () => {
    expect(findLine(lines, 2, "b")).toBe(2);
  });
  it("follows the text to the nearest line that has it", () => {
    expect(findLine(lines, 3, "d")).toBe(5);
    expect(findLine(lines, 5, "b")).toBe(4);
    expect(findLine(lines, 1, "b")).toBe(2);
  });
  it("is null when no line has the text, and for a blank line that moved", () => {
    expect(findLine(lines, 2, "gone")).toBeNull();
    expect(findLine(["a", "", "b"], 1, "")).toBeNull();
    expect(findLine(["a", "", "b"], 2, "")).toBe(2);
  });
});

describe("reconcile", () => {
  const original = "one\ntwo\nthree\n";
  it("returns the same list when every comment's line is where it was", () => {
    const all = [comment({ lineText: "b", line: 2 })];
    expect(reconcile(all, "/p/src/a.ts", original, "a\nb\nc\n")).toBe(all);
  });
  it("moves a comment with its line when lines were added above it", () => {
    const [moved] = reconcile([comment({ lineText: "b", line: 2 })], "/p/src/a.ts", original, "x\ny\na\nb\nc\n");
    expect(moved).toMatchObject({ line: 4, outdated: false });
  });
  it("marks a comment outdated when its line is gone, and keeps it", () => {
    const [gone] = reconcile([comment({ lineText: "b", line: 2 })], "/p/src/a.ts", original, "a\nc\n");
    expect(gone).toMatchObject({ line: 2, outdated: true, text: "Why 1?" });
  });
  it("brings an outdated comment back when its line returns", () => {
    const [back] = reconcile([comment({ lineText: "b", line: 2, outdated: true })], "/p/src/a.ts", original, "a\nb\n");
    expect(back.outdated).toBe(false);
  });
  it("looks removed lines up in the old text, and leaves other files' comments alone", () => {
    const other = comment({ id: "c2", path: "/p/src/b.ts", lineText: "zzz" });
    const removed = comment({ side: "old", line: 2, lineText: "two", kind: "removed" });
    const next = reconcile([removed, other], "/p/src/a.ts", original, "nothing like it");
    expect(next[0]).toBe(removed);
    expect(next[1]).toBe(other);
    expect(reconcile([removed], "/p/src/a.ts", "one\ntwo\n", "x")[0].outdated).toBeUndefined();
  });
});

describe("quoteLine", () => {
  it("trims the line and quotes it as code", () => {
    expect(quoteLine("   const a = 1;  ")).toBe("`const a = 1;`");
  });
  it("cuts a long line to 120 characters", () => {
    const quoted = quoteLine("x".repeat(300));
    expect(quoted).toBe(`\`${"x".repeat(120)}…\``);
  });
  it("fences a line that has backticks, so it can't end the quote", () => {
    expect(quoteLine("say(`hi`)")).toBe("`` say(`hi`) ``");
    expect(quoteLine("a ``b`` c")).toBe("``` a ``b`` c ```");
  });
});

describe("commentsMessage", () => {
  it("lists each comment with its file, line, kind of line and the line's text", () => {
    const text = commentsMessage(
      [
        comment({ text: "Why 1?" }),
        comment({ id: "c2", side: "old", line: 40, lineText: "const b = 2;", kind: "removed", text: "Was this used?" }),
        comment({ id: "c3", path: "/p/src/lib/y.ts", line: 7, lineText: "return x;", kind: "context", text: "Fine, but add a test." }),
      ],
      "/p",
    );
    expect(text).toBe(
      [
        "Please address these review comments:",
        "",
        "1. src/a.ts line 2 (added line: `const a = 1;`): Why 1?",
        "2. src/a.ts line 40 (before) (removed line: `const b = 2;`): Was this used?",
        "3. src/lib/y.ts line 7 (unchanged line: `return x;`): Fine, but add a test.",
      ].join("\n"),
    );
  });
  it("keeps a comment's own line breaks lined up, and says when the line has since changed or is blank", () => {
    const text = commentsMessage([comment({ text: "First.\nSecond.", outdated: true }), comment({ id: "c2", line: 5, lineText: "  ", text: "Why blank?" })], "/p");
    expect(text).toContain("1. src/a.ts line 2 (added line, since changed: `const a = 1;`): First.\n   Second.");
    expect(text).toContain("2. src/a.ts line 5 (blank added line): Why blank?");
  });
  it("goes file by file, top to bottom, in the order files were first commented on", () => {
    const list = ordered([comment({ id: "1", path: "/p/b.ts", line: 9 }), comment({ id: "2", path: "/p/a.ts", line: 3 }), comment({ id: "3", path: "/p/b.ts", line: 2 })]);
    expect(list.map((c) => c.id)).toEqual(["3", "1", "2"]);
  });
});
