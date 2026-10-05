import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PermissionCard } from "./PermissionCard";

const item = { type: "permission" as const, id: "perm-1", toolName: "Bash", input: { command: "npm test" }, decision: null };

describe("PermissionCard", () => {
  it("shows the command and reports Allow", () => {
    const onDecide = vi.fn();
    render(<PermissionCard item={item} onDecide={onDecide} />);
    expect(screen.getByText("npm test")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(onDecide).toHaveBeenCalledWith("perm-1", true);
  });

  it("reports Deny", () => {
    const onDecide = vi.fn();
    render(<PermissionCard item={item} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDecide).toHaveBeenCalledWith("perm-1", false);
  });

  it("shrinks to one line once decided", () => {
    const { container } = render(<PermissionCard item={{ ...item, decision: "denied" }} onDecide={() => {}} />);
    expect(screen.getByText("✕ Denied")).toBeInTheDocument();
    expect(container.textContent).toContain("Bash · npm test");
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("falls back to JSON for unfamiliar input", () => {
    render(<PermissionCard item={{ ...item, toolName: "mcp__x__y", input: { a: 1 } }} onDecide={() => {}} />);
    expect(screen.getByText(/"a": 1/)).toBeInTheDocument();
  });
});
