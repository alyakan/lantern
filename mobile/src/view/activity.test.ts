import type { Item } from "../sync/reducer";
import { activityOf, elapsed, stepActivity } from "./activity";

type Step = Extract<Item, { kind: "step" }>;
const step = (name: string, summary = "", done = false): Step => ({ kind: "step", id: name + summary, name, summary, done, isError: false, edits: [], tests: null });

describe("what a step is doing, in a few words", () => {
  it("says the command, the file or the kind of thing", () => {
    expect(stepActivity(step("Bash", "npm test"))).toBe("Running npm test");
    expect(stepActivity(step("Edit", "mobile/src/screens/HomeScreen.tsx"))).toBe("Editing HomeScreen.tsx");
    expect(stepActivity(step("Read", "/p/a.ts"))).toBe("Reading a.ts");
    expect(stepActivity(step("Grep", "foo"))).toBe("Searching the code");
    expect(stepActivity(step("mcp__claude_ai_Linear__list_issues"))).toBe("Using Linear");
    expect(stepActivity(step("advisor"))).toBe("Asking the advisor");
    expect(stepActivity(step("Bash"))).toBe("Running a command");
  });
  it("cuts a long command short", () => {
    expect(stepActivity(step("Bash", "x".repeat(100))).length).toBeLessThan(60);
  });
});

describe("what the chat is doing now", () => {
  const you: Item = { kind: "user", id: "u", text: "go", at: null, sentBy: null };
  it("is the newest step still going in this turn", () => {
    expect(activityOf([you, step("Read", "a.ts", true), step("Bash", "npm test")], false)).toBe("Running npm test");
  });
  it("is writing while words stream, else thinking, else working", () => {
    expect(activityOf([you, { kind: "assistant", id: "a", text: "Hel", streaming: true }], false)).toBe("Writing");
    expect(activityOf([you], true)).toBe("Thinking");
    expect(activityOf([you, step("Read", "a.ts", true)], false)).toBe("Working");
  });
  it("doesn't look past the turn's start", () => {
    expect(activityOf([step("Bash", "old"), you], true)).toBe("Thinking");
  });
  it("is the post-hook once that has begun", () => {
    expect(activityOf([you, { kind: "hook", id: "h", text: "x" }], false)).toBe("Running your post-hook");
  });
});

describe("how long it has been at it", () => {
  it("is seconds, then minutes, then hours", () => {
    expect(elapsed(12_400)).toBe("12 s");
    expect(elapsed(3 * 60_000 + 5000)).toBe("3 min");
    expect(elapsed(65 * 60_000)).toBe("1 h 5 min");
    expect(elapsed(-5)).toBe("0 s");
  });
});
