import { describe, expect, it } from "vitest";
import { BUILT_IN, advisorsFor, familyOf, presetsOf, settingsOf, summary, usesFable, validAdvisor } from "./harness";

const [def, balanced, thrifty, max] = BUILT_IN;

describe("harness", () => {
  it("tells model families from aliases and ids", () => {
    expect(familyOf("sonnet")).toBe("sonnet");
    expect(familyOf("claude-opus-5-5")).toBe("opus");
    expect(familyOf("claude-fable-5-1")).toBe("fable");
    expect(familyOf(null)).toBeNull();
  });

  it("offers only advisors Claude Code accepts for the main model", () => {
    expect(advisorsFor("opus")).toEqual(["opus", "fable"]);
    expect(advisorsFor("sonnet")).not.toContain("haiku");
    expect(advisorsFor("haiku")).toContain("haiku");
    expect(advisorsFor("fable")).toEqual(["fable"]);
    // Every built-in preset pairs validly.
    for (const h of BUILT_IN) expect(validAdvisor(h, null)).toBe(true);
    expect(validAdvisor({ ...max, advisor: "sonnet" }, null)).toBe(false);
    // With no main model named, what claude runs decides.
    expect(validAdvisor({ ...balanced, model: null, advisor: "sonnet" }, "claude-opus-5-5")).toBe(false);
  });

  it("starts claude with the preset's models, or the app's for Default", () => {
    const app = { model: "opus", effort: "xhigh" };
    expect(settingsOf(def, app)).toEqual({ model: "opus", effort: "xhigh", advisor: null, subagent_model: null });
    expect(settingsOf(balanced, app)).toEqual({ model: "sonnet", effort: "high", advisor: "opus", subagent_model: "haiku" });
  });

  it("describes each preset in a line, and flags Fable", () => {
    expect(summary(balanced)).toBe("Sonnet · Opus advisor · Haiku subagents");
    expect(summary(def)).toMatch(/Claude Code's own settings/);
    expect(usesFable(max)).toBe(true);
    expect(usesFable(thrifty)).toBe(false);
  });

  it("always offers Default first", () => {
    expect(presetsOf([balanced, def, max]).map((h) => h.id)).toEqual(["default", "balanced", "max"]);
  });
});
