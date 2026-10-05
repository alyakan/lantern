import { describe, expect, it } from "vitest";
import { matchCommands, slashQuery } from "./slash";

const cmd = (name: string) => ({ name, description: "", argument_hint: "" });
const all = ["compact", "context", "clear", "config", "axiom:axiom-swift-concurrency", "superpowers:brainstorming", "code-review", "security-review"].map(cmd);

describe("slashQuery", () => {
  it("reads the command being typed, until a space", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/comp")).toBe("comp");
    expect(slashQuery("/compact focus on the parser")).toBeNull();
    expect(slashQuery("fix /this")).toBeNull();
    expect(slashQuery("")).toBeNull();
  });
});

describe("matchCommands", () => {
  it("puts prefix matches first, then namespaced or dashed parts, then anything containing it", () => {
    expect(matchCommands(all, "co").map((c) => c.name)).toEqual(["config", "compact", "context", "code-review", "axiom:axiom-swift-concurrency"]);
    expect(matchCommands(all, "review").map((c) => c.name)).toEqual(["code-review", "security-review"]);
    expect(matchCommands(all, "brain").map((c) => c.name)).toEqual(["superpowers:brainstorming"]);
    expect(matchCommands(all, "concur").map((c) => c.name)).toEqual(["axiom:axiom-swift-concurrency"]);
    expect(matchCommands(all, "ntex").map((c) => c.name)).toEqual(["context"]);
    expect(matchCommands(all, "zzz")).toEqual([]);
  });

  it("shows a few when nothing is typed yet, shortest first", () => {
    expect(matchCommands(all, "", 3).map((c) => c.name)).toEqual(["clear", "config", "compact"]);
  });
});
