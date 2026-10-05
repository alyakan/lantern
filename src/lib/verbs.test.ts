import { describe, expect, it } from "vitest";
import { WORKING_VERBS, workingVerb } from "./verbs";

describe("workingVerb", () => {
  it("gives a turn the same word every time, from the list", () => {
    expect(workingVerb("u3")).toBe(workingVerb("u3"));
    expect(WORKING_VERBS.map((v) => `${v}…`)).toContain(workingVerb("u3"));
  });

  it("varies across turns", () => {
    const words = new Set(Array.from({ length: 20 }, (_, i) => workingVerb(`u${i}`)));
    expect(words.size).toBeGreaterThan(5);
  });
});
