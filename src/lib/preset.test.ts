import { describe, expect, it } from "vitest";
import { BUILT_IN, SUBAGENTS_OFF, advisorsFor, familyOf, presetsOf, settingsOf, summary, usesFable, validAdvisor } from "./preset";

const [def, balanced, thrifty, max] = BUILT_IN;

describe("preset", () => {
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
    expect(settingsOf(def, app)).toEqual({ model: "opus", effort: "xhigh", advisor: null, subagent_model: null, plugins_off: false });
    expect(settingsOf(balanced, app)).toEqual({ model: "sonnet", effort: "high", advisor: "opus", subagent_model: "haiku", plugins_off: false });
    // Thrifty starts without the user's plugins; a preset saved before the setting existed keeps them.
    expect(settingsOf(BUILT_IN.find((h) => h.id === "thrifty")!, app).plugins_off).toBe(true);
    expect(summary(BUILT_IN.find((h) => h.id === "thrifty")!)).toBe("Haiku · Opus advisor · Haiku subagents · no plugins");
    expect(settingsOf({ ...balanced, plugins: undefined }, app).plugins_off).toBe(false);
    // A Thrifty saved before the setting existed gets it; one set back to your plugins keeps that.
    const { plugins: _, ...oldThrifty } = BUILT_IN.find((h) => h.id === "thrifty")!;
    expect(presetsOf([oldThrifty]).find((h) => h.id === "thrifty")!.plugins).toBe(false);
    expect(presetsOf([{ ...oldThrifty, plugins: true }]).find((h) => h.id === "thrifty")!.plugins).toBe(true);
    expect(presetsOf([{ ...oldThrifty, id: "mine" }]).find((h) => h.id === "mine")!.plugins).toBeUndefined();
  });

  it("describes each preset in a line, and flags Fable", () => {
    expect(summary(balanced)).toBe("Sonnet · Opus advisor · Haiku subagents");
    expect(summary(def)).toMatch(/Claude Code's own settings/);
    expect(summary({ ...balanced, subagent: SUBAGENTS_OFF })).toBe("Sonnet · Opus advisor · no subagents");
    expect(usesFable(max)).toBe(true);
    expect(usesFable(thrifty)).toBe(false);
  });

  it("always offers Default first", () => {
    expect(presetsOf([balanced, def, max]).map((h) => h.id)).toEqual(["default", "balanced", "max"]);
  });
});
