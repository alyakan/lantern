import { describe, expect, it } from "vitest";
import { RECALL_LIMIT, withPrompt } from "./promptHistory";

describe("withPrompt", () => {
  it("adds a prompt as the newest", () => {
    expect(withPrompt(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });

  it("moves a prompt sent again to the newest, instead of keeping two", () => {
    expect(withPrompt(["a", "b", "c"], "a")).toEqual(["b", "c", "a"]);
  });

  it("keeps the newest fifty for each folder", () => {
    const full = Array.from({ length: RECALL_LIMIT }, (_, i) => `p${i}`);
    const next = withPrompt(full, "new");
    expect(next).toHaveLength(RECALL_LIMIT);
    expect(next[0]).toBe("p1");
    expect(next[next.length - 1]).toBe("new");
  });
});
