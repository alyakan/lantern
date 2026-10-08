import { describe, expect, it } from "vitest";
import { initialState, reducer, type State } from "../store";
import type { UiEvent } from "../types";
import { agentTree, shortModel, usesAgents } from "./agents";

const run = (events: UiEvent[], at0 = 1000) => {
  let s: State = reducer({ ...initialState, status: "idle" }, { type: "user_sent", text: "fix the auth tests" });
  let now = at0;
  const real = Date.now;
  Date.now = () => (now += 10);
  try {
    for (const event of events) s = reducer(s, { type: "ui_event", event });
  } finally {
    Date.now = real;
  }
  return s;
};
const step = (parent: string | null, id: string, name: string, summary: string, error = false): UiEvent[] => [
  { kind: "tool_started", parent, tool_use_id: id, name, summary },
  { kind: "tool_finished", parent, tool_use_id: id, is_error: error, output: "" },
];
const opts = { live: false, folder: "/p", mainModel: "claude-sonnet-5-5", effort: "high", advisor: "opus" };

const TEAM: UiEvent[] = [
  { kind: "agent_model", parent: null, model: "claude-sonnet-5-5" },
  { kind: "advisor_started", parent: null, id: "a1" },
  { kind: "advisor_done", parent: null, id: "a1", outcome: "reviewed", error_code: null },
  { kind: "tool_started", parent: null, tool_use_id: "w", name: "Agent", summary: "Fix fixtures" },
  { kind: "agent_started", tool_use_id: "w", subagent_type: "general-purpose", description: "Fix fixtures", model: null },
  { kind: "tool_started", parent: null, tool_use_id: "e", name: "Agent", summary: "Map auth" },
  { kind: "agent_started", tool_use_id: "e", subagent_type: "Explore", description: "Map auth", model: null },
  { kind: "agent_model", parent: "e", model: "claude-haiku-5-5" },
  ...step("e", "e1", "Grep", "verifyToken"),
  { kind: "tool_finished", parent: null, tool_use_id: "e", is_error: false, output: "" },
  { kind: "agent_progress", tool_use_id: "w", description: "Running npm test", tokens: 14200, tool_uses: 2, duration_ms: 2600 },
  ...step("w", "w1", "Bash", "npm test", true),
  { kind: "advisor_started", parent: null, id: "a2" },
  { kind: "advisor_done", parent: null, id: "a2", outcome: "unavailable", error_code: "overloaded" },
  ...step("w", "w2", "Bash", "npm test"),
  { kind: "tool_finished", parent: null, tool_use_id: "w", is_error: false, output: "" },
  { kind: "advisor_started", parent: null, id: "a3" },
  { kind: "advisor_done", parent: null, id: "a3", outcome: "reviewed", error_code: null },
];

describe("agentTree", () => {
  it("shows the main session, each subagent with the model it ran on, and when the advisor was consulted", () => {
    const tree = agentTree(run(TEAM).items, opts);
    expect(tree.prompt).toBe("fix the auth tests");
    expect(tree.subagents.map((s) => [s.type, s.model, s.status, s.steps])).toEqual([
      ["general-purpose", null, "done", 2],
      ["Explore", "claude-haiku-5-5", "done", 1],
    ]);
    expect(tree.advisor.calls.map((c) => [c.moment, c.status, c.detail])).toEqual([
      ["before starting", "reviewed", null],
      ["after a failed step", "unavailable", "overloaded"],
      ["before finishing", "reviewed", null],
    ]);
    expect(tree.back).toBe(true);
    expect(usesAgents(tree)).toBe(true);
  });

  it("logs who did what, in order, with each agent's model", () => {
    const log = agentTree(run(TEAM).items, opts).log.map((e) => `${e.agent}|${e.text}`);
    expect(log[0]).toBe("advisor|reviewed · before starting");
    expect(log).toContain("Explore|Grep verifyToken");
    expect(log).toContain("general-purpose|Bash npm test");
    expect(log).toContain("advisor|unavailable (overloaded) · after a failed step");
    expect(log.indexOf("Explore|Handed back to main")).toBeLessThan(log.indexOf("general-purpose|Handed back to main"));
  });

  it("follows a turn as it runs: what each agent is doing, and the main session waiting", () => {
    const live = run(TEAM.slice(0, 12));
    const tree = agentTree(live.items, { ...opts, live: true });
    expect(tree.main.now).toBe("Waiting for 1 subagent");
    expect(tree.subagents[0].now).toBe("Running npm test");
    expect(tree.subagents[0].tokens).toBe(14200);
    expect(tree.back).toBe(false);
  });

  it("is empty before a turn, and quiet for a turn without agents", () => {
    expect(agentTree([], opts).prompt).toBeNull();
    expect(usesAgents(agentTree(run(step(null, "r", "Read", "a.ts")).items, opts))).toBe(false);
  });

  it("names models short", () => {
    expect(shortModel("claude-haiku-5-5")).toBe("Haiku 5.5");
    expect(shortModel("claude-opus-4-8")).toBe("Opus 4.8");
    expect(shortModel("opus")).toBe("Opus");
    expect(shortModel(null)).toBeNull();
  });
});

describe("store and agents", () => {
  it("keeps what each turn cost per model, and the main thread's model", () => {
    const s = run([{ kind: "agent_model", parent: null, model: "claude-haiku-5-5" }, { kind: "model_usage", models: [{ model: "claude-haiku-5-5", cost_usd: 0.06, input_tokens: 1, output_tokens: 2 }] }]);
    expect(s.model).toBe("claude-haiku-5-5");
    expect(s.modelUsage).toHaveLength(1);
  });

  it("forgets step times for a reopened session", () => {
    const s = reducer({ ...initialState, folder: "/p" }, { type: "history_loaded", sessionId: "x", events: [{ kind: "user_text", text: "hi" }, ...step(null, "r", "Read", "a.ts")] });
    const t = s.items.find((it) => it.type === "tool");
    expect(t && "startedAt" in t ? t.startedAt : "missing").toBeUndefined();
  });
});
