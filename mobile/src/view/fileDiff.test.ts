import { isMarkdown, languageOf, markdownOf, parseUnifiedDiff, tokensOf } from "./fileDiff";

const shape = (text: string) => parseUnifiedDiff(text).map((r) => `${r.kind} ${r.oldNo ?? "-"}/${r.newNo ?? "-"} ${r.text}`);

describe("parseUnifiedDiff", () => {
  it("numbers each line in the old and the new file, and drops the signs and the file headers", () => {
    const diff = "--- a.ts\n+++ a.ts\n@@ -3,4 +3,4 @@\n one\n-two\n+TWO\n+more\n three\n";
    expect(shape(diff)).toEqual(["gap -/- 3", "ctx 3/3 one", "del 4/- two", "add -/4 TWO", "add -/5 more", "ctx 5/6 three"]);
  });

  it("reads a hunk header with no counts (one line) and no gap above a change at the top", () => {
    expect(shape("--- a\n+++ a\n@@ -1 +1 @@\n-old\n+new\n")).toEqual(["del 1/- old", "add -/1 new"]);
  });

  it("marks where lines are skipped between hunks", () => {
    const diff = "--- a\n+++ a\n@@ -1,2 +1,2 @@\n-a\n+b\n same\n@@ -40,2 +40,2 @@\n x\n-y\n+z\n";
    expect(shape(diff).filter((r) => r.startsWith("gap"))).toEqual(["gap -/- 40"]);
  });

  it("reads a new file as all added lines, numbered from 1", () => {
    expect(shape("--- n.md\n+++ n.md\n@@ -0,0 +1,2 @@\n+# Hi\n+there\n")).toEqual(["add -/1 # Hi", "add -/2 there"]);
  });

  it("keeps a removed line that begins with dashes, and an added one that begins with pluses", () => {
    expect(shape("--- a\n+++ a\n@@ -1,2 +1,2 @@\n--- not a header\n+++ nor this\n")).toEqual(["del 1/- -- not a header", "add -/1 ++ nor this"]);
  });

  it("keeps blank lines and leaves out the 'no newline' marker", () => {
    expect(shape("--- a\n+++ a\n@@ -1,2 +1,2 @@\n \n-x\n\\ No newline at end of file\n+y\n")).toEqual(["ctx 1/1 ", "del 2/- x", "add -/2 y"]);
  });

  it("ends in a note when the Mac cut the diff short", () => {
    const rows = parseUnifiedDiff("--- a\n+++ a\n@@ -1 +1 @@\n+x\n… (cut short: the rest is on your Mac)");
    expect(rows.at(-1)).toEqual({ kind: "note", oldNo: null, newNo: null, text: "… (cut short: the rest is on your Mac)" });
  });

  it("reads a text with no hunks by its first characters, without numbers", () => {
    expect(shape("--- a\n+++ b\n-old\n+new\n same")).toEqual(["del -/- old", "add -/- new", "ctx -/- same"]);
  });

  it("is empty for no text", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("keeps words that are not a diff whole, as notes: never cut, never hidden", () => {
    // A message in place of a diff.
    expect(shape("Nothing changed in this file.")).toEqual(["note -/- Nothing changed in this file."]);
    // Words before the first hunk, and a line in a hunk that is neither added, removed nor context.
    expect(shape("Heads up\n--- a\n+++ a\n@@ -1 +1 @@\n+x\nStray words\n+y")).toEqual(["note -/- Heads up", "add -/1 x", "note -/- Stray words", "add -/2 y"]);
  });
});

describe("languageOf", () => {
  it("names a file's language by its extension, as the colouring knows it", () => {
    expect(languageOf("/p/src/a.TSX")).toBe("tsx");
    expect(languageOf("/p/a.mjs")).toBe("js");
    expect(languageOf("/p/README.markdown")).toBe("md");
    expect(languageOf("/p/Makefile")).toBe("");
    expect(languageOf("/p/.gitignore")).toBe("");
    expect(isMarkdown("/p/notes.md")).toBe(true);
    expect(isMarkdown("/p/notes.ts")).toBe(false);
  });
});

describe("tokensOf", () => {
  it("colours each row as its language and joins back to its text", () => {
    const rows = parseUnifiedDiff("--- a\n+++ a\n@@ -1,2 +1,2 @@\n-let a = 1;\n+let a = \"x\"; // hi\n same\n");
    const tokens = tokensOf(rows, "ts");
    expect(tokens.map((t, i) => t.map((x) => x.text).join("") === rows[i].text || rows[i].kind === "gap")).toEqual(rows.map(() => true));
    // The removed line first, then the added one.
    expect(tokens[0].map((t) => t.kind)).toEqual(["keyword", "plain", "number", "plain"]);
    expect(tokens[1].map((t) => t.kind)).toEqual(["keyword", "plain", "string", "plain", "comment"]);
  });

  it("follows a block comment down the new side without the removed lines breaking it", () => {
    const rows = parseUnifiedDiff("--- a\n+++ a\n@@ -1,3 +1,3 @@\n /* start\n-old\n+new\n end */\n");
    const tokens = tokensOf(rows, "js");
    // The removed line is in the comment on the old side, the added one on the new side; both are comment, and "end */" is closed.
    expect(tokens.slice(0, 4).map((t) => t[0].kind)).toEqual(["comment", "comment", "comment", "comment"]);
  });

  it("leaves a gap with no tokens and an unknown language plain", () => {
    const rows = parseUnifiedDiff("--- a\n+++ a\n@@ -9 +9 @@\n+const a = 1\n");
    expect(tokensOf(rows, "")[0]).toEqual([]);
    expect(tokensOf(rows, "")[1]).toEqual([{ kind: "plain", text: "const a = 1" }]);
  });
});

describe("markdownOf", () => {
  it("tells headings, lists, quotes and rules, with their marks taken off", () => {
    const rows = parseUnifiedDiff("--- a.md\n+++ a.md\n@@ -0,0 +1,8 @@\n+## Title ##\n+- item\n+  * nested\n+3. third\n+- [x] done\n+> quoted\n+---\n+plain **words**\n");
    expect(markdownOf(rows).map((m) => m && JSON.stringify(m))).toEqual([
      JSON.stringify({ kind: "heading", level: 2, text: "Title" }),
      JSON.stringify({ kind: "list", depth: 0, marker: "•", text: "item" }),
      JSON.stringify({ kind: "list", depth: 1, marker: "•", text: "nested" }),
      JSON.stringify({ kind: "list", depth: 0, marker: "3.", text: "third" }),
      JSON.stringify({ kind: "list", depth: 0, marker: "☑", text: "done" }),
      JSON.stringify({ kind: "quote", text: "quoted" }),
      JSON.stringify({ kind: "rule", text: "---" }),
      JSON.stringify({ kind: "text", text: "plain **words**" }),
    ]);
  });

  it("keeps what is inside a code fence as code, not as headings", () => {
    const rows = parseUnifiedDiff("--- a.md\n+++ a.md\n@@ -0,0 +1,4 @@\n+```sh\n+# not a heading\n+```\n+# a heading\n");
    expect(markdownOf(rows).map((m) => m?.kind)).toEqual(["fence", "code", "fence", "heading"]);
  });

  it("reads a huge line as plain words, without running its patterns over it", () => {
    const long = `# ${" ".repeat(200_000)}x`;
    const rows = parseUnifiedDiff(`--- a.md\n+++ a.md\n@@ -0,0 +1 @@\n+${long}\n`);
    const started = Date.now();
    expect(markdownOf(rows)[0]).toEqual({ kind: "text", text: long });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("is null for a gap", () => {
    expect(markdownOf(parseUnifiedDiff("--- a\n+++ a\n@@ -9 +9 @@\n+x\n"))[0]).toBeNull();
  });
});
