import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { McpServer, SkillEntry } from "../types";

const claudeRequest = vi.fn();
const skillIndex = vi.fn();
const readSkill = vi.fn();
const mcpAdd = vi.fn();
const mcpRemove = vi.fn();
const skillCreate = vi.fn();
const skillDelete = vi.fn();
const skillSave = vi.fn();
vi.mock("../api", () => ({
  api: {
    claudeRequest: (...a: unknown[]) => claudeRequest(...a),
    skillIndex: (...a: unknown[]) => skillIndex(...a),
    readSkill: (...a: unknown[]) => readSkill(...a),
    mcpAdd: (...a: unknown[]) => mcpAdd(...a),
    mcpRemove: (...a: unknown[]) => mcpRemove(...a),
    skillCreate: (...a: unknown[]) => skillCreate(...a),
    skillDelete: (...a: unknown[]) => skillDelete(...a),
    skillSave: (...a: unknown[]) => skillSave(...a),
  },
}));
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
  { name: "grill-me", kind: "skill", source: "user", plugin: null, path: "/h/.claude/skills/grill-me/SKILL.md", description: "Interview the user", disabled: false },
  { name: "superpowers:brainstorming", kind: "skill", source: "plugin", plugin: "superpowers", path: "/h/p/SKILL.md", description: "Explore first", disabled: false },
  { name: "figma:scout", kind: "agent", source: "plugin", plugin: "figma", path: "/h/plugins/figma/agents/scout.md", description: "Scouts a file", disabled: true },
  { name: "reviewer", kind: "agent", source: "user", plugin: null, path: "/h/.claude/agents/reviewer.md", description: "Reviews code", disabled: false },
];

const props = { onClose: () => {}, slot: "s1", live: true, mcpTools: ["mcp__claude_ai_Linear__create_issue"], commands: [{ name: "grill-me", description: "", argument_hint: "" }] };

describe("SettingsView", () => {
  beforeEach(() => {
    for (const f of [claudeRequest, skillIndex, readSkill, mcpAdd, mcpRemove, skillCreate, skillDelete, skillSave, openUrl, revealItemInDir]) f.mockReset();
    claudeRequest.mockImplementation((_slot: string, r: { subtype: string }) => Promise.resolve(r.subtype === "mcp_status" ? { mcpServers: SERVERS.map((s) => ({ ...s })) } : r.subtype === "mcp_authenticate" ? { authUrl: "https://auth.example/x" } : {}));
    skillIndex.mockResolvedValue(SKILLS);
    readSkill.mockResolvedValue("---\nname: grill-me\n---\n# Grill me\n\nAsk one question at a time.");
  });

  it("has a Routines page when the app gives it routines, and none when it doesn't", async () => {
    const routines = { routines: [], add: () => null, edit: () => null, remove: () => {}, enable: () => {}, pause: () => {}, runNow: () => null, loadProjects: () => Promise.resolve([]), keepAwake: true, onKeepAwake: () => {}, onOpenChat: () => {} };
    const { unmount } = render(<SettingsView open="routines" {...props} routines={routines} />);
    expect(await screen.findByRole("heading", { name: "Routines" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Routines" })).toHaveAttribute("aria-current", "page");
    unmount();
    render(<SettingsView open="general" {...props} />);
    expect(screen.queryByRole("button", { name: "Routines" })).toBeNull();
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
    // The list is there before the servers arrive: wait for the row's button, not the list.
    fireEvent.click(await within(list).findByRole("button", { name: "Log in" }));
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

  it("lists agents as their own group and marks a plugin that's turned off", async () => {
    render(<SettingsView open="skills" {...props} />);
    expect(await screen.findByText("Agents")).toBeInTheDocument();
    expect(screen.getByText("/figma:scout").closest("button")).toHaveTextContent("turned off");
    // An agent isn't a slash command, so claude's list can't mark it "not loaded".
    expect(screen.getByText("/reviewer").closest("button")).not.toHaveTextContent("not loaded");
    expect(screen.getAllByText("not loaded")).toHaveLength(1);
  });

  it("edits a skill's whole file and saves it only against what was read", async () => {
    const raw = "---\nname: grill-me\n---\n# Grill me\n\nAsk one question at a time.";
    const edited = raw.replace("one question", "two questions");
    render(<SettingsView open="skills" {...props} />);
    fireEvent.click(await screen.findByText("/grill-me"));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", { name: "Edit /grill-me" });
    expect(editor).toHaveValue(raw);
    fireEvent.change(editor, { target: { value: edited } });
    skillSave.mockResolvedValueOnce({ status: "saved", changed: true });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(skillSave).toHaveBeenCalledWith("s1", "/h/.claude/skills/grill-me/SKILL.md", edited, raw));
    expect(await screen.findByText("Ask two questions at a time.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Edit /grill-me" })).toBeNull();
  });

  it("keeps an edit when the file changed on disk, and discards it only on request", async () => {
    render(<SettingsView open="skills" {...props} />);
    fireEvent.click(await screen.findByText("/grill-me"));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit /grill-me" }), { target: { value: "mine" } });
    skillSave.mockResolvedValueOnce({ status: "conflict", current: "theirs" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("It changed on disk since you opened it");
    expect(screen.getByRole("textbox", { name: "Edit /grill-me" })).toHaveValue("mine");
    readSkill.mockResolvedValueOnce("theirs");
    fireEvent.click(screen.getByRole("button", { name: "Discard my text" }));
    expect(await screen.findByText("theirs")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Edit /grill-me" })).toBeNull();
  });

  it("names the folder in the delete confirmation and deletes only after it's confirmed", async () => {
    render(<SettingsView open="skills" {...props} />);
    fireEvent.click(await screen.findByText("/grill-me"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("alertdialog", { name: "Delete /grill-me" });
    expect(confirm).toHaveTextContent("/h/.claude/skills/grill-me goes to the Trash");
    expect(confirm).toHaveTextContent(/put it back from there/);
    expect(skillDelete).not.toHaveBeenCalled();
    skillDelete.mockResolvedValueOnce("/Users/you/.Trash/grill-me");
    fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
    await waitFor(() => expect(skillDelete).toHaveBeenCalledWith("s1", "/h/.claude/skills/grill-me/SKILL.md"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("offers no edit or delete for a plugin's skill, or for an agent", async () => {
    render(<SettingsView open="skills" {...props} />);
    fireEvent.click(await screen.findByText("/superpowers:brainstorming"));
    expect(await screen.findByText("From plugin superpowers, read-only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    fireEvent.click(screen.getByText("/reviewer"));
    expect(await screen.findByText("An agent, read-only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("makes a new skill from a name and a line, then selects it", async () => {
    const made: SkillEntry = { name: "daily-notes", kind: "skill", source: "user", plugin: null, path: "/h/.claude/skills/daily-notes/SKILL.md", description: "Keeps notes", disabled: false };
    render(<SettingsView open="skills" {...props} />);
    await screen.findByText("Yours");
    fireEvent.click(screen.getByRole("button", { name: "New skill" }));
    const form = screen.getByRole("form", { name: "New skill" });
    skillCreate.mockResolvedValueOnce("/h/.claude/skills/daily-notes/SKILL.md");
    skillIndex.mockResolvedValue([...SKILLS, made]);
    fireEvent.change(within(form).getByPlaceholderText("daily-notes"), { target: { value: "daily-notes" } });
    fireEvent.change(within(form).getByPlaceholderText("Keeps my meeting notes tidy"), { target: { value: "Keeps notes" } });
    fireEvent.click(within(form).getByRole("button", { name: "Make skill" }));
    await waitFor(() => expect(skillCreate).toHaveBeenCalledWith("s1", "skill", "user", "daily-notes", "Keeps notes"));
    expect(await screen.findByLabelText("/daily-notes")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "New skill" })).toBeNull();
  });

  it("doesn't show the last chat's servers in a new one, and drops a late answer from the chat before", async () => {
    let answerOld: (r: unknown) => void = () => {};
    claudeRequest.mockImplementationOnce(() => new Promise((resolve) => (answerOld = resolve)));
    const { rerender } = render(<SettingsView open="mcp" {...props} />);
    claudeRequest.mockImplementation(() => Promise.resolve({ mcpServers: [{ name: "other-chat", status: "connected", config: { type: "stdio", command: "x" }, scope: "local" }] }));
    rerender(<SettingsView open="mcp" {...props} slot="s2" />);
    expect(await screen.findByText("other-chat")).toBeInTheDocument();
    await act(async () => answerOld({ mcpServers: SERVERS.map((s) => ({ ...s })) }));
    expect(screen.queryByText("sentry")).toBeNull();
    expect(screen.getByText("other-chat")).toBeInTheDocument();
  });

  it("doesn't put a reconnect's servers into the chat it was started in, once the chat has changed", async () => {
    let finishReconnect: (v: unknown) => void = () => {};
    claudeRequest.mockImplementation((slot: string, r: { subtype: string }) => {
      if (r.subtype === "mcp_reconnect") return new Promise((resolve) => (finishReconnect = resolve));
      const mcpServers = slot === "s2" ? [{ name: "other-chat", status: "connected", config: { type: "stdio", command: "x" }, scope: "local" }] : SERVERS.map((s) => ({ ...s }));
      return Promise.resolve(r.subtype === "mcp_status" ? { mcpServers } : {});
    });
    const { rerender } = render(<SettingsView open="mcp" {...props} />);
    const list = await screen.findByRole("list", { name: "MCP servers" });
    fireEvent.click(within(within(list).getAllByRole("listitem")[1]).getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(claudeRequest).toHaveBeenCalledWith("s1", { subtype: "mcp_reconnect", serverName: "postgres" }));
    rerender(<SettingsView open="mcp" {...props} slot="s2" />);
    expect(await screen.findByText("other-chat")).toBeInTheDocument();
    await act(async () => finishReconnect({}));
    // Asked for the old chat again once the reconnect is done (its first ask was at the start).
    await waitFor(() => expect(claudeRequest.mock.calls.filter(([s, r]) => s === "s1" && r.subtype === "mcp_status")).toHaveLength(2));
    await act(async () => {});
    expect(screen.queryByText("sentry")).toBeNull();
    expect(screen.getByText("other-chat")).toBeInTheDocument();
  });

  it("keeps a login started in one chat out of another, and finishes it for the chat it's for", async () => {
    let answerLogin: (r: unknown) => void = () => {};
    // Both chats have a server called sentry, so a login or busy mark from one would show on the other's row.
    claudeRequest.mockImplementation((_slot: string, r: { subtype: string }) => {
      if (r.subtype === "mcp_authenticate") return new Promise((resolve) => (answerLogin = resolve));
      return Promise.resolve(r.subtype === "mcp_status" ? { mcpServers: [{ name: "sentry", status: "needs-auth", config: { type: "http", url: "https://mcp.sentry.dev/mcp" }, scope: "user" }] } : {});
    });
    const { rerender } = render(<SettingsView open="mcp" {...props} />);
    const list = await screen.findByRole("list", { name: "MCP servers" });
    fireEvent.click(within(list).getByRole("button", { name: "Log in" }));
    expect(await screen.findByText("Opening the login page…")).toBeInTheDocument();

    rerender(<SettingsView open="mcp" {...props} slot="s2" />);
    const other = await within(screen.getByRole("list", { name: "MCP servers" })).findByRole("button", { name: "Log in" });
    expect(other).toBeEnabled();
    expect(screen.queryByText("Opening the login page…")).toBeNull();
    expect(screen.queryByText("Waiting for your login…")).toBeNull();

    // The login page opens and claude waits for the address the browser ends on, all for chat s1.
    await act(async () => answerLogin({ authUrl: "https://auth.example/x", callbackExpected: true }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://auth.example/x"));
    expect(claudeRequest).toHaveBeenCalledWith("s1", { subtype: "mcp_authenticate", serverName: "sentry" });
    expect(screen.queryByText("Waiting for your login…")).toBeNull();

    rerender(<SettingsView open="mcp" {...props} />);
    expect(await screen.findByText("Waiting for your login…")).toBeInTheDocument();
    expect(screen.getByText(/paste the address your browser ended on/)).toBeInTheDocument();
  });

  it("starts one claude.ai login for a double click on Connect", async () => {
    claudeRequest.mockImplementation((_slot: string, r: { subtype: string }) =>
      r.subtype === "mcp_status" ? Promise.resolve({ mcpServers: [{ name: "claude.ai Notion", status: "needs-auth", config: { type: "claudeai-proxy" }, scope: "claudeai", source: "claudeai" }] }) : new Promise(() => {}),
    );
    render(<SettingsView open="mcp" {...props} />);
    const connect = await screen.findByRole("button", { name: "Connect" });
    fireEvent.click(connect);
    fireEvent.click(connect);
    expect(claudeRequest.mock.calls.filter(([, r]) => (r as { subtype: string }).subtype === "mcp_authenticate")).toHaveLength(1);
  });

  it("shows a server's initial in place of an icon that won't load", async () => {
    claudeRequest.mockImplementation((_slot: string, r: { subtype: string }) =>
      r.subtype === "mcp_status" ? Promise.resolve({ mcpServers: [{ name: "figma", status: "connected", serverInfo: { title: "Figma", icons: [{ src: "https://static.example/figma.png" }] }, config: { type: "http", url: "https://mcp.figma.com/mcp" }, scope: "user" }] }) : Promise.resolve({}),
    );
    const { container } = render(<SettingsView open="mcp" {...props} />);
    await screen.findByRole("list", { name: "MCP servers" });
    // The remote picture is blocked by the window's CSP: the browser reports it failed.
    fireEvent.error(container.querySelector("img.mcp-icon")!);
    expect(container.querySelector("img.mcp-icon")).toBeNull();
    expect(container.querySelector(".mcp-icon.letter")?.textContent).toBe("F");
  });

  it("shows a skill's pictures as the text they describe, not loaded", async () => {
    readSkill.mockResolvedValue("# Skill\n\n![build status](https://tracker.example/pixel.png)\n");
    const { container } = render(<SettingsView open="skills" {...props} />);
    fireEvent.click(await screen.findByText("/grill-me"));
    expect(await screen.findByText("[Image: build status]")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows the skill picked last, even when an earlier one's text arrives after it", async () => {
    let landFirst: (t: string) => void = () => {};
    readSkill.mockImplementationOnce(() => new Promise<string>((resolve) => (landFirst = resolve)));
    readSkill.mockResolvedValueOnce("# Second\n\nSecond body\n");
    render(<SettingsView open="skills" {...props} />);
    fireEvent.click(await screen.findByText("/grill-me"));
    fireEvent.click(await screen.findByText("/superpowers:brainstorming"));
    expect(await screen.findByText("Second body")).toBeInTheDocument();
    await act(async () => landFirst("# First\n\nFirst body\n"));
    expect(screen.queryByText("First body")).toBeNull();
    expect(screen.getByText("Second body")).toBeInTheDocument();
  });

  it("has an Updates page when it's given one, and opens straight on it", async () => {
    const updates = { version: "0.1.9", state: { kind: "up_to_date" } as const, onCheck: vi.fn(), ready: null };
    const { rerender } = render(<SettingsView open="mcp" {...props} />);
    expect(screen.queryByRole("button", { name: "Updates" })).toBeNull();
    rerender(<SettingsView open="updates" {...props} updates={updates} />);
    expect(await screen.findByRole("heading", { name: "Updates" })).toBeInTheDocument();
    expect(screen.getByText("You're up to date.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(updates.onCheck).toHaveBeenCalled();
    // The other pages are still one click away.
    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(await screen.findByLabelText("Filter skills and commands")).toBeInTheDocument();
  });
});
