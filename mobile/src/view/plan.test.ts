import { matchCommands, slashQuery } from "./slash";
import { progressOf, untilText, usageOf } from "./plan";

const todo = (content: string, status: string, active_form = `${content}…`) => ({ content, status, active_form });

describe("the plan", () => {
  it("counts what is done and says what is being done now", () => {
    const p = progressOf([todo("A", "completed"), todo("B", "in_progress", "Doing B"), todo("C", "pending")]);
    expect(p).toEqual({ done: 1, total: 3, current: "Doing B", finished: false });
  });

  it("names the first not done when nothing is in progress, and is finished when all are done", () => {
    expect(progressOf([todo("A", "completed"), todo("B", "pending")]).current).toBe("B");
    expect(progressOf([todo("A", "completed")])).toEqual({ done: 1, total: 1, current: null, finished: true });
    expect(progressOf([])).toEqual({ done: 0, total: 0, current: null, finished: false });
  });
});

describe("the usage", () => {
  const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
  const at = (min: number) => NOW / 1000 + min * 60;

  it("is a whole percent with when it resets", () => {
    expect(usageOf({ used: 0.426, resetsAt: at(130), status: "allowed" }, NOW)).toEqual({ percent: 43, resets: "Resets in 2 h 10 min", tone: "ok" });
    expect(usageOf({ used: 0.1, resetsAt: null, status: "allowed" }, NOW).resets).toBe("");
  });

  it("warns near the limit and stops at it", () => {
    expect(usageOf({ used: 0.85, resetsAt: null, status: "allowed" }, NOW).tone).toBe("warn");
    expect(usageOf({ used: 0.5, resetsAt: null, status: "allowed_warning" }, NOW).tone).toBe("warn");
    expect(usageOf({ used: 1.2, resetsAt: null, status: "allowed" }, NOW)).toMatchObject({ percent: 100, tone: "stop" });
    expect(usageOf({ used: 0.9, resetsAt: null, status: "rejected" }, NOW).tone).toBe("stop");
  });

  it("says a time in hours and minutes, or soon", () => {
    const NOW2 = 1_000_000_000;
    expect(untilText(NOW2 / 1000 + 35 * 60, NOW2)).toBe("35 min");
    expect(untilText(NOW2 / 1000 + 120 * 60, NOW2)).toBe("2 h");
    expect(untilText(NOW2 / 1000 - 5, NOW2)).toBe("soon");
  });
});

describe("slash commands", () => {
  const c = (name: string) => ({ name, description: "", argument_hint: "" });
  const all = [c("compact"), c("review"), c("compact-notes"), c("pr-review"), c("init")];

  it("tells a command being typed from other text", () => {
    expect(slashQuery("/rev")).toBe("rev");
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/review this")).toBeNull();
    expect(slashQuery("hello /x")).toBeNull();
  });

  it("puts names that start with it first, then a part that starts with it, then those that contain it, shorter first", () => {
    expect(matchCommands(all, "rev").map((x) => x.name)).toEqual(["review", "pr-review"]);
    expect(matchCommands(all, "comp").map((x) => x.name)).toEqual(["compact", "compact-notes"]);
    expect(matchCommands(all, "it").map((x) => x.name)).toEqual(["init"]);
    expect(matchCommands(all, "zzz")).toEqual([]);
    expect(matchCommands(all, "", 2)).toHaveLength(2);
  });
});
