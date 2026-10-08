import { describe, expect, it } from "vitest";
import { describeCommands, replaceTrigger, sections, triggerAt } from "./complete";

describe("triggerAt", () => {
  it("finds a / or @ word at the caret, at the start or after a space", () => {
    expect(triggerAt("/com", 4)).toEqual({ kind: "/", query: "com", start: 0, end: 4, atStart: true });
    expect(triggerAt("fix it /grill now", 13)).toEqual({ kind: "/", query: "grill", start: 7, end: 13, atStart: false });
    expect(triggerAt("see @src/a", 10)).toMatchObject({ kind: "@", query: "src/a", start: 4 });
    expect(triggerAt("line one\n/x", 11)).toMatchObject({ kind: "/", query: "x", atStart: false });
  });

  it("leaves paths, emails and words without a sign alone", () => {
    expect(triggerAt("src/foo", 7)).toBeNull();
    expect(triggerAt("/Users/me", 9)).toBeNull();
    expect(triggerAt("me@example.com", 14)).toBeNull();
    expect(triggerAt("hello", 5)).toBeNull();
  });

  it("puts a pick in place of the word, with one space after", () => {
    expect(replaceTrigger("a /gr b", triggerAt("a /gr b", 5)!, "/grill-me")).toEqual({ text: "a /grill-me b", caret: 11 });
    expect(replaceTrigger("a /gr", triggerAt("a /gr", 5)!, "/grill-me")).toEqual({ text: "a /grill-me ", caret: 12 });
  });
});

describe("describeCommands", () => {
  it("tells skills, commands and MCP prompts apart, with where each comes from", () => {
    const commands = [
      { name: "clear", description: "Clear history", argument_hint: "" },
      { name: "grill-me", description: "Interview the user (user)", argument_hint: "" },
      { name: "deploy", description: "Ship it (project)", argument_hint: "" },
      { name: "superpowers:brainstorming", description: "Explore (plugin:superpowers)", argument_hint: "" },
      { name: "mcp__claude_ai_Linear__triage", description: "Triage (MCP)", argument_hint: "" },
    ];
    const index = [{ name: "grill-me", kind: "skill" as const, source: "user" as const, plugin: null, path: "", description: "" }];
    expect(describeCommands(commands, index).map((c) => [c.name, c.kind, c.source, c.description])).toEqual([
      ["clear", "command", "Built-in", "Clear history"],
      ["grill-me", "skill", "Yours", "Interview the user"],
      ["deploy", "command", "Project", "Ship it"],
      ["superpowers:brainstorming", "skill", "superpowers", "Explore"],
      ["mcp__claude_ai_Linear__triage", "mcp", "Linear", "Triage"],
    ]);
  });

  it("drops commands from the sections mid-message", () => {
    const m = describeCommands([{ name: "clear", description: "", argument_hint: "" }, { name: "a:b", description: "", argument_hint: "" }], []);
    expect(sections(m, true).map((s) => s.kind)).toEqual(["skill", "command"]);
    expect(sections(m, false).map((s) => s.kind)).toEqual(["skill"]);
  });
});
