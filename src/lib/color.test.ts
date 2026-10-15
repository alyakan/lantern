import { describe, expect, it } from "vitest";
import { alpha, contrast, ensureContrast, isDark, isHex, luminance, mix, normalizeHex, parseHex, readableOn, toHex } from "./color";

describe("colour sums", () => {
  it("reads and writes hex, short or long, dropping an alpha", () => {
    expect(parseHex("#1f1f24")).toEqual([31, 31, 36]);
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
    expect(parseHex("#ffffff80")).toEqual([255, 255, 255]);
    expect(toHex([31, 31, 36])).toBe("#1f1f24");
    expect(parseHex("not a colour")).toEqual([0, 0, 0]);
  });

  it("knows a hex colour from anything else", () => {
    expect(isHex("#abc")).toBe(true);
    expect(isHex("#aabbcc")).toBe(true);
    expect(isHex("#aabbccdd")).toBe(false);
    expect(isHex("red")).toBe(false);
    expect(isHex("#fff; x")).toBe(false);
  });

  it("mixes two colours, and makes one see-through", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("#102030", "#102030", 0.7)).toBe("#102030");
    expect(alpha("#ffffff", 0.05)).toBe("#ffffff0d");
  });

  it("measures contrast as WCAG does", () => {
    expect(luminance("#ffffff")).toBeCloseTo(1);
    expect(luminance("#000000")).toBeCloseTo(0);
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21);
    expect(contrast("#777777", "#777777")).toBeCloseTo(1);
    // The same ratio whichever is the text.
    expect(contrast("#1d1d1f", "#ffffff")).toBeCloseTo(contrast("#ffffff", "#1d1d1f"));
  });

  it("tells dark backgrounds from light ones, and picks the text that reads on them", () => {
    expect(isDark("#1f1f24")).toBe(true);
    expect(isDark("#fbf6ec")).toBe(false);
    expect(readableOn("#1f1f24")).toBe("#ffffff");
    expect(readableOn("#ffffff")).toBe("#000000");
  });

  it("moves a colour only as far as it takes to read, and not at all when it already does", () => {
    expect(ensureContrast("#1d1d1f", "#ffffff", 4.5)).toBe("#1d1d1f");
    const lifted = ensureContrast("#777777", "#ffffff", 7);
    expect(contrast(lifted, "#ffffff")).toBeGreaterThanOrEqual(7);
    expect(contrast(ensureContrast("#444444", "#222222", 4.5), "#222222")).toBeGreaterThanOrEqual(4.5);
    expect(ensureContrast("#777777", "#ffffff", 21)).toBe("#000000");
  });
});

describe("normalizeHex", () => {
  it("lets through #rgb and #rrggbb only, as lower-case #rrggbb", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("#1F1F24")).toBe("#1f1f24");
    for (const bad of ["#abcd", "#aabbccdd", "abc", "red", "#abc ", " #abc", "#abc\n", "#abg", "#abc;", 5, null, undefined, {}]) expect(normalizeHex(bad), String(bad)).toBeNull();
  });
});
