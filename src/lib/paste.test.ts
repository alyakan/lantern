import { describe, expect, it } from "vitest";
import { decodeDraft, draftOf, encodeDraft, expandPastes, inUse, isBigPaste, lineCount, nextNumber, placeholder, prependDraft, tokenBefore } from "./paste";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("draftOf", () => {
  it("keeps a short message as it is, and a big one as a placeholder with its text", () => {
    expect(draftOf("hello")).toBe("hello");
    const big = draftOf(lines(8));
    expect(decodeDraft(big)).toEqual({ text: placeholder(1, lines(8)), pastes: { 1: lines(8) } });
  });
});

describe("prependDraft", () => {
  it("puts the edit in an empty box as it is", () => {
    expect(prependDraft("", "fix the test")).toBe("fix the test");
  });

  it("goes in front of what's typed, with a blank line between", () => {
    expect(prependDraft("and the lint too", "fix the test")).toBe("fix the test\n\nand the lint too");
  });

  it("keeps the paste placeholders of both, with the edit's renumbered past the box's", () => {
    const box = encodeDraft(`see ${placeholder(1, lines(7))}`, { 1: lines(7) });
    const edit = encodeDraft(`${placeholder(1, lines(6))} then ${placeholder(2, lines(9))}`, { 1: lines(6), 2: lines(9) });
    const out = decodeDraft(prependDraft(box, edit));
    expect(out.text).toBe(`${placeholder(2, lines(6))} then ${placeholder(3, lines(9))}\n\nsee ${placeholder(1, lines(7))}`);
    expect(out.pastes).toEqual({ 1: lines(7), 2: lines(6), 3: lines(9) });
    expect(expandPastes(out.text, out.pastes)).toBe(`${lines(6)} then ${lines(9)}\n\nsee ${lines(7)}`);
  });
});

describe("isBigPaste", () => {
  it("counts lines, not a trailing newline, and long text on one line", () => {
    expect(lineCount("a\nb\n")).toBe(2);
    expect(isBigPaste(lines(5))).toBe(false);
    expect(isBigPaste(`${lines(5)}\n`)).toBe(false);
    expect(isBigPaste(lines(6))).toBe(true);
    expect(isBigPaste("x".repeat(1000))).toBe(false);
    expect(isBigPaste("x".repeat(1001))).toBe(true);
  });
});

describe("placeholders", () => {
  it("name the paste's number and size", () => {
    expect(placeholder(1, lines(120))).toBe("[Pasted text #1 · 120 lines]");
    expect(placeholder(2, "x".repeat(2000))).toBe("[Pasted text #2 · 1 line]");
  });

  it("are replaced by their text when sent, and the text around them stays", () => {
    const pastes = { 1: lines(7), 2: "second" };
    expect(expandPastes(`why does\n${placeholder(1, pastes[1])}\nfail? ${placeholder(2, pastes[2])}`, pastes)).toBe(`why does\n${lines(7)}\nfail? second`);
  });

  it("are left alone when their text isn't kept (typed by hand, or from another draft)", () => {
    expect(expandPastes("see [Pasted text #3 · 9 lines]", { 1: "x" })).toBe("see [Pasted text #3 · 9 lines]");
  });

  it("take the next number after the ones in the box and the ones kept", () => {
    expect(nextNumber("", {})).toBe(1);
    expect(nextNumber("[Pasted text #1 · 9 lines] [Pasted text #4 · 9 lines]", {})).toBe(5);
    expect(nextNumber("", { 2: "x" })).toBe(3);
  });

  it("let you keep only the pastes still in the text, and find one at the caret", () => {
    const text = "a [Pasted text #1 · 9 lines] b";
    expect(inUse(text, { 1: "one", 2: "two" })).toEqual({ 1: "one" });
    const end = "a [Pasted text #1 · 9 lines]".length;
    expect(tokenBefore(text, end)).toEqual({ n: 1, start: 2, end });
    expect(tokenBefore(text, end - 1)).toBeNull();
    expect(tokenBefore(text, end + 1)).toBeNull();
  });
});

describe("drafts", () => {
  it("are plain text when there's nothing pasted, and keep the pastes still in the text otherwise", () => {
    expect(encodeDraft("hello", {})).toBe("hello");
    expect(encodeDraft("hello", { 1: "unused" })).toBe("hello");
    const text = `see ${placeholder(1, lines(8))}`;
    const draft = encodeDraft(text, { 1: lines(8), 2: "gone" });
    expect(decodeDraft(draft)).toEqual({ text, pastes: { 1: lines(8) } });
  });

  it("read back a draft with no pastes, or a mark that isn't followed by pastes, as just text", () => {
    expect(decodeDraft("plain")).toEqual({ text: "plain", pastes: {} });
    const broken = "text⁣⁣pastes⁣⁣{not json";
    expect(decodeDraft(broken)).toEqual({ text: broken, pastes: {} });
    expect(decodeDraft("text⁣⁣pastes⁣⁣[1,2]").pastes).toEqual({});
  });
});
