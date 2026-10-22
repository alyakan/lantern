import type { Item } from "../sync/reducer";
import { quickReplies, quote, rowText, searchRows } from "./chatText";
import { timeline } from "./timeline";

const you = (id: string, text: string): Item => ({ kind: "user", id, text, at: 1, sentBy: null });
const said = (id: string, text: string): Item => ({ kind: "assistant", id, text, streaming: false });

describe("what a chat says in words", () => {
  const rows = timeline([you("u1", "Please fix the login bug"), said("a1", "Fixed the login bug in auth.ts, and added a test."), { kind: "turn", id: "t1", isError: false, result: "ok", durationMs: 1000 }, you("u2", "Now the signup page"), said("a2", "# Plan step 1 — Signup\\nStart with the form.")]);

  it("reads a message, a page and a summary, and nothing for a turn line", () => {
    expect(rowText(rows[0])).toBe("Please fix the login bug");
    expect(rowText(rows.find((r) => r.kind === "turn")!)).toBeNull();
    const page = rows.find((r) => r.kind === "page");
    expect(page && rowText(page)).toContain("Plan step 1");
  });

  it("finds messages by what they say, newest first, with what is around it", () => {
    const hits = searchRows(rows, "LOGIN");
    expect(hits.map((h) => [h.who, h.key])).toEqual([["Claude", "a-a1"], ["You", "u-u1"]]);
    expect(hits[1]).toMatchObject({ before: "Please fix the ", match: "login", after: " bug" });
    expect(hits[0].before.startsWith("Fixed the ")).toBe(true);
  });

  it("cuts a long message to a little around the match, with dots", () => {
    const long = `${"a ".repeat(60)}needle${" b".repeat(60)}`;
    const [hit] = searchRows(timeline([said("a1", long)]), "needle");
    expect(hit.before.startsWith("…")).toBe(true);
    expect(hit.after.endsWith("…")).toBe(true);
    expect(hit.match).toBe("needle");
    expect(hit.before.length).toBeLessThan(45);
  });

  it("finds nothing for a query that is too short or isn't there", () => {
    expect(searchRows(rows, "a")).toEqual([]);
    expect(searchRows(rows, "  ")).toEqual([]);
    expect(searchRows(rows, "zzzz")).toEqual([]);
  });
});

describe("quoting", () => {
  it("puts each line behind a > and leaves room to write under it", () => {
    expect(quote("one\ntwo")).toBe("> one\n> two\n\n");
    expect(quote("  one\n\ntwo  ")).toBe("> one\n>\n> two\n\n");
  });
});

describe("quick replies", () => {
  it("are Yes and No for a message that ends on a yes-or-no question", () => {
    for (const text of ["Done with the tests.\n\nShould I push the branch?", "I can also add a changelog. Want me to?", "That changes the API.\n\nIs that OK?", "Ready to merge?", "**Shall I go ahead?**"]) expect(quickReplies(text)).toEqual(["Yes", "No"]);
  });

  it("are none for a question that isn't yes or no, or for no question at all", () => {
    for (const text of ["Which file should I start with?", "What do you want to call it?", "All done.", "Done. Should I push? I'll wait.", "How should this be named?"]) expect(quickReplies(text)).toEqual([]);
  });
});
