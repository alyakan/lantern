import { describe, expect, it, vi } from "vitest";
import { initialState, type State } from "../store";
import type { CloseCheck } from "../types";
import { closeAll, closedLine, lostBrief, planClosing, riskyQuestion, stoppedAgents } from "./closeStopped";
import type { OrchestraNode } from "./orchestraView";

const node = (slot: string, role: "main" | "worker" = "worker"): OrchestraNode => ({ slot, role, parent: role === "main" ? null : "s1", name: `Name ${slot}`, branch: null, isolation: "worktree" });
const state = (over: Partial<State>): State => ({ ...initialState, ...over });
const check = (uncommitted: number, unmerged_commits: number): CloseCheck => ({ worktree: true, branch: "b", uncommitted, unmerged_commits });

describe("which agents are stopped", () => {
  it("is the stopped and failed workers: never the Lead, never one that works, waits or is starting", () => {
    const states: Record<string, State> = {
      s1: state({ status: "ended" }),
      w1: state({ status: "ended" }),
      w2: state({ status: "running" }),
      w3: state({ status: "idle" }),
      w4: state({ status: "starting" }),
      w5: state({ status: "ended", banner: { kind: "error", text: "boom" } as State["banner"] }),
      w6: state({ status: "ended", setup: { status: "running" } as State["setup"] }),
    };
    const nodes = [node("s1", "main"), ...["w1", "w2", "w3", "w4", "w5", "w6", "w7"].map((s) => node(s))];
    expect(stoppedAgents(nodes, (s) => states[s]).map((a) => a.slot)).toEqual(["w1", "w5"]);
  });
});

describe("the question about work that isn't merged", () => {
  it("says what each would lose, in the form the product owner reads", () => {
    expect(lostBrief(check(0, 3))).toBe("3 commits");
    expect(lostBrief(check(1, 0))).toBe("1 uncommitted file");
    expect(lostBrief(check(2, 1))).toBe("1 commit and 2 uncommitted files");
    const risky = [
      { slot: "a", name: "Login form", check: check(0, 3) },
      { slot: "b", name: "API docs", check: check(1, 0) },
    ];
    expect(riskyQuestion(risky)).toBe("2 agents have work that isn't merged: Login form (3 commits), API docs (1 uncommitted file). Close them anyway?");
    expect(riskyQuestion(risky.slice(0, 1))).toBe("1 agent has work that isn't merged: Login form (3 commits). Close it anyway?");
  });

  it("sorts the checked agents into those with nothing to lose, those with work, and those that can't be closed", async () => {
    const answers: Record<string, CloseCheck | string> = { a: check(0, 0), b: check(0, 2), c: "Its branch is being merged.", d: { worktree: false, branch: null, uncommitted: 0, unmerged_commits: 0 } };
    const plan = await planClosing(
      ["a", "b", "c", "d"].map((slot) => ({ slot, name: slot.toUpperCase() })),
      (slot) => (typeof answers[slot] === "string" ? Promise.reject(answers[slot]) : Promise.resolve(answers[slot] as CloseCheck)),
    );
    expect(plan.free.map((a) => a.slot)).toEqual(["a", "d"]);
    expect(plan.risky.map((a) => a.slot)).toEqual(["b"]);
    expect(plan.refused).toEqual([{ name: "C", reason: "Its branch is being merged." }]);
  });
});

describe("closing them", () => {
  it("closes in order with what was agreed, leaves one that is no longer stopped, and keeps one that refuses", async () => {
    const closeWorker = vi.fn((slot: string) => (slot === "b" ? Promise.reject(new Error("It gained work.")) : Promise.resolve()));
    const out = await closeAll(
      [
        { slot: "a", name: "A" },
        { slot: "b", name: "B", agreed: { uncommitted: 0, unmerged_commits: 1 } },
        { slot: "c", name: "C" },
        { slot: "d", name: "D", agreed: { uncommitted: 2, unmerged_commits: 0 } },
      ],
      { closeWorker, stillStopped: (slot) => slot !== "c" },
    );
    expect(closeWorker.mock.calls).toEqual([["a", undefined], ["b", { uncommitted: 0, unmerged_commits: 1 }], ["d", { uncommitted: 2, unmerged_commits: 0 }]]);
    expect(out).toEqual({ closed: 2, kept: 2, problems: ["B: It gained work."] });
  });

  it("says what happened", () => {
    expect(closedLine(4, 1)).toBe("Closed 4 agents. Kept 1.");
    expect(closedLine(1, 0)).toBe("Closed 1 agent.");
    expect(closedLine(0, 2)).toBe("No agents were closed. Kept 2.");
    expect(closedLine(2, 1, ["B: Its branch is being merged"])).toBe("Closed 2 agents. Kept 1. B: Its branch is being merged.");
  });
});
