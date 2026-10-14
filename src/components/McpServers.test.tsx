import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { McpServer, McpServerSpec } from "../types";

const claudeRequest = vi.fn();
const mcpForm = vi.fn();
const mcpEdit = vi.fn();
const mcpRemove = vi.fn();
vi.mock("../api", () => ({
  api: {
    claudeRequest: (...a: unknown[]) => claudeRequest(...a),
    mcpForm: (...a: unknown[]) => mcpForm(...a),
    mcpEdit: (...a: unknown[]) => mcpEdit(...a),
    mcpRemove: (...a: unknown[]) => mcpRemove(...a),
    skillIndex: () => Promise.resolve([]),
  },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), revealItemInDir: vi.fn() }));

import { SettingsView } from "./SettingsView";

const SERVERS: McpServer[] = [
  { name: "sentry", status: "connected", config: { type: "http", url: "https://mcp.sentry.dev/mcp", headers: { Authorization: "Bearer secret" } }, scope: "user" },
  { name: "postgres", status: "connected", config: { type: "stdio", command: "npx", args: ["pg"] }, scope: "project" },
];

const props = { onClose: () => {}, slot: "s1", live: true, mcpTools: [], commands: [] };

/** Opens a server's row, so its actions show. */
async function openRow(name: string) {
  const list = await screen.findByRole("list", { name: "MCP servers" });
  await within(list).findByText(name);
  fireEvent.click(within(list).getByText(name));
  return list;
}

describe("removing an MCP server", () => {
  beforeEach(() => {
    for (const f of [claudeRequest, mcpForm, mcpEdit, mcpRemove]) f.mockReset();
    claudeRequest.mockImplementation((_s: string, r: { subtype: string }) => Promise.resolve(r.subtype === "mcp_status" ? { mcpServers: SERVERS.map((s) => ({ ...s })) } : {}));
    mcpRemove.mockResolvedValue("Removed");
  });

  it("asks first, naming where the server is kept", async () => {
    render(<SettingsView open="mcp" {...props} />);
    await openRow("sentry");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = screen.getByRole("alertdialog", { name: "Remove sentry" });
    expect(dialog).toHaveTextContent("your settings, for every project");
    expect(dialog).not.toHaveTextContent(".mcp.json");
    expect(mcpRemove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog", { name: "Remove sentry" })).toBeNull();
    expect(mcpRemove).not.toHaveBeenCalled();
  });

  it("says a project server is removed from the committed .mcp.json", async () => {
    render(<SettingsView open="mcp" {...props} />);
    await openRow("postgres");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = screen.getByRole("alertdialog", { name: "Remove postgres" });
    expect(dialog).toHaveTextContent("this project's .mcp.json");
    expect(dialog).toHaveTextContent("committed");
  });

  it("removes it, from the scope it was shown in, once confirmed", async () => {
    render(<SettingsView open="mcp" {...props} />);
    await openRow("sentry");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Remove sentry" })).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mcpRemove).toHaveBeenCalledWith("s1", "sentry", "user"));
  });
});

describe("editing an MCP server", () => {
  const SENTRY: McpServerSpec = { name: "sentry", transport: "http", target: "https://mcp.sentry.dev/mcp", scope: "user", env: [], headers: ["Authorization: •••"] };

  beforeEach(() => {
    for (const f of [claudeRequest, mcpForm, mcpEdit, mcpRemove]) f.mockReset();
    claudeRequest.mockImplementation((_s: string, r: { subtype: string }) => Promise.resolve(r.subtype === "mcp_status" ? { mcpServers: SERVERS.map((s) => ({ ...s })) } : {}));
    mcpForm.mockResolvedValue(SENTRY);
    mcpEdit.mockResolvedValue("Saved sentry.");
  });

  async function openEditor(name: string) {
    render(<SettingsView open="mcp" {...props} />);
    await openRow(name);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    return screen.findByRole("form", { name: "Edit an MCP server" });
  }

  it("opens with the stored settings, the secret values masked", async () => {
    const form = await openEditor("sentry");
    expect(mcpForm).toHaveBeenCalledWith("s1", "sentry", "user");
    await waitFor(() => expect(within(form).getByLabelText("Name")).toHaveValue("sentry"));
    expect(within(form).getByLabelText("Address")).toHaveValue("https://mcp.sentry.dev/mcp");
    expect(within(form).getByLabelText(/Headers/)).toHaveValue("Authorization: •••");
  });

  it("saves the edit with the mask in place, so the secret is kept in the backend", async () => {
    const form = await openEditor("sentry");
    await waitFor(() => expect(within(form).getByLabelText("Name")).toHaveValue("sentry"));
    fireEvent.change(within(form).getByLabelText("Address"), { target: { value: "https://mcp.sentry.dev/v2" } });
    fireEvent.submit(form);
    await waitFor(() => expect(mcpEdit).toHaveBeenCalledWith("s1", { name: "sentry", scope: "user" }, { ...SENTRY, target: "https://mcp.sentry.dev/v2", headers: ["Authorization: •••"] }));
    expect(await screen.findByText(/Restart the chat to use the change/)).toBeInTheDocument();
  });

  it("asks before moving a server into the project's .mcp.json, and only then saves", async () => {
    const form = await openEditor("sentry");
    await waitFor(() => expect(within(form).getByLabelText("Name")).toHaveValue("sentry"));
    fireEvent.click(within(form).getByLabelText(/Everyone on this project/));
    fireEvent.submit(form);
    const confirm = await within(form).findByRole("alertdialog", { name: "Save to the project" });
    expect(confirm).toHaveTextContent("committed");
    expect(mcpEdit).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Save to .mcp.json" }));
    await waitFor(() => expect(mcpEdit).toHaveBeenCalledWith("s1", { name: "sentry", scope: "user" }, expect.objectContaining({ scope: "project" })));
  });

  it("keeps the form open with the reason when the edit is refused", async () => {
    mcpEdit.mockRejectedValue("The project's .mcp.json is committed, so a secret can't go in it.");
    const form = await openEditor("sentry");
    await waitFor(() => expect(within(form).getByLabelText("Name")).toHaveValue("sentry"));
    fireEvent.submit(form);
    expect(await within(form).findByRole("alert")).toHaveTextContent("a secret can't go in it");
    expect(screen.getByRole("form", { name: "Edit an MCP server" })).toBeInTheDocument();
  });
});
