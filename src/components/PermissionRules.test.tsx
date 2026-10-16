import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api";
import type { RuleEntry } from "../types";
import { PermissionRules } from "./PermissionRules";

vi.mock("../api", () => ({ api: { listPermissionRules: vi.fn(), removePermissionRule: vi.fn(), addPermissionRule: vi.fn() } }));

const listMock = vi.mocked(api.listPermissionRules);
const removeMock = vi.mocked(api.removePermissionRule);
const addMock = vi.mocked(api.addPermissionRule);

const folderRule: RuleEntry = { scope: "folder", folder: "/repo", tool: "Bash", kind: "prefix", text: "npm test" };
const chatRule: RuleEntry = { scope: "chat", folder: null, tool: "Edit", kind: "dir", path: "/repo/src" };

beforeEach(() => {
  listMock.mockReset();
  removeMock.mockReset();
  removeMock.mockResolvedValue(undefined);
  addMock.mockReset();
  addMock.mockResolvedValue(undefined);
});

describe("PermissionRules", () => {
  it("says how rules are made when there are none", async () => {
    listMock.mockResolvedValue([]);
    render(<PermissionRules slot={null} />);
    expect(await screen.findByText(/No rules yet/)).toBeInTheDocument();
    expect(screen.getByText("Open a chat to see its rules.")).toBeInTheDocument();
  });

  it("lists each rule with its scope, tool and what it covers", async () => {
    listMock.mockResolvedValue([folderRule, chatRule]);
    render(<PermissionRules slot="s1" />);
    const list = await screen.findByRole("list", { name: "Allow rules" });
    expect(list.textContent).toContain("This folder");
    expect(list.textContent).toContain("/repo · Bash");
    expect(list.textContent).toContain("npm test …");
    expect(list.textContent).toContain("This chat");
    expect(list.textContent).toContain("/repo/src/");
    expect(listMock).toHaveBeenCalledWith("s1");
  });

  it("lays each rule out as one row: its scope, what it covers, and Remove at the end", async () => {
    listMock.mockResolvedValue([folderRule]);
    render(<PermissionRules slot="s1" />);
    const row = (await screen.findByRole("list", { name: "Allow rules" })).querySelector("li") as HTMLElement;
    expect([...row.children].map((c) => c.tagName)).toEqual(["SPAN", "SPAN", "BUTTON"]);
    expect(row.lastElementChild).toHaveTextContent("Remove");
    expect(row.querySelector(".rule-text")).toHaveAttribute("title", "/repo · Bash · npm test …");
  });

  it("removes a rule and lists the rest", async () => {
    listMock.mockResolvedValueOnce([folderRule, chatRule]).mockResolvedValueOnce([chatRule]);
    render(<PermissionRules slot="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove the rule for Bash, npm test …" }));
    expect(removeMock).toHaveBeenCalledWith("s1", folderRule);
    await waitFor(() => expect(screen.queryByText("npm test …")).toBeNull());
  });

  it("shows why the rules couldn't be read", async () => {
    listMock.mockRejectedValue("the rules file is unreadable");
    render(<PermissionRules slot={null} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("the rules file is unreadable");
  });

  describe("Add a rule", () => {
    const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

    it("makes the rule a card would make, for this folder, and lists the rules again", async () => {
      listMock.mockResolvedValue([]);
      render(<PermissionRules slot="s1" />);
      await screen.findByText(/No rules yet/);
      expect(screen.getByRole("button", { name: "Add rule" })).toBeDisabled();
      type("Command", "npm test");
      expect(screen.getByText("Always allow Bash commands starting with npm test, in this folder.")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
      await waitFor(() => expect(addMock).toHaveBeenCalledWith("s1", { scope: "folder", tool: "Bash", kind: "prefix", text: "npm test" }));
      await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
      expect(await screen.findByText(/Added: Always allow Bash commands starting with npm test/)).toBeInTheDocument();
    });

    it("explains a command's start it can't make, and offers the exact command instead", async () => {
      listMock.mockResolvedValue([]);
      render(<PermissionRules slot="s1" />);
      await screen.findByText(/No rules yet/);
      type("Command", "rm -rf build");
      expect(screen.getByRole("status")).toHaveTextContent("This exact command");
      expect(screen.getByRole("button", { name: "Add rule" })).toBeDisabled();
      expect(addMock).not.toHaveBeenCalled();
    });

    it("makes a rule for a folder's files, for this chat", async () => {
      listMock.mockResolvedValue([]);
      render(<PermissionRules slot="s1" />);
      await screen.findByText(/No rules yet/);
      type("Tool", "Edit");
      type("Folder", "/Users/me/my project/src/");
      type("Applies to", "chat");
      fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
      await waitFor(() => expect(addMock).toHaveBeenCalledWith("s1", { scope: "chat", tool: "Edit", kind: "dir", path: "/Users/me/my project/src" }));
    });

    it("warns about a very broad rule and only adds it after a second click", async () => {
      listMock.mockResolvedValue([]);
      render(<PermissionRules slot="s1" />);
      await screen.findByText(/No rules yet/);
      type("Tool", "WebFetch");
      expect(screen.getByRole("alert")).toHaveTextContent("every WebFetch call without asking");
      fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
      expect(addMock).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(addMock).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
      fireEvent.click(screen.getByRole("button", { name: "Yes, allow it without asking" }));
      await waitFor(() => expect(addMock).toHaveBeenCalledWith("s1", { scope: "folder", tool: "WebFetch", kind: "any" }));
    });

    it("warns about an exact command that can delete files", async () => {
      listMock.mockResolvedValue([]);
      render(<PermissionRules slot="s1" />);
      await screen.findByText(/No rules yet/);
      type("Covers", "exact");
      type("Command", "rm -rf build");
      expect(screen.getByRole("alert")).toHaveTextContent("change or delete files");
    });

    it("takes a tool typed by name", async () => {
      listMock.mockResolvedValue([]);
      render(<PermissionRules slot="s1" />);
      await screen.findByText(/No rules yet/);
      type("Tool", "other");
      type("Tool name", "mcp__linear__save_issue");
      fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
      fireEvent.click(screen.getByRole("button", { name: "Yes, allow it without asking" }));
      await waitFor(() => expect(addMock).toHaveBeenCalledWith("s1", { scope: "folder", tool: "mcp__linear__save_issue", kind: "any" }));
    });

    it("shows what the app said when it refuses a rule", async () => {
      listMock.mockResolvedValue([]);
      addMock.mockRejectedValue("A rule for Bash can't match that way.");
      render(<PermissionRules slot="s1" />);
      await screen.findByText(/No rules yet/);
      type("Command", "npm test");
      fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
      expect(await screen.findByText("A rule for Bash can't match that way.")).toBeInTheDocument();
    });

    it("needs a chat open", async () => {
      listMock.mockResolvedValue([]);
      render(<PermissionRules slot={null} />);
      await screen.findByText(/No rules yet/);
      expect(screen.getByRole("button", { name: "Add rule" })).toBeDisabled();
      expect(screen.getByText("Open a chat to add a rule.")).toBeInTheDocument();
    });
  });
});
