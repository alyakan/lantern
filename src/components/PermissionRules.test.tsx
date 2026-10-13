import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api";
import type { RuleEntry } from "../types";
import { PermissionRules } from "./PermissionRules";

vi.mock("../api", () => ({ api: { listPermissionRules: vi.fn(), removePermissionRule: vi.fn() } }));

const listMock = vi.mocked(api.listPermissionRules);
const removeMock = vi.mocked(api.removePermissionRule);

const folderRule: RuleEntry = { scope: "folder", folder: "/repo", tool: "Bash", kind: "prefix", text: "npm test" };
const chatRule: RuleEntry = { scope: "chat", folder: null, tool: "Edit", kind: "dir", path: "/repo/src" };

beforeEach(() => {
  listMock.mockReset();
  removeMock.mockReset();
  removeMock.mockResolvedValue(undefined);
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
    const list = await screen.findByRole("list", { name: "Permission rules" });
    expect(list.textContent).toContain("This folder");
    expect(list.textContent).toContain("/repo · Bash");
    expect(list.textContent).toContain("npm test …");
    expect(list.textContent).toContain("This chat");
    expect(list.textContent).toContain("/repo/src/");
    expect(listMock).toHaveBeenCalledWith("s1");
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
});
