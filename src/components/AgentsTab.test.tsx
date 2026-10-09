import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { AgentsTab } from "./AgentsTab";
import type { AgentTree } from "../lib/agents";
import type { AgentGraph } from "../lib/agentGraph";

const graph: AgentGraph = { nodes: [{ id: "main", kind: "main", label: "main", sub: "Sonnet 5.5", tone: "sonnet", status: "running", parent: null, x: 100, y: 40, detail: [] }], edges: [], width: 200, height: 120, stepEdge: {} };

const tree: AgentTree = {
  prompt: "fix the auth tests",
  live: true,
  main: { model: "claude-sonnet-5-5", effort: "high", now: "Waiting for 1 subagent", steps: 3 },
  advisor: { model: "opus", calls: [{ id: "a1", status: "reviewed", detail: null, moment: "before starting" }, { id: "a2", status: "advising", detail: null, moment: "after a failed step" }] },
  subagents: [{ id: "w", workflow: null, type: "general-purpose", description: "Fix fixtures", model: "claude-sonnet-5-5", status: "running", now: "Running npm test", steps: 2, tokens: 14200, ms: 2600 }],
  workflows: [],
  log: [{ id: "a1", at: Date.UTC(2026, 9, 8, 12, 0, 0), agent: "advisor", model: "opus", text: "reviewed · before starting", status: "done" }],
  back: false,
};

describe("AgentsTab", () => {
  it("shows the graph and the session log for the turn", () => {
    render(<AgentsTab tree={tree} graph={graph} usage={[]} />);
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Agent graph" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "main Sonnet 5.5: running" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Session log" })).getByText("reviewed · before starting")).toBeInTheDocument();
  });

  it("shows the cost per model once the turn is done, and says what to do before any", () => {
    const { rerender } = render(<AgentsTab tree={{ ...tree, live: false }} graph={graph} usage={[{ model: "claude-opus-5-5", cost_usd: 0.38, input_tokens: 1, output_tokens: 2400 }]} />);
    expect(screen.getByLabelText("Cost by model")).toHaveTextContent("Opus 5.5 $0.38 · 2.4k out");
    rerender(<AgentsTab tree={{ ...tree, prompt: null }} graph={graph} usage={[]} />);
    expect(screen.getByText(/Send a task to see which agent and model does what/)).toBeInTheDocument();
  });
});
