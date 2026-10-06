import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ModeMenu } from "./ModeMenu";
import { PermissionCard } from "./PermissionCard";

describe("ModeMenu", () => {
  it("offers ask before actions, auto-approve and step by step, and switches", () => {
    const onChange = vi.fn();
    render(<ModeMenu mode="ask" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Ask before actions/ }));
    expect(screen.getAllByRole("menuitemradio").map((r) => r.querySelector(".menu-row-title")?.textContent)).toEqual(["Ask before actions", "Auto-approve", "Step by step"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Step by step/ }));
    expect(onChange).toHaveBeenCalledWith("steps");
  });
});

describe("plan card", () => {
  const item = (decision: "allowed" | "denied" | null) => ({ type: "permission" as const, id: "p1", toolName: "ExitPlanMode", input: { plan: "## Plan\n\n1. Read `notes.txt`\n2. Append `world`" }, decision });

  it("shows the plan and asks to approve it or keep planning", () => {
    const onDecide = vi.fn();
    render(<PermissionCard item={item(null)} onDecide={onDecide} />);
    expect(screen.getByText("Plan ready")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Plan" })).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    expect(onDecide).toHaveBeenCalledWith("p1", true);
  });

  it("folds to one line once answered, and reopens", () => {
    const { rerender } = render(<PermissionCard item={item("allowed")} onDecide={() => {}} />);
    expect(screen.queryByText("notes.txt")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Plan approved" }));
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    rerender(<PermissionCard item={item("denied")} onDecide={() => {}} />);
    expect(screen.getByRole("button", { name: "Kept planning" })).toBeInTheDocument();
  });
});

describe("reproduce card", () => {
  const item = (decision: "allowed" | "denied" | null, note?: string) => ({
    type: "permission" as const, id: "r1", toolName: "Reproduce", input: { steps: "1. Open **Settings**\n2. Toggle sync" }, decision, note,
  });

  it("shows the steps and sends back whether you reproduced it, with your note", () => {
    const onDecide = vi.fn();
    render(<PermissionCard item={item(null)} onDecide={onDecide} />);
    expect(screen.getByText("Reproduce the bug")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/What did you see/), { target: { value: "  [lantern-debug] token=null  " } });
    fireEvent.click(screen.getByRole("button", { name: "I've reproduced it" }));
    expect(onDecide).toHaveBeenCalledWith("r1", true, "[lantern-debug] token=null");
  });

  it("sends no note when none was typed", () => {
    const onDecide = vi.fn();
    render(<PermissionCard item={item(null)} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Couldn't reproduce" }));
    expect(onDecide).toHaveBeenCalledWith("r1", false, undefined);
  });

  it("folds to one line once answered, keeping the note", () => {
    render(<PermissionCard item={item("allowed", "token=null")} onDecide={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "You reproduced it" }));
    expect(screen.getByText("token=null")).toBeInTheDocument();
  });
});
