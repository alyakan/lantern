import { FOLD_ABOVE, foldOf, HIGHLIGHT_MAX_CHARS, highlight, langOf } from "./highlight";

const kinds = (line: ReturnType<typeof highlight>[number]) => line.map((t) => `${t.kind}:${t.text}`);
const joined = (lines: ReturnType<typeof highlight>) => lines.map((l) => l.map((t) => t.text).join("")).join("\n");

describe("highlight", () => {
  it("colours keywords, strings, numbers and comments, and keeps every character", () => {
    const code = 'const a = "hi"; // greet\nlet n = 42;';
    const lines = highlight(code, "ts");
    expect(kinds(lines[0])).toEqual(["keyword:const", "plain: a = ", 'string:"hi"', "plain:; ", "comment:// greet"]);
    expect(kinds(lines[1])).toEqual(["keyword:let", "plain: n = ", "number:42", "plain:;"]);
    expect(joined(lines)).toBe(code);
  });

  it("follows a block comment over several lines", () => {
    const lines = highlight("a /* one\ntwo\nthree */ b", "js");
    expect(lines[1]).toEqual([{ kind: "comment", text: "two" }]);
    expect(kinds(lines[2])).toEqual(["comment:three */", "plain: b"]);
  });

  it("treats # as a comment in a hash language but only after a space or at the start", () => {
    expect(kinds(highlight("x = 1  # one", "python")[0])).toEqual(["plain:x = ", "number:1", "plain:  ", "comment:# one"]);
    expect(kinds(highlight("echo a#b", "bash")[0])).toEqual(["keyword:echo", "plain: a#b"]);
  });

  it("handles an escaped quote and a string that never closes", () => {
    expect(kinds(highlight('x = "a\\"b" + 1', "py")[0])[1]).toBe('string:"a\\"b"');
    expect(highlight('print("open', "py")[0].at(-1)).toEqual({ kind: "string", text: '"open' });
  });

  it("does not colour a number inside a word", () => {
    expect(kinds(highlight("let abc123 = 7", "ts")[0])).toEqual(["keyword:let", "plain: abc123 = ", "number:7"]);
  });

  it("matches sql keywords in any case", () => {
    expect(highlight("SELECT 1 FROM t", "sql")[0][0]).toEqual({ kind: "keyword", text: "SELECT" });
  });

  it("colours a diff's added and removed lines and its headers", () => {
    const lines = highlight("@@ -1 +1 @@\n-old\n+new\n same", "diff");
    expect(lines.map((l) => l[0].kind)).toEqual(["meta", "del", "add", "plain"]);
  });

  it("leaves an unknown language and a huge block plain", () => {
    expect(highlight("const a = 1", "brainfuck")[0]).toEqual([{ kind: "plain", text: "const a = 1" }]);
    expect(highlight("", "")[0]).toEqual([{ kind: "plain", text: "" }]);
    const big = "x".repeat(HIGHLIGHT_MAX_CHARS + 1);
    expect(highlight(big, "ts")[0]).toEqual([{ kind: "plain", text: big }]);
  });

  it("reads a fence's name loosely", () => {
    expect(langOf("TypeScript")).not.toBeNull();
    expect(langOf("tsx title=x")).not.toBeNull();
    expect(langOf("language-rust")).not.toBeNull();
    expect(langOf("")).toBeNull();
  });

  it("keeps whatever it is given, whole", () => {
    const odd = "fn main() {\n  let s = 'a\n  /* x\n}\né中 \"\\";
    for (const lang of ["rust", "ts", "py", "sql", "html", "json", "diff", "css"]) expect(joined(highlight(odd, lang))).toBe(odd);
  });
});

describe("foldOf", () => {
  it("folds only a long block", () => {
    expect(foldOf("a\nb").folds).toBe(false);
    expect(foldOf(Array.from({ length: FOLD_ABOVE }, () => "x").join("\n")).folds).toBe(false);
    expect(foldOf(Array.from({ length: FOLD_ABOVE + 1 }, () => "x").join("\n"))).toEqual({ lines: FOLD_ABOVE + 1, folds: true });
  });
});
