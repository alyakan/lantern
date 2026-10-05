import { describe, expect, it } from "vitest";
import { modelLabel } from "./models";

describe("modelLabel", () => {
  it("turns model ids into short names", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelLabel("claude-sonnet-5")).toBe("Sonnet 5");
    expect(modelLabel("claude-opus-5-5[1m]")).toBe("Opus 5.5 [1m]");
  });

  it("leaves anything else alone", () => {
    expect(modelLabel("some-proxy-model")).toBe("some-proxy-model");
  });
});
