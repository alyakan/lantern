import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { AgentsTab } from "./AgentsTab";
import type { AgentTree } from "../lib/agents";

const tree: AgentTree = {
  prompt: "fix the auth tests",
  live: true,
  main: { model: "claude-sonnet-5-5", effort: "high", now: "Waiting for 1 subagent", steps: 3 },
  advisor: { model: "opus", calls: [{ id: "a1", status: "reviewed", detail: null, moment: "before starting" }, { id: "a2", status: "advising", detail: null, moment: "after a failed step" }] },
  subagents: [{ id: "w", type: "general-purpose", description: "Fix fixtures", model: "claude-sonnet-5-5", status: "running", now: "Running npm test", steps: 2, tokens: 14200, ms: 2600 }],
  log: [{ id: "a1", at: Date.UTC(2026, 9, 8, 12, 0, 0), agent: "advisor", model: "opus", text: "reviewed · before starting", status: "done" }],
  back: false,
};

describe("AgentsTab", () => {
  it("draws the advisor, the main session and each subagent with its model", () => {
    render(<AgentsTab tree={tree} usage={[]} />);
    expect(screen.getByText("Live")).toBeInTheDocument();
    const advisor = screen.getByRole("complementary", { name: "Advisor" });
    expect(within(advisor).getByText("Opus")).toBeInTheDocument();
    expect(within(advisor).getByText("Advising…")).toBeInTheDocument();
    expect(within(advisor).getByText("after a failed step")).toBeInTheDocument();
    expect(screen.getByLabelText("Main session")).toHaveTextContent("Sonnet 5.5");
    const worker = screen.getByLabelText("general-purpose: Fix fixtures");
    expect(worker).toHaveTextContent("Running npm test");
    expect(worker).toHaveTextContent("14k tokens");
    expect(screen.getByText("Waiting for the subagents")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Session log" })).getByText("reviewed · before starting")).toBeInTheDocument();
  });

  it("shows the cost per model once the turn is done, and says what to do before any", () => {
    const { rerender } = render(<AgentsTab tree={{ ...tree, live: false }} usage={[{ model: "claude-opus-5-5", cost_usd: 0.38, input_tokens: 1, output_tokens: 2400 }]} />);
    expect(screen.getByLabelText("Cost by model")).toHaveTextContent("Opus 5.5 $0.38 · 2.4k out");
    rerender(<AgentsTab tree={{ ...tree, prompt: null }} usage={[]} />);
    expect(screen.getByText(/Send a task to see which agent and model does what/)).toBeInTheDocument();
  });
});
