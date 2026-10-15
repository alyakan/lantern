import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TeamWarning } from "./TeamWarning";

const teams = [{ name: "acme-api", agents: 3 }];

describe("the warning before a second team", () => {
  it("says who is working, and opens on Cancel so Enter can't start anything", () => {
    render(<TeamWarning teams={teams} onStart={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText("Another team is working (acme-api, 3 agents). Every agent spends the same plan. Start anyway?")).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });

  it("starts, remembering the choice only when Don't ask again is ticked", () => {
    const onStart = vi.fn();
    const { unmount } = render(<TeamWarning teams={teams} onStart={onStart} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onStart).toHaveBeenLastCalledWith(false);
    unmount();
    render(<TeamWarning teams={teams} onStart={onStart} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Don't ask again"));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onStart).toHaveBeenLastCalledWith(true);
  });

  it("cancels with the button or Escape", () => {
    const onCancel = vi.fn();
    render(<TeamWarning teams={teams} onStart={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent(screen.getByRole("dialog", { hidden: true }), new Event("cancel", { cancelable: true }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
