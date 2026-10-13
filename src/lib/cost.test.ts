import { describe, expect, it } from "vitest";
import { formatCost, formatTokens, usageLine } from "./cost";

describe("formatCost", () => {
  it("shows a dollar figure only when there's a cost to show", () => {
    expect(formatCost(0.04)).toBe("$0.04");
    expect(formatCost(1.2)).toBe("$1.20");
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(0)).toBeNull();
    expect(formatCost(null)).toBeNull();
  });
});

describe("formatTokens", () => {
  it("reads naturally at each size", () => {
    expect(formatTokens(950)).toBe("950 tokens");
    expect(formatTokens(1_500)).toBe("1.5k tokens");
    expect(formatTokens(1_000)).toBe("1k tokens");
    expect(formatTokens(12_345)).toBe("12k tokens");
    expect(formatTokens(246_366)).toBe("246k tokens");
    expect(formatTokens(1_400_000)).toBe("1.4M tokens");
  });

  it("shows nothing for none, or none known", () => {
    expect(formatTokens(0)).toBeNull();
    expect(formatTokens(null)).toBeNull();
  });
});

describe("usageLine", () => {
  it("puts the cost and the tokens together, and leaves out what isn't known", () => {
    expect(usageLine(0.04, 12_345)).toBe("$0.04 · 12k tokens");
    // A login that isn't billed per use has no cost: tokens only, and no dollar figure at all.
    expect(usageLine(null, 12_345)).toBe("12k tokens");
    expect(usageLine(null, null)).toBeNull();
    expect(usageLine(0, 0)).toBeNull();
  });
});
