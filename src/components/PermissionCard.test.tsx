import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
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

  it("offers Always allow… for this chat or this folder, and saves the rule with the answer", () => {
    const onDecide = vi.fn();
    render(<PermissionCard item={item} onDecide={onDecide} />);
    expect(screen.queryByText("This chat")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Always allow…" }));
    expect(screen.getByText("This chat")).toBeInTheDocument();
    expect(screen.getByText("This folder")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "This folder" })).getByRole("button", { name: "Bash: npm test …" }));
    expect(onDecide).toHaveBeenCalledWith("perm-1", true, undefined, undefined, { scope: "folder", tool: "Bash", kind: "prefix", text: "npm test" });
  });

  it("offers the exact command in the chat", () => {
    const onDecide = vi.fn();
    render(<PermissionCard item={item} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Always allow…" }));
    fireEvent.click(within(screen.getByRole("group", { name: "This chat" })).getByRole("button", { name: "Bash: npm test" }));
    expect(onDecide).toHaveBeenCalledWith("perm-1", true, undefined, undefined, { scope: "chat", tool: "Bash", kind: "exact", text: "npm test" });
  });

  it("has no Always allow… for a command with shell operators, and none for a program that runs anything", () => {
    const { unmount } = render(<PermissionCard item={{ ...item, input: { command: "npm test; rm -rf ~" } }} onDecide={() => {}} />);
    expect(screen.queryByRole("button", { name: "Always allow…" })).toBeNull();
    unmount();
    render(<PermissionCard item={{ ...item, input: { command: "python x.py" } }} onDecide={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Always allow…" }));
    // Offered in both scopes, as the exact command only.
    expect(screen.getAllByRole("button", { name: "Bash: python x.py" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Bash: python …" })).toBeNull();
  });

  it("offers no Always allow… for a file in git or config folders: that one asks each time", () => {
    render(<PermissionCard item={{ ...item, toolName: "Write", input: { file_path: "/p/.git/config", content: "x" } }} onDecide={() => {}} />);
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Always allow…" })).toBeNull();
  });

  it("says which rule answered a request, with no buttons to answer it", () => {
    const { container } = render(
      <PermissionCard item={{ ...item, decision: "allowed", autoRule: { scope: "folder", rule: { tool: "Bash", kind: "prefix", text: "npm test" } } }} onDecide={() => {}} />,
    );
    expect(container.textContent).toContain("Allowed by your rule: Bash: npm test …");
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });
});
