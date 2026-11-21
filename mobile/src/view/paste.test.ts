import { isLong, LONG_CHARS, pastedPart, previewOf } from "./paste";

const big = "line of a long paste\n".repeat(30);

describe("long text", () => {
  it("is long by its characters or its lines", () => {
    expect(isLong("short")).toBe(false);
    expect(isLong("x".repeat(LONG_CHARS))).toBe(true);
    expect(isLong("a\n".repeat(10))).toBe(true);
  });
});

describe("what a paste leaves in the box", () => {
  it("takes a long paste out, whatever was already typed", () => {
    expect(pastedPart("", big)).toEqual({ pasted: big, rest: "" });
    expect(pastedPart("Explain this: ", `Explain this: ${big}`)).toEqual({ pasted: big, rest: "Explain this: " });
  });

  it("takes a paste out of the middle of the words, leaving both sides", () => {
    expect(pastedPart("before after", `before ${big}after`)).toEqual({ pasted: big, rest: "before after" });
  });

  it("leaves typing and short pastes alone", () => {
    expect(pastedPart("hel", "hell")).toBeNull();
    expect(pastedPart("", "a short paste")).toBeNull();
  });

  it("leaves a change that took words away alone", () => {
    expect(pastedPart(big, "x")).toBeNull();
  });
});

describe("a card's preview", () => {
  it("is the first few lines that say something", () => {
    expect(previewOf("\n  one \n\ntwo\nthree\nfour")).toBe("one\ntwo\nthree");
  });
});
