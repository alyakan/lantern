import { hasMark, markRanges, markTokens, splitMarked } from "./mark";

describe("marking what a search looks for", () => {
  it("finds each place, in any case, without overlapping", () => {
    expect(markRanges("Login, login, LOGIN", "login")).toEqual([[0, 5], [7, 12], [14, 19]]);
    expect(markRanges("aaaa", "aa")).toEqual([[0, 2], [2, 4]]);
  });

  it("trims the query, and marks nothing for one under two characters or an empty text", () => {
    expect(markRanges("a login", "  login ")).toEqual([[2, 7]]);
    expect(markRanges("a login", "l")).toEqual([]);
    expect(markRanges("a login", "   ")).toEqual([]);
    expect(markRanges("", "login")).toEqual([]);
  });

  it("keeps its places true to the original when a capital letter lowers to a longer one, and never cuts a pair", () => {
    // "İ" lowers to two characters: left alone, so what follows it is still found where it is.
    expect(markRanges("İx login", "login")).toEqual([[3, 8]]);
    const text = "😀 ab 😀ab";
    expect(markRanges(text, "ab").map(([s, e]) => text.slice(s, e))).toEqual(["ab", "ab"]);
    expect(markRanges("😀😀", "😀")).toEqual([[0, 2], [2, 4]]);
    expect(markRanges("😀😀", "😀😀")).toEqual([[0, 4]]);
  });

  it("cuts a text into pieces that are each a match or not, and leaves one with nothing to mark whole", () => {
    expect(splitMarked("Fix the Login bug and login", "login")).toEqual([
      { text: "Fix the ", hit: false },
      { text: "Login", hit: true },
      { text: " bug and ", hit: false },
      { text: "login", hit: true },
    ]);
    expect(splitMarked("login", "login")).toEqual([{ text: "login", hit: true }]);
    expect(splitMarked("nothing here", "login")).toEqual([{ text: "nothing here", hit: false }]);
    expect(splitMarked("login", undefined)).toEqual([{ text: "login", hit: false }]);
    expect(splitMarked("login", "l")).toEqual([{ text: "login", hit: false }]);
  });

  it("marks a match across tokens as one, and each piece keeps its token's kind", () => {
    const line = [{ kind: "keyword", text: "const" }, { kind: "plain", text: " user" }, { kind: "string", text: "'name'" }];
    expect(markTokens(line, "t user'na")).toEqual([
      { kind: "keyword", text: "cons", hit: false },
      { kind: "keyword", text: "t", hit: true },
      { kind: "plain", text: " user", hit: true },
      { kind: "string", text: "'na", hit: true },
      { kind: "string", text: "me'", hit: false },
    ]);
    expect(markTokens(line, "zzz")).toEqual(line.map((t) => ({ ...t, hit: false })));
    expect(markTokens(line, undefined)).toHaveLength(3);
  });

  it("says whether a text has the query at all", () => {
    expect(hasMark("a login", "LOGIN")).toBe(true);
    expect(hasMark("a login", "signup")).toBe(false);
    expect(hasMark("a login", undefined)).toBe(false);
  });
});
