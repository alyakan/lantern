import { describe, expect, it } from "vitest";
import { initialState, reducer, type State } from "../store";
import type { UiEvent } from "../types";
import { MAX_UNFOLDED, MIN_VIEW, agentGraph, branchOf, branchView, trailTo, wholeView, zoomTarget } from "./agentGraph";

const run = (events: UiEvent[]) => {
  let s: State = reducer({ ...initialState, status: "idle" }, { type: "user_sent", text: "fix it" });
  for (const event of events) s = reducer(s, { type: "ui_event", event });
  return s;
};
const start = (parent: string | null, id: string, name: string, summary = ""): UiEvent => ({ kind: "tool_started", parent, tool_use_id: id, name, summary });
const end = (parent: string | null, id: string, error = false): UiEvent => ({ kind: "tool_finished", parent, tool_use_id: id, is_error: error, output: "" });
const agent = (id: string, type: string, model: string): UiEvent[] => [start(null, id, "Agent", type), { kind: "agent_started", tool_use_id: id, subagent_type: type, description: type, model: null }, { kind: "agent_model", parent: id, model }];
const opts = { live: true, folder: "/p", mainModel: "claude-sonnet-5-5", effort: "high", advisor: "opus" };

describe("agentGraph", () => {
  it("puts main at the root, the advisor beside it, subagents under it, and each agent's kinds of tools under that", () => {
    const s = run([
      ...agent("w", "general-purpose", "claude-sonnet-5-5"),
      start("w", "w1", "Read", "a.ts"), end("w", "w1"), start("w", "w2", "Edit", "a.ts"), end("w", "w2"), start("w", "w3", "Bash", "npm test"),
      start(null, "m1", "mcp__claude_ai_Linear__create_issue"),
      { kind: "advisor_started", parent: null, id: "adv" },
    ]);
    const g = agentGraph(s.items, opts);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(g.nodes.map((n) => `${n.kind}:${n.label}${n.kind === "leaf" ? n.sub : ""}`)).toEqual(["main:main", "advisor:advisor", "agent:general-purpose", "leaf:files×2", "leaf:shell×1", "leaf:Linear×1"]);
    expect(byId.get("agent:w")!.parent).toBe("main");
    expect(byId.get("agent:w/files")!.parent).toBe("agent:w");
    expect(byId.get("main/mcp:Linear")!.parent).toBe("main");
    // Running: the subagent, its shell leaf, Linear, and the advisor.
    expect(g.edges.filter((e) => e.active).map((e) => e.id).sort()).toEqual(["agent:w->agent:w/shell", "main->advisor", "main->agent:w", "main->main/mcp:Linear"]);
    // A subagent's call travels its leaf's edge and its own edge from main.
    expect(g.stepEdge.w3).toEqual({ edge: "agent:w->agent:w/shell", via: "main->agent:w", status: "running" });
    expect(g.stepEdge.adv.edge).toBe("main->advisor");
  });

  it("lays out a tidy tree: children under their parent, the advisor level with main and to its left, all in view", () => {
    const s = run([...agent("a", "Explore", "claude-haiku-5-5"), start("a", "a1", "Grep"), ...agent("b", "Explore", "claude-haiku-5-5"), start("b", "b1", "Read"), { kind: "advisor_started", parent: null, id: "adv" }]);
    const g = agentGraph(s.items, opts);
    const n = new Map(g.nodes.map((x) => [x.id, x]));
    const main = n.get("main")!;
    expect(n.get("advisor")!.y).toBe(main.y);
    expect(n.get("advisor")!.x).toBeLessThan(main.x);
    expect(n.get("agent:a")!.y).toBeGreaterThan(main.y);
    expect(n.get("agent:a")!.x).toBeLessThan(n.get("agent:b")!.x);
    expect(n.get("agent:a/search")!.x).toBe(n.get("agent:a")!.x);
    for (const x of g.nodes) {
      expect(x.x).toBeGreaterThan(0);
      expect(x.x).toBeLessThan(g.width);
      expect(x.y).toBeLessThan(g.height);
    }
  });

  it("keeps the earlier agents where they were as new ones arrive to the right", () => {
    const first = run([...agent("a", "Explore", "claude-haiku-5-5"), ...agent("b", "Explore", "claude-haiku-5-5")]);
    const later = run([...agent("a", "Explore", "claude-haiku-5-5"), ...agent("b", "Explore", "claude-haiku-5-5"), ...agent("c", "Explore", "claude-haiku-5-5")]);
    const order = (items: State["items"]) => agentGraph(items, opts).nodes.filter((x) => x.kind === "agent").map((x) => x.x);
    const [a1, b1] = order(first.items);
    const [a2, b2, c2] = order(later.items);
    expect(b2 - a2).toBe(b1 - a1);
    expect(c2).toBeGreaterThan(b2);
  });

  it("folds subagents' tools away when there are many, still routing their calls along their edges", () => {
    const events = Array.from({ length: MAX_UNFOLDED + 1 }, (_, i) => [...agent(`s${i}`, "Explore", "claude-haiku-5-5"), start(`s${i}`, `s${i}x`, "Read")]).flat();
    const g = agentGraph(run(events).items, opts);
    expect(g.nodes.filter((x) => x.kind === "leaf")).toHaveLength(0);
    expect(g.stepEdge.s0x.edge).toBe("main->agent:s0");
  });

  it("shows a failed call on its leaf, and says what the leaf's last calls were", () => {
    const g = agentGraph(run([start(null, "b1", "Bash", "npm test"), end(null, "b1", true)]).items, { ...opts, live: false, advisor: null });
    const leaf = g.nodes.find((x) => x.kind === "leaf")!;
    expect(leaf.status).toBe("error");
    expect(leaf.detail).toEqual(["Bash npm test (failed)"]);
    expect(g.nodes.some((x) => x.kind === "advisor")).toBe(false);
  });
});

describe("agentGraph and workflows", () => {
  it("puts a workflow between main and its agents, named with its phase", () => {
    const s = run([
      start(null, "wf", "Workflow", "settings-redesign"),
      start("wf", "wfa-1", "Agent", "propose:reduce"),
      { kind: "agent_started", tool_use_id: "wfa-1", subagent_type: "Propose", description: "propose:reduce", model: null },
      { kind: "agent_model", parent: "wfa-1", model: "claude-haiku-5-5" },
      start("wfa-1", "r", "Read", "a.swift"),
    ]);
    const g = agentGraph(s.items, opts);
    const n = new Map(g.nodes.map((x) => [x.id, x]));
    expect(n.get("wf:wf")).toMatchObject({ kind: "workflow", label: "settings-redesign", sub: "Propose", parent: "main" });
    expect(n.get("agent:wfa-1")).toMatchObject({ label: "propose:reduce", sub: "Haiku 5.5", parent: "wf:wf" });
    expect(n.get("agent:wfa-1/files")!.parent).toBe("agent:wfa-1");
    expect(n.get("agent:wfa-1")!.y).toBeGreaterThan(n.get("wf:wf")!.y);
    // An agent's start travels from the workflow, and on the way from main.
    expect(g.stepEdge["wfa-1"]).toMatchObject({ edge: "wf:wf->agent:wfa-1", via: "main->wf:wf" });
    // The Workflow call isn't a tool leaf of main.
    expect(g.nodes.some((x) => x.id.startsWith("main/"))).toBe(false);
  });
});

describe("zooming into a branch", () => {
  const s = run([
    start(null, "wf", "Workflow", "settings-redesign"),
    start("wf", "wfa-1", "Agent", "propose:reduce"),
    { kind: "agent_started", tool_use_id: "wfa-1", subagent_type: "Propose", description: "propose:reduce", model: null },
    start("wfa-1", "r", "Read", "a.swift"),
    start("wf", "wfa-2", "Agent", "judge"),
    { kind: "agent_started", tool_use_id: "wfa-2", subagent_type: "Judge", description: "judge", model: null },
  ]);
  const g = agentGraph(s.items, opts);

  it("takes a node, its children and theirs, and zooms to a leaf's agent", () => {
    expect([...branchOf(g, "wf:wf")].sort()).toEqual(["agent:wfa-1", "agent:wfa-1/files", "agent:wfa-2", "wf:wf"]);
    expect(zoomTarget(g, "agent:wfa-1/files")).toBe("agent:wfa-1");
    expect(zoomTarget(g, "agent:wfa-2")).toBe("agent:wfa-2");
  });

  it("frames the branch closer than the whole graph, never smaller than readable", () => {
    const whole = wholeView(g);
    const agent = branchView(g, "agent:wfa-1");
    expect(agent.w).toBeLessThan(whole.w);
    expect(agent.w).toBeGreaterThanOrEqual(MIN_VIEW.w);
    const n = g.nodes.find((x) => x.id === "agent:wfa-1")!;
    expect(n.x).toBeGreaterThan(agent.x);
    expect(n.x).toBeLessThan(agent.x + agent.w);
  });

  it("gives the trail from main down to the node", () => {
    expect(trailTo(g, "agent:wfa-1").map((x) => x.label)).toEqual(["main", "settings-redesign", "propose:reduce"]);
  });
});

