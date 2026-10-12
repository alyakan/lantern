import { describe, expect, it } from "vitest";
import { decodeDraft, encodeDraft, expandPastes, inUse, isBigPaste, lineCount, nextNumber, placeholder, tokenBefore } from "./paste";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

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
