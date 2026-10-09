import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentGraph } from "./AgentGraph";
import { initialState, reducer, type State } from "../store";
import type { UiEvent } from "../types";
import { agentGraph } from "../lib/agentGraph";

const opts = { live: true, folder: "/p", mainModel: "claude-sonnet-5-5", effort: "high", advisor: null };
const step = (s: State, event: UiEvent) => reducer(s, { type: "ui_event", event });
const base = () => {
  let s: State = reducer({ ...initialState, status: "idle" }, { type: "user_sent", text: "go" });
  s = step(s, { kind: "tool_started", parent: null, tool_use_id: "e", name: "Agent", summary: "Map auth" });
  s = step(s, { kind: "agent_started", tool_use_id: "e", subagent_type: "Explore", description: "Map auth", model: null });
  return step(s, { kind: "agent_model", parent: "e", model: "claude-haiku-5-5" });
};

describe("AgentGraph", () => {
  it("draws a node per agent and tool kind, and tells what one is doing on hover", () => {
    let s = base();
    s = step(s, { kind: "tool_started", parent: "e", tool_use_id: "g", name: "Grep", summary: "verifyToken" });
    render(<AgentGraph graph={agentGraph(s.items, opts)} />);
    expect(screen.getByRole("button", { name: "main Sonnet 5.5: running" })).toBeInTheDocument();
    const explore = screen.getByRole("button", { name: "Explore Haiku 5.5: running" });
    expect(screen.getByRole("button", { name: "search ×1: running" })).toBeInTheDocument();
    expect(screen.getByText(/Hover a node to see what it.s doing/)).toBeInTheDocument();
    fireEvent.mouseEnter(explore);
    expect(screen.getByText("Map auth")).toBeInTheDocument();
  });

  it("sends a pulse along an edge when a step starts, and back up when it ends, but not for what was already there", () => {
    let s = base();
    const { container, rerender } = render(<AgentGraph graph={agentGraph(s.items, opts)} />);
    expect(container.querySelectorAll(".graph-pulse")).toHaveLength(0);
    s = step(s, { kind: "tool_started", parent: "e", tool_use_id: "g", name: "Grep", summary: "x" });
    rerender(<AgentGraph graph={agentGraph(s.items, opts)} />);
    // Down to the leaf, and along the subagent's edge from main.
    expect(container.querySelectorAll(".graph-pulse")).toHaveLength(2);
    s = step(s, { kind: "tool_finished", parent: "e", tool_use_id: "g", is_error: true, output: "" });
    rerender(<AgentGraph graph={agentGraph(s.items, opts)} />);
    expect(container.querySelectorAll(".graph-pulse.failed")).toHaveLength(1);
    expect(container.querySelector(".graph-pulse.failed animateMotion")!.getAttribute("keyPoints")).toBe("1;0");
  });

  it("zooms into a clicked node's branch with a trail back, and out again", () => {
    let s = base();
    s = step(s, { kind: "tool_started", parent: "e", tool_use_id: "g", name: "Grep", summary: "x" });
    const { container } = render(<AgentGraph graph={agentGraph(s.items, opts)} />);
    const svg = container.querySelector("svg")!;
    const whole = svg.getAttribute("viewBox");
    fireEvent.click(screen.getByRole("button", { name: "Explore Haiku 5.5: running" }));
    expect(screen.getByRole("navigation", { name: "Zoom" })).toHaveTextContent("Whole graph›main›Explore");
    // Outside the branch: dimmed.
    expect(screen.getByRole("button", { name: "main Sonnet 5.5: running" })).toHaveClass("out");
    fireEvent.click(screen.getByRole("button", { name: "Whole graph" }));
    expect(screen.getByRole("navigation", { name: "Zoom" })).toHaveTextContent(/^Whole graph$/);
    expect(svg.getAttribute("viewBox")).toBe(whole);
  });

  it("moves between nodes with the arrow keys, the panel following", () => {
    let s = base();
    s = step(s, { kind: "tool_started", parent: "e", tool_use_id: "g", name: "Grep", summary: "verifyToken" });
    const { container } = render(<AgentGraph graph={agentGraph(s.items, opts)} />);
    const graph = container.querySelector(".agent-graph")!;
    const selected = () => container.querySelector(".graph-node.selected")?.getAttribute("aria-label");
    // Nothing chosen yet: the first arrow picks the main agent.
    fireEvent.keyDown(graph, { key: "ArrowDown" });
    expect(selected()).toBe("main Sonnet 5.5: running");
    fireEvent.keyDown(graph, { key: "ArrowDown" });
    expect(selected()).toBe("Explore Haiku 5.5: running");
    expect(screen.getByText("Map auth")).toBeInTheDocument();
    fireEvent.keyDown(graph, { key: "ArrowDown" });
    expect(selected()).toBe("search ×1: running");
    fireEvent.keyDown(graph, { key: "ArrowUp" });
    expect(selected()).toBe("Explore Haiku 5.5: running");
  });
});
