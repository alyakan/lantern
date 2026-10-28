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

  describe("a chat on another agent (Codex)", () => {
    const codex = { ...item, provider: "codex", input: { provider: "codex", command: "/bin/zsh -lc \"npm test\"", cwd: "/p/web", network: "registry.npmjs.org (https)", description: "needs the network", warnings: ["Has characters that can pass for another one: а (U+0430)."] } };

    it("shows the command, where it runs, the network host and its reason as Codex's word, and the warnings", () => {
      const onDecide = vi.fn();
      const { container } = render(<PermissionCard item={codex} onDecide={onDecide} />);
      expect(container.querySelector("pre")?.textContent).toBe('/bin/zsh -lc "npm test"');
      expect(container.textContent).toContain("Runs in/p/web");
      expect(container.textContent).toContain("Networkregistry.npmjs.org (https)");
      expect(container.textContent).toContain("Codex says, and Lantern doesn't check: needs the network");
      expect(container.textContent).toContain("⚠ Has characters that can pass for another one: а (U+0430).");
      fireEvent.click(screen.getByRole("button", { name: "Allow" }));
      expect(onDecide).toHaveBeenCalledWith("perm-1", true);
    });

    it("never offers Always allow…: a rule would be Claude's", () => {
      render(<PermissionCard item={codex} onDecide={() => {}} />);
      expect(screen.queryByRole("button", { name: "Always allow…" })).toBeNull();
      render(<PermissionCard item={{ ...codex, id: "p2", toolName: "Permissions", input: { permissions: "Use the network", cwd: "/p" } }} onDecide={() => {}} />);
      expect(screen.queryByRole("button", { name: "Always allow…" })).toBeNull();
    });

    it("is chosen by the chat's provider: a Claude request claiming to be Codex's is a plain card with no invented folder", () => {
      const { container } = render(<PermissionCard item={{ ...item, input: { command: "npm test", provider: "codex", cwd: "/safe", description: "harmless" } }} onDecide={() => {}} />);
      expect(container.textContent).not.toContain("Runs in");
      expect(container.textContent).not.toContain("harmless");
    });

    it("shows a long command cut, says so, and can't be allowed until all of it is shown", () => {
      const command = `${Array.from({ length: 40 }, (_, i) => `echo ${i}`).join("\n")}\nrm -rf ~`;
      const onDecide = vi.fn();
      const { container } = render(<PermissionCard item={{ ...codex, input: { command } }} onDecide={onDecide} />);
      expect(container.querySelector("pre")?.textContent).not.toContain("rm -rf ~");
      expect(container.textContent).toContain("Shown cut: 41 lines");
      const allow = screen.getByRole("button", { name: "Allow" });
      expect(allow).toBeDisabled();
      fireEvent.click(allow);
      expect(onDecide).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Show all" }));
      expect(container.querySelector("pre")?.textContent).toBe(command);
      expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
    });

    it("cuts a very long single line too, and keeps a short one whole", () => {
      const { container, unmount } = render(<PermissionCard item={{ ...codex, input: { command: `echo hi${" ".repeat(3000)}; rm -rf ~` } }} onDecide={() => {}} />);
      expect(container.textContent).toContain("Shown cut");
      unmount();
      render(<PermissionCard item={{ ...codex, input: { command: "echo hi" } }} onDecide={() => {}} />);
      expect(screen.queryByText(/Shown cut/)).toBeNull();
      expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
    });

    it("lists every file of a change, one to a line", () => {
      const files = Array.from({ length: 30 }, (_, i) => `Create /p/f${i}.txt`).join("\n");
      const { container } = render(<PermissionCard item={{ ...codex, toolName: "Write", input: { file_path: files } }} onDecide={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Show all" }));
      expect(container.querySelector("pre")?.textContent).toBe(files);
    });

    it("can't be allowed when it says nothing of what it would do", () => {
      render(<PermissionCard item={{ ...codex, input: { provider: "codex" } }} onDecide={() => {}} />);
      expect(screen.getByText("Codex didn't say what this would do. Deny it.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
    });

    it("says what a network or stdin request is, which has no command of its own", () => {
      render(<PermissionCard item={{ ...codex, input: { action: "Network access", network: "evil.example (https)", cwd: "/p" } }} onDecide={() => {}} />);
      expect(screen.getByText("Network access")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
    });

    it("keeps how many lines it had once decided", () => {
      const { container } = render(<PermissionCard item={{ ...codex, decision: "allowed", input: { command: "echo a\nrm -rf ~" } }} onDecide={() => {}} />);
      expect(container.textContent).toContain("✓ Allowed");
      expect(container.textContent).toContain("echo a (+1 more lines)");
    });
  });
});
