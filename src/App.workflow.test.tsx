import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";

// The editor isn't needed here, and doesn't load in jsdom.
vi.mock("./monaco", () => ({ LIGHT_THEME: "lantern-light", DARK_THEME: "lantern-dark" }));
vi.mock("@monaco-editor/react", () => ({ default: () => null, DiffEditor: () => null, loader: { config: () => {} } }));

const FOLDER = "/Users/you/projects/acme-api";

type Call = [string, Record<string, unknown> | undefined];

/** Opens the app on a project with an empty chat, recording every command it sends to the backend. */
async function launch(): Promise<Call[]> {
  const { installMockBackend } = await import("./dev/mockBackend");
  installMockBackend();
  // The mock answers; this only listens, so what the window asks of the backend can be checked.
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  const calls: Call[] = [];
  const answer = internals.invoke;
  internals.invoke = (cmd, args, options) => {
    calls.push([cmd, args]);
    return answer(cmd, args, options);
  };
  const { default: App } = await import("./App");
  render(<App />);
  await screen.findByRole("button", { name: /^Permissions: / });
  return calls;
}

const last = (calls: Call[], cmd: string) => [...calls].reverse().find(([c]) => c === cmd)?.[1];

async function choose(chip: RegExp, row: RegExp) {
  fireEvent.click(await screen.findByRole("button", { name: chip }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: row }));
}

beforeEach(() => {
  vi.resetModules();
  clearMocks();
  localStorage.clear();
  localStorage.setItem("settings.lastFolder", JSON.stringify(FOLDER));
});

describe("Permissions and Workflow, under the box", () => {
  it("start a chat on Ask and Chat, with two chips where the mode chip was", async () => {
    await launch();
    expect(screen.getByRole("button", { name: "Permissions: Ask" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Workflow: Chat" })).toBeInTheDocument();
    expect(screen.queryByText(/Ask before actions|Auto-approve/)).toBeNull();
  });

  it("switch Permissions with a restart of the chat, and remember it for the project", async () => {
    const calls = await launch();
    await choose(/Permissions: Ask/, /^Auto/);
    await waitFor(() => expect(last(calls, "restart_session")).toMatchObject({ mode: "auto", autoApprove: false, team: null }));
    expect(await screen.findByRole("button", { name: "Permissions: Auto" })).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(localStorage.getItem("settings.permissionsByFolder") ?? "{}")).toEqual({ [FOLDER]: "auto" }));
  });

  it("keep Permissions when the Workflow changes: Step by step on Auto is auto-approve, Chat on Auto is the Auto mode", async () => {
    const calls = await launch();
    await choose(/Permissions: Ask/, /^Auto/);
    await choose(/Workflow: Chat/, /^Step by step/);
    await waitFor(() => expect(last(calls, "restart_session")).toMatchObject({ mode: "steps", autoApprove: true }));
    expect(screen.getByRole("button", { name: "Permissions: Auto" })).toBeInTheDocument();
    await choose(/Workflow: Step by step/, /^Chat/);
    await waitFor(() => expect(last(calls, "restart_session")).toMatchObject({ mode: "auto", autoApprove: false }));
    expect(screen.getByRole("button", { name: "Permissions: Auto" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("settings.workflowByFolder") ?? "{}")).toEqual({ [FOLDER]: "chat" });
  });

  it("show Step by step with no Auto-approve switch of its own", async () => {
    await launch();
    await choose(/Workflow: Chat/, /^Step by step/);
    await screen.findByRole("button", { name: "Workflow: Step by step" });
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText(/Auto-approve/)).toBeNull();
  });

  it("make this chat the Lead of a team when Team is chosen, and show the canvas with its Subagents setting", async () => {
    const calls = await launch();
    await choose(/Workflow: Chat/, /^Team/);
    await waitFor(() => expect(last(calls, "restart_session")).toMatchObject({ mode: "ask", team: true }));
    // The team's Lead is told where its subagents go, on the canvas by default, and the setting is in the canvas controls.
    await waitFor(() => expect(last(calls, "set_subagents")).toEqual({ slot: expect.any(String), subagents: "canvas" }));
    const subagents = await screen.findByRole("button", { name: "Subagents: On the canvas" });
    fireEvent.click(subagents);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Inline/ }));
    await waitFor(() => expect(last(calls, "set_subagents")).toEqual({ slot: expect.any(String), subagents: "inline" }));
    expect(await screen.findByRole("button", { name: "Subagents: Inline" })).toBeInTheDocument();
    // The next team in the project starts with it.
    expect(JSON.parse(localStorage.getItem("settings.subagentsByFolder") ?? "{}")).toEqual({ [FOLDER]: "inline" });
  });

  it("change a team's Permissions from the Lead's title bar on the canvas, where both settings are", async () => {
    const calls = await launch();
    await choose(/Workflow: Chat/, /^Team/);
    const lead = await screen.findByLabelText(/^Lead,/);
    expect(within(lead).getByRole("button", { name: "Workflow: Team" })).toBeInTheDocument();
    fireEvent.click(within(lead).getByRole("button", { name: "Permissions: Ask" }));
    fireEvent.click(within(lead).getByRole("menuitemradio", { name: /^Auto/ }));
    await waitFor(() => expect(last(calls, "restart_session")).toMatchObject({ mode: "auto", team: null }));
    expect(await within(lead).findByRole("button", { name: "Permissions: Auto" })).toBeInTheDocument();
  });
});

describe("a new team", () => {
  it("is not asked how it should run: it takes the chat's Permissions, and the card for where subagents run is gone", async () => {
    localStorage.setItem("settings.permissionsByFolder", JSON.stringify({ [FOLDER]: "auto" }));
    const calls = await launch();
    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Team/ }));
    await waitFor(() => expect(calls.filter(([c]) => c === "start_session").length).toBeGreaterThan(1));
    const started = calls.filter(([c]) => c === "start_session").pop()![1] as { settings: Record<string, unknown> };
    expect(started.settings).toMatchObject({ mode: "auto", orchestrator: true });
    // No dialog, however it is asked.
    expect(calls.some(([c]) => c.startsWith("plugin:dialog|"))).toBe(false);
    expect(screen.queryByText("How should this team run?")).toBeNull();
    expect(await screen.findByRole("button", { name: "Subagents: On the canvas" })).toBeInTheDocument();
  });
});

describe("what older versions saved", () => {
  it("a project that had Step by step with auto-approve on opens in Step by step, on Auto", async () => {
    localStorage.setItem("settings.modeByFolder", JSON.stringify({ [FOLDER]: "steps" }));
    localStorage.setItem("settings.autoApproveByFolder", JSON.stringify({ [FOLDER]: true }));
    const calls = await launch();
    expect(await screen.findByRole("button", { name: "Permissions: Auto" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Workflow: Step by step" })).toBeInTheDocument();
    const started = calls.filter(([c]) => c === "start_session").pop()![1] as { settings: Record<string, unknown> };
    expect(started.settings).toMatchObject({ mode: "steps", auto_approve: true });
    // The old keys are gone.
    expect(localStorage.getItem("settings.modeByFolder")).toBeNull();
    expect(localStorage.getItem("settings.autoApproveByFolder")).toBeNull();
  });
});
