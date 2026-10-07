import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { McpServer, SkillEntry } from "../types";

const claudeRequest = vi.fn();
const skillIndex = vi.fn();
const readSkill = vi.fn();
const mcpAdd = vi.fn();
const mcpRemove = vi.fn();
vi.mock("../api", () => ({ api: { claudeRequest: (...a: unknown[]) => claudeRequest(...a), skillIndex: (...a: unknown[]) => skillIndex(...a), readSkill: (...a: unknown[]) => readSkill(...a), mcpAdd: (...a: unknown[]) => mcpAdd(...a), mcpRemove: (...a: unknown[]) => mcpRemove(...a) } }));
const openUrl = vi.fn();
const revealItemInDir = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (...a: unknown[]) => openUrl(...a), revealItemInDir: (...a: unknown[]) => revealItemInDir(...a) }));

import { SettingsView } from "./SettingsView";

const SERVERS: McpServer[] = [
  { name: "claude.ai Linear", status: "connected", serverInfo: { title: "Linear" }, config: { type: "claudeai-proxy" }, scope: "claudeai", source: "claudeai" },
  { name: "sentry", status: "needs-auth", config: { type: "http", url: "https://mcp.sentry.dev/mcp", headers: { Authorization: "Bearer secret" } }, scope: "user" },
  { name: "postgres", status: "failed", error: "ECONNREFUSED", config: { type: "stdio", command: "npx", args: ["pg"] }, scope: "local" },
];
const SKILLS: SkillEntry[] = [
  { name: "grill-me", kind: "skill", source: "user", plugin: null, path: "/h/.claude/skills/grill-me/SKILL.md", description: "Interview the user" },
  { name: "superpowers:brainstorming", kind: "skill", source: "plugin", plugin: "superpowers", path: "/h/p/SKILL.md", description: "Explore first" },
];

const props = { onClose: () => {}, slot: "s1", live: true, mcpTools: ["mcp__claude_ai_Linear__create_issue"], commands: [{ name: "grill-me", description: "", argument_hint: "" }] };

describe("SettingsView", () => {
  beforeEach(() => {
    for (const f of [claudeRequest, skillIndex, readSkill, mcpAdd, mcpRemove, openUrl, revealItemInDir]) f.mockReset();
    claudeRequest.mockImplementation((_slot: string, r: { subtype: string }) => Promise.resolve(r.subtype === "mcp_status" ? { mcpServers: SERVERS.map((s) => ({ ...s })) } : r.subtype === "mcp_authenticate" ? { authUrl: "https://auth.example/x" } : {}));
    skillIndex.mockResolvedValue(SKILLS);
    readSkill.mockResolvedValue("---\nname: grill-me\n---\n# Grill me\n\nAsk one question at a time.");
  });

  it("lists MCP servers with their status and source", async () => {
    render(<SettingsView open="mcp" {...props} />);
    const list = await screen.findByRole("list", { name: "MCP servers" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector(".settings-row-name")?.textContent)).toEqual(["sentry", "postgres", "Linear"]);
    expect(within(rows[0]).getByText("Needs you to log in")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Failed")).toBeInTheDocument();
    expect(within(rows[2]).getByText("claude.ai connector")).toBeInTheDocument();
  });

  it("logs in through the browser, reconnects and turns servers off", async () => {
    render(<SettingsView open="mcp" {...props} />);
    const list = await screen.findByRole("list", { name: "MCP servers" });
    fireEvent.click(within(list).getByRole("button", { name: "Log in" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://auth.example/x"));
    expect(claudeRequest).toHaveBeenCalledWith("s1", { subtype: "mcp_authenticate", serverName: "sentry" });
    const postgres = within(list).getAllByRole("listitem")[1];
    fireEvent.click(within(postgres).getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(claudeRequest).toHaveBeenCalledWith("s1", { subtype: "mcp_reconnect", serverName: "postgres" }));
    // Its buttons wait while claude answers.
    await waitFor(() => expect(within(postgres).getByRole("button", { name: "Turn off" })).toBeEnabled());
    fireEvent.click(within(postgres).getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(claudeRequest).toHaveBeenCalledWith("s1", { subtype: "mcp_toggle", enabled: false, serverName: "postgres" }));
  });

  it("shows a server's details without its secrets, with its tools", async () => {
    render(<SettingsView open="mcp" {...props} />);
    const list = await screen.findByRole("list", { name: "MCP servers" });
    fireEvent.click(within(list).getByText("sentry"));
    expect(within(list).getByText("Authorization: •••")).toBeInTheDocument();
    expect(list.textContent).not.toContain("Bearer secret");
    fireEvent.click(within(list).getByText("Linear"));
    expect(within(list).getByText("create issue")).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: "Manage on claude.ai" })).toBeInTheDocument();
  });

  it("adds a server with claude mcp add", async () => {
    mcpAdd.mockResolvedValue("Added");
    render(<SettingsView open="mcp" {...props} />);
    await screen.findByRole("list", { name: "MCP servers" });
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    const form = screen.getByRole("form", { name: "Add an MCP server" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "github" } });
    fireEvent.change(within(form).getByLabelText("Address"), { target: { value: "https://api.githubcopilot.com/mcp/" } });
    fireEvent.change(within(form).getByLabelText(/Headers/), { target: { value: "Authorization: Bearer t\n" } });
    fireEvent.click(within(form).getByLabelText(/Just me, every project/));
    fireEvent.submit(form);
    await waitFor(() => expect(mcpAdd).toHaveBeenCalledWith("s1", { name: "github", transport: "http", target: "https://api.githubcopilot.com/mcp/", scope: "user", env: [], headers: ["Authorization: Bearer t"] }));
    expect(await screen.findByText(/Restart the chat to connect to it/)).toBeInTheDocument();
  });

  it("asks for a folder when no chat's claude is running", () => {
    render(<SettingsView open="mcp" {...props} slot={null} live={false} />);
    expect(screen.getByText(/Open a folder to see its MCP servers/)).toBeInTheDocument();
    expect(claudeRequest).not.toHaveBeenCalled();
  });

  it("lists skills by source, previews one and marks what claude didn't load", async () => {
    render(<SettingsView open="skills" {...props} />);
    expect(await screen.findByText("Yours")).toBeInTheDocument();
    expect(screen.getByText("Plugin · superpowers")).toBeInTheDocument();
    expect(screen.getAllByText("not loaded")).toHaveLength(1);
    fireEvent.click(screen.getByText("/grill-me"));
    expect(await screen.findByText("Ask one question at a time.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
    expect(revealItemInDir).toHaveBeenCalledWith("/h/.claude/skills/grill-me/SKILL.md");
    fireEvent.change(screen.getByLabelText("Filter skills and commands"), { target: { value: "explore" } });
    expect(screen.queryByText("Yours")).not.toBeInTheDocument();
  });
});
