import type { Item } from "../sync/reducer";
import { currentMatch, findRows, quickReplies, quote, rowText, stepMatch } from "./chatText";
import { timeline } from "./timeline";

const you = (id: string, text: string): Item => ({ kind: "user", id, text, at: null, sentBy: null });
const said = (id: string, text: string): Item => ({ kind: "assistant", id, text, streaming: false });

describe("what a chat says in words", () => {
  const rows = timeline([you("u1", "Please fix the login bug"), said("a1", "Fixed the login bug in auth.ts, and added a test."), { kind: "turn", id: "t1", isError: false, result: "ok", durationMs: 1000 }, you("u2", "Now the signup page"), said("a2", "# Plan step 1 — Signup\\nStart with the form.")]);

  it("reads a message, a page and a summary, and nothing for a turn line", () => {
    expect(rowText(rows[0])).toBe("Please fix the login bug");
    expect(rowText(rows.find((r) => r.kind === "turn")!)).toBeNull();
    const page = rows.find((r) => r.kind === "page");
    expect(page && rowText(page)).toContain("Plan step 1");
  });

  it("finds the messages that say it, any case, the oldest first", () => {
    const found = findRows(rows, "LOGIN");
    expect(found.map((m) => m.key)).toEqual(["u-u1", "a-a1"]);
    expect(found.map((m) => rows[m.index].key)).toEqual(["u-u1", "a-a1"]);
  });

  it("counts a message once, however many times it says it", () => {
    expect(findRows(timeline([said("a1", "ab ab ab")]), "ab")).toHaveLength(1);
  });

  it("finds nothing for a query that is too short or isn't there", () => {
    expect(findRows(rows, "a")).toEqual([]);
    expect(findRows(rows, "  ")).toEqual([]);
    expect(findRows(rows, "zzzz")).toEqual([]);
  });

  it("starts on the newest match and steps older or newer, round at the ends", () => {
    const found = findRows(rows, "login");
    expect(currentMatch(found, null)?.key).toBe("a-a1");
    expect(stepMatch(found, null, -1)?.key).toBe("u-u1");
    expect(stepMatch(found, "u-u1", 1)?.key).toBe("a-a1");
    expect(stepMatch(found, "u-u1", -1)?.key).toBe("a-a1");
    expect(stepMatch(found, "a-a1", 1)?.key).toBe("u-u1");
  });

  it("keeps its place by the message, so a changed list does not move it, and falls back to the newest if it is gone", () => {
    const found = findRows(rows, "login");
    expect(currentMatch(found, "u-u1")?.key).toBe("u-u1");
    expect(currentMatch(found, "gone")?.key).toBe("a-a1");
    expect(currentMatch([], null)).toBeNull();
    expect(stepMatch([], null, 1)).toBeNull();
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

  describe("the words Claude asks to be said", () => {
    it("are offered as they were asked, whatever the quotes or bold around them", () => {
      expect(quickReplies('Reply "publish the draft" when you are ready.')).toEqual(["publish the draft"]);
      expect(quickReplies("Say **\"admin merge\"** and I'll merge it.")).toEqual(["admin merge"]);
      expect(quickReplies("Type “go” to continue.")).toEqual(["go"]);
      expect(quickReplies("Send `ship it` and I will.")).toEqual(["ship it"]);
      expect(quickReplies("Say **upload to TestFlight** and I'll build it.")).toEqual(["upload to TestFlight"]);
      expect(quickReplies("Reply with “yes, merge both”.")).toEqual(["yes, merge both"]);
      // A full stop or a comma inside the quotes is not part of the words.
      expect(quickReplies('Say "admin merge."')).toEqual(["admin merge"]);
    });

    it("are each offered, in the order asked, from a list", () => {
      const text = "To try it:\n\n1. Say **\"admin merge\"** and I'll merge #204.\n2. Say **\"upload to TestFlight\"** and I'll build build 10.";
      expect(quickReplies(text)).toEqual(["admin merge", "upload to TestFlight"]);
    });

    it("are offered once each, and no more than four", () => {
      expect(quickReplies('Say "go" now. I mean it: say "GO".')).toEqual(["go"]);
      expect(quickReplies('Say "one one". Say "two two". Say "three three". Say "four four". Say "five five".')).toEqual(["one one", "two two", "three three", "four four"]);
    });

    it("come before Yes and No when a message has both", () => {
      expect(quickReplies('Say "admin merge" and I will. Ready to merge?')).toEqual(["admin merge"]);
    });

    it("are not found in what only mentions words: a quotation, an error, or something said a long time before the end", () => {
      for (const text of ['The error was "file not found" in auth.ts.', 'Claude said "hello" to me.', "I'll say it's done.", 'He wrote "x" in the margin.', 'Say "a" now.', 'Say "!!!" now.']) expect(quickReplies(text)).toEqual([]);
      const early = `Say "admin merge" and it merges.\n${"A line of explanation.\n".repeat(10)}All done.`;
      expect(quickReplies(early)).toEqual([]);
    });
  });
});
