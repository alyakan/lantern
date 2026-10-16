import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TemplateTeamContext } from "../lib/roleStore";
import { PermissionsMenu, WorkflowMenu } from "./ModeMenu";
import { PermissionCard } from "./PermissionCard";

describe("PermissionsMenu", () => {
  it("offers Ask and Auto, and switches", () => {
    const onChange = vi.fn();
    render(<PermissionsMenu permissions="ask" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Permissions: Ask/ }));
    expect(screen.getAllByRole("menuitemradio").map((r) => r.querySelector(".menu-row-title")?.textContent)).toEqual(["Ask", "Auto"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Auto/ }));
    expect(onChange).toHaveBeenCalledWith("auto");
  });

  it("does not call back for the setting the chat is already on", () => {
    const onChange = vi.fn();
    render(<PermissionsMenu permissions="auto" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Permissions: Auto/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Auto/ }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("WorkflowMenu", () => {
  it("offers Chat, Step by step and Team, and switches", () => {
    const onChange = vi.fn();
    render(<WorkflowMenu workflow="chat" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Workflow: Chat/ }));
    expect(screen.getAllByRole("menuitemradio").map((r) => r.querySelector(".menu-row-title")?.textContent)).toEqual(["Chat", "Step by step", "Team"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Team/ }));
    expect(onChange).toHaveBeenCalledWith("team");
  });

  it("says nothing about teaching, and never the old mode names", () => {
    render(<WorkflowMenu workflow="chat" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Workflow/ }));
    const text = screen.getByRole("menu").textContent ?? "";
    expect(text).not.toMatch(/teach|Auto-approve|Ask before actions/);
    expect(text).toMatch(/build, review, debug or design/);
  });

  it("names Step by step's flavour on its chip", () => {
    render(<WorkflowMenu workflow="steps" flavour="review" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Workflow: Step by step · Review" })).toBeInTheDocument();
  });

  it("keeps a team's Lead in Team while it has agents, and offers an agent no Team at all", () => {
    const { rerender } = render(<WorkflowMenu workflow="team" holdsAgents onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Workflow: Team/ }));
    expect(screen.getByRole("menuitemradio", { name: /^Chat/ })).toBeDisabled();
    expect(screen.getByRole("menuitemradio", { name: /^Step by step/ })).toBeDisabled();
    expect(screen.getByRole("menuitemradio", { name: /^Team/ })).toBeEnabled();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    rerender(<WorkflowMenu workflow="chat" agent onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Workflow: Chat/ }));
    expect(screen.getAllByRole("menuitemradio").map((r) => r.querySelector(".menu-row-title")?.textContent)).toEqual(["Chat", "Step by step"]);
  });

  it("moves between the rows with the arrow keys, and gives focus back to its chip when it closes", () => {
    render(<WorkflowMenu workflow="chat" onChange={() => {}} />);
    const chip = screen.getByRole("button", { name: /Workflow: Chat/ });
    fireEvent.click(chip);
    const [chat, steps, team] = screen.getAllByRole("menuitemradio");
    expect(chat).toHaveFocus();
    fireEvent.keyDown(chat, { key: "ArrowDown" });
    expect(steps).toHaveFocus();
    fireEvent.keyDown(steps, { key: "End" });
    expect(team).toHaveFocus();
    fireEvent.keyDown(team, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(chip).toHaveFocus();
  });

  it("a title bar's chips are compact, with their menus below", () => {
    render(<WorkflowMenu workflow="chat" compact onChange={() => {}} />);
    const chip = screen.getByRole("button", { name: /Workflow: Chat/ });
    expect(chip).toHaveClass("node-chip");
    fireEvent.click(chip);
    expect(screen.getByRole("menu")).toHaveClass("below");
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

describe("WorkflowMenu: Team from a template", () => {
  const open = (ui: React.ReactElement, run: (() => void) | null) => {
    render(<TemplateTeamContext.Provider value={run}>{ui}</TemplateTeamContext.Provider>);
    fireEvent.click(screen.getByRole("button", { name: /^Workflow/ }));
  };

  it("is a row under the workflows that starts a team from a template, and closes the menu", () => {
    const run = vi.fn();
    open(<WorkflowMenu workflow="chat" onChange={() => {}} />, run);
    fireEvent.click(screen.getByRole("menuitem", { name: /Team from a template…/ }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("isn't offered without somewhere to start one, on an agent, on a title bar, or on a team that has agents", () => {
    for (const ui of [<WorkflowMenu workflow="chat" onChange={() => {}} />, <WorkflowMenu workflow="chat" agent onChange={() => {}} />, <WorkflowMenu workflow="chat" compact onChange={() => {}} />, <WorkflowMenu workflow="team" holdsAgents onChange={() => {}} />]) {
      cleanup();
      open(ui, ui.props.agent || ui.props.compact || ui.props.holdsAgents ? vi.fn() : null);
      expect(screen.queryByRole("menuitem", { name: /Team from a template/ })).toBeNull();
    }
  });
});
