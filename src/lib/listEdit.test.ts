import { describe, expect, it } from "vitest";
import { continueList, indentList } from "./listEdit";

/** The text with "|" where the caret is (or "[" and "]" around a selection); returns what continueList makes of it, in the same notation. */
const mark = (v: string, from: number, to = from) => (from === to ? v.slice(0, from) + "|" + v.slice(from) : v.slice(0, from) + "[" + v.slice(from, to) + "]" + v.slice(to));
const parse = (s: string) => {
  const open = s.indexOf("[");
  if (open >= 0) {
    const close = s.indexOf("]");
    return { value: s.slice(0, open) + s.slice(open + 1, close) + s.slice(close + 1), from: open, to: close - 1 };
  }
  const at = s.indexOf("|");
  return { value: s.slice(0, at) + s.slice(at + 1), from: at, to: at };
};
const enter = (s: string) => {
  const { value, from, to } = parse(s);
  const r = continueList(value, from, to);
  return r && mark(r.value, r.caret);
};
const tab = (s: string, outdent = false) => {
  const { value, from, to } = parse(s);
  const r = indentList(value, from, to, outdent);
  return r && mark(r.value, r.caret, r.end);
};

describe("continueList", () => {
  it("starts the next bullet at the end of a list line", () => {
    expect(enter("- item|")).toBe("- item\n- |");
    expect(enter("* item|")).toBe("* item\n* |");
    expect(enter("• item|")).toBe("• item\n• |");
  });

  it("counts on in a numbered list, with either . or )", () => {
    expect(enter("1. item|")).toBe("1. item\n2. |");
    expect(enter("2) item|")).toBe("2) item\n3) |");
    expect(enter("9. item|")).toBe("9. item\n10. |");
    expect(enter("99) item|")).toBe("99) item\n100) |");
  });

  it("keeps the indentation, and a nested number continues its own count", () => {
    expect(enter("- a\n  - b|")).toBe("- a\n  - b\n  - |");
    expect(enter("1. a\n  3. b|")).toBe("1. a\n  3. b\n  4. |");
    expect(enter("\t- tabbed|")).toBe("\t- tabbed\n\t- |");
  });

  it("keeps extra spaces after the marker", () => {
    expect(enter("-   spaced|")).toBe("-   spaced\n-   |");
    expect(enter("1.  spaced|")).toBe("1.  spaced\n2.  |");
  });

  it("continues only the line the caret is on", () => {
    expect(enter("- a\n- b\nplain|")).toBeNull();
    expect(enter("intro\n- a|")).toBe("intro\n- a\n- |");
    expect(enter("- a|\n- b")).toBe("- a\n- |\n- b");
  });

  it("ends the list on an empty item, leaving a plain empty line", () => {
    expect(enter("- |")).toBe("|");
    expect(enter("3. |")).toBe("|");
    expect(enter("- a\n- |")).toBe("- a\n|");
    expect(enter("- a\n  - |")).toBe("- a\n|");
    expect(enter("2)   |")).toBe("|");
    expect(enter("- |\nafter")).toBe("|\nafter");
  });

  it("splits an item at the caret, the text after it moving to the next marker", () => {
    expect(enter("- ab|cd")).toBe("- ab\n- |cd");
    expect(enter("1. ab|cd")).toBe("1. ab\n2. |cd");
    expect(enter("  - ab| cd")).toBe("  - ab\n  - | cd");
    expect(enter("- |item")).toBe("- \n- |item");
    expect(enter("- ab|cd\n- next")).toBe("- ab\n- |cd\n- next");
  });

  it("replaces a selection as a typed newline would, then continues the list", () => {
    expect(enter("- a[bc]d")).toBe("- a\n- |d");
    expect(enter("- [item]")).toBe("- \n- |");
    expect(enter("1. a[b\n2. c]d")).toBe("1. a\n2. |d");
  });

  it("does nothing with the caret in the marker or the indentation", () => {
    expect(enter("|- item")).toBeNull();
    expect(enter("-| item")).toBeNull();
    expect(enter("1.| item")).toBeNull();
    expect(enter(" | - item")).toBeNull();
  });

  it("is not fooled by lines that only look like markers", () => {
    expect(enter("-5|")).toBeNull();
    expect(enter("1.5 million|")).toBeNull();
    expect(enter("-item|")).toBeNull();
    expect(enter("*bold* text|")).toBeNull();
    expect(enter("**bold** text|")).toBeNull();
    expect(enter("1.|")).toBeNull();
    expect(enter("1 item|")).toBeNull();
    expect(enter("a. item|")).toBeNull();
    expect(enter("plain text|")).toBeNull();
    expect(enter("|")).toBeNull();
  });

  it("takes '<digits>. ' followed by text as a marker, even for a year", () => {
    expect(enter("2024. Was a good year|")).toBe("2024. Was a good year\n2025. |");
  });

  it("leaves absurdly long numbers alone", () => {
    expect(enter("12345678901234567890. item|")).toBeNull();
  });

  it("does not continue a list inside a code fence", () => {
    expect(enter("```\n- item|")).toBeNull();
    expect(enter("```js\n1. item|")).toBeNull();
    expect(enter("  ```\n- item|")).toBeNull();
    expect(enter("```\n- a\n```\n- item|")).toBe("```\n- a\n```\n- item\n- |");
    expect(enter("```\n- |")).toBeNull();
  });

  it("works with CRLF-free multi-line text anywhere in the box", () => {
    expect(enter("Todo:\n\n- one\n- two|\n\nthanks")).toBe("Todo:\n\n- one\n- two\n- |\n\nthanks");
  });
});

describe("indentList", () => {
  it("indents a list line by two spaces, the caret going with it", () => {
    expect(tab("- item|")).toBe("  - item|");
    expect(tab("- it|em")).toBe("  - it|em");
    expect(tab("1. item|")).toBe("  1. item|");
    expect(tab("  - item|")).toBe("    - item|");
    expect(tab("- a\n- b|")).toBe("- a\n  - b|");
    expect(tab("- a|\n- b")).toBe("  - a|\n- b");
  });

  it("works with the caret in the marker or the indentation too", () => {
    expect(tab("|- item")).toBe("  |- item");
    expect(tab("-| item")).toBe("  -| item");
  });

  it("removes up to two spaces of indentation with outdent", () => {
    expect(tab("    - item|", true)).toBe("  - item|");
    expect(tab("  - item|", true)).toBe("- item|");
    expect(tab(" - item|", true)).toBe("- item|");
    expect(tab("\t- item|", true)).toBe("- item|");
    expect(tab("  - it|em", true)).toBe("- it|em");
    expect(tab("- a\n  - b|", true)).toBe("- a\n- b|");
  });

  it("keeps the caret in the line when it was in the indentation", () => {
    expect(tab(" | - item", true)).toBe("|- item");
    expect(tab("    |- item", true)).toBe("  |- item");
  });

  it("outdents an unindented list line to the same text, so the key is still its own", () => {
    expect(tab("- item|", true)).toBe("- item|");
  });

  it("is not a list line elsewhere", () => {
    expect(tab("plain|")).toBeNull();
    expect(tab("plain|", true)).toBeNull();
    expect(tab("-5|")).toBeNull();
    expect(tab("1.5|")).toBeNull();
    expect(tab("|")).toBeNull();
    expect(tab("- a\nplain|")).toBeNull();
  });

  it("is not a list line inside a code fence", () => {
    expect(tab("```\n- item|")).toBeNull();
    expect(tab("```\n  - item|", true)).toBeNull();
  });

  it("moves a selection along with its line", () => {
    expect(tab("- [item]")).toBe("  - [item]");
    expect(tab("  - [item]", true)).toBe("- [item]");
  });
});
