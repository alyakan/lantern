import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { PlanPause } from "../lib/planPause";
import { PlanPaused } from "./PlanPaused";

const pause = (slots: string[]): PlanPause => ({ percent: 95, resetsAt: Math.floor(Date.now() / 1000) + 72 * 60 + 30, since: Date.now(), slots });

describe("PlanPaused", () => {
  it("says why the teams stopped, when the plan resets, and that nothing starts until Resume", () => {
    render(<PlanPaused pause={pause(["s1", "w1", "w2"])} onResume={() => {}} />);
    const card = screen.getByRole("status");
    expect(card).toHaveTextContent("Paused: your plan is 95% used, it resets in 1h 12m.");
    expect(card).toHaveTextContent("3 agents were stopped, none ended. These agents stay paused until you press Resume.");
  });

  it("says it in the singular for one agent", () => {
    render(<PlanPaused pause={pause(["w1"])} onResume={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("1 agent was stopped");
  });

  it("has a Dismiss that closes it without resuming, when it is given one", () => {
    const onResume = vi.fn();
    const onDismiss = vi.fn();
    const { rerender } = render(<PlanPaused pause={pause(["w1"])} onResume={onResume} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
    rerender(<PlanPaused pause={pause(["w1"])} onResume={onResume} />);
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("Resume is the one way to start the agents again", () => {
    const onResume = vi.fn();
    render(<PlanPaused pause={pause(["w1"])} onResume={onResume} />);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});
