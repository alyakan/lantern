import { excerptOf } from "./reviewCode";

// What `review_diff` sends: git's unified diff, three lines of context around each change.
const diff = `--- a.ts
+++ a.ts
@@ -10,7 +10,7 @@
 ten
 eleven
 twelve
-old thirteen
+new thirteen
 fourteen
 fifteen
 sixteen
@@ -40,3 +40,4 @@
 forty
 forty-one
+forty-two added
 forty-three
`;

const text = (rows: ReturnType<typeof excerptOf>) => rows.map((r) => `${r.kind}:${r.text}`);

describe("a finding's code, from the diff", () => {
  it("is the lines it names with a few around them, and what was removed in their place", () => {
    expect(text(excerptOf(diff, 13, 13))).toEqual(["ctx:ten", "ctx:eleven", "ctx:twelve", "del:old thirteen", "add:new thirteen", "ctx:fourteen", "ctx:fifteen", "ctx:sixteen"]);
  });

  it("keeps the removed line that belongs to the first added one shown", () => {
    expect(text(excerptOf(diff, 14, 14))[0]).toBe("ctx:eleven");
    expect(text(excerptOf(diff, 14, 14))).toContain("del:old thirteen");
  });

  it("covers a range of lines", () => {
    const rows = excerptOf(diff, 41, 42);
    expect(rows.map((r) => r.text)).toEqual(["forty", "forty-one", "forty-two added", "forty-three"]);
  });

  it("is empty for a line the diff doesn't have: further from a change than its context", () => {
    expect(excerptOf(diff, 25, 25)).toEqual([]);
    expect(excerptOf(diff, 999, 999)).toEqual([]);
  });

  it("never reaches across the skipped lines between two changes", () => {
    const rows = excerptOf(diff, 16, 16);
    expect(rows.every((r) => r.kind !== "gap")).toBe(true);
    expect(rows.map((r) => r.text)).not.toContain("forty");
  });

  it("is cut at the far end past the limit", () => {
    const long = ["@@ -1,60 +1,60 @@", ...Array.from({ length: 60 }, (_, i) => ` line ${i + 1}`)].join("\n");
    expect(excerptOf(long, 1, 55)).toHaveLength(40);
  });
});
