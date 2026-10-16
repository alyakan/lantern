import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";

// These render the whole app against the mock backend, which a loaded CI runner can take longer than
// vitest's default 5 s to do.
vi.setConfig({ testTimeout: 30_000 });

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
    await choose(/Workflow: Chat/, /^Team(?! from)/);
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
    await choose(/Workflow: Chat/, /^Team(?! from)/);
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
    fireEvent.click(screen.getByRole("menuitem", { name: /^Team(?! from)/ }));
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

/** How long a step may take on a loaded runner. */
const LOAD = 10_000;

describe("a second team while another is working", () => {
  /** Picks a Workflow from the chip under the chat box (the agents' cards have their own), once the chat's claude has started. */
  async function pick(chip: RegExp, row: RegExp) {
    const find = () => within(document.querySelector(".composer-meta") as HTMLElement).getByRole("button", { name: chip });
    await waitFor(() => expect(find()).toBeEnabled(), { timeout: LOAD });
    fireEvent.click(find());
    fireEvent.click(await screen.findByRole("menuitemradio", { name: row }, { timeout: LOAD }));
  }
  /** A team whose Lead is working on a message, so the next team start has something to ask about. */
  async function busyTeam() {
    const calls = await launch();
    await pick(/Workflow: Chat/, /^Team(?! from)/);
    const box = within(await screen.findByLabelText(/^Lead,/, undefined, { timeout: LOAD })).getByLabelText("Message this agent");
    fireEvent.change(box, { target: { value: "Build the login form (team)" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(last(calls, "send_message")).toBeDefined(), { timeout: LOAD });
    return calls;
  }
  const newTeam = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Team(?! from)/ }));
  };
  const starts = (calls: Call[]) => calls.filter(([c]) => c === "start_session").length;

  it("asks first, says who is working, and starts nothing on Cancel", async () => {
    const calls = await busyTeam();
    const before = starts(calls);
    await newTeam();
    expect(await screen.findByText(/^Another team is working \(acme-api, .*\)\. Every agent spends the same plan\. Start anyway\?$/, undefined, { timeout: LOAD })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText(/Start anyway\?/)).toBeNull(), { timeout: LOAD });
    expect(starts(calls)).toBe(before);
  });

  it("starts the team on Start, and with Don't ask again never asks again", async () => {
    const calls = await busyTeam();
    const before = starts(calls);
    await newTeam();
    fireEvent.click(await screen.findByLabelText("Don't ask again", undefined, { timeout: LOAD }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(starts(calls)).toBe(before + 1), { timeout: LOAD });
    expect(JSON.parse(localStorage.getItem("settings.warnSecondTeam") ?? "true")).toBe(false);
    // The first team's Lead is still working: a third team starts without asking.
    await newTeam();
    await waitFor(() => expect(starts(calls)).toBe(before + 2), { timeout: LOAD });
    expect(screen.queryByText(/Start anyway\?/)).toBeNull();
  });

  it("doesn't ask when no team is working", async () => {
    const calls = await launch();
    const before = starts(calls);
    await newTeam();
    await waitFor(() => expect(starts(calls)).toBe(before + 1), { timeout: LOAD });
    expect(screen.queryByText(/Start anyway\?/)).toBeNull();
  });

  it("asks before a chat becomes a Lead from the Workflow menu, too", async () => {
    await busyTeam();
    // A plain chat next to the team.
    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Chat/ }));
    await pick(/Workflow: Chat/, /^Team(?! from)/);
    expect(await screen.findByText(/Start anyway\?/, undefined, { timeout: LOAD })).toBeInTheDocument();
  });
});

describe("a team from a template", () => {
  const startOne = async (calls: Call[], template: RegExp, task: string) => {
    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Team from a template/ }));
    const dialog = await screen.findByRole("dialog", { name: "Team from a template" });
    fireEvent.click(within(dialog).getByRole("radio", { name: template }));
    fireEvent.change(within(dialog).getByLabelText("What the team should do"), { target: { value: task } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start team" }));
    await waitFor(() => expect(calls.filter(([c]) => c === "send_message").length).toBe(1));
  };

  it("starts nothing when the dialog is cancelled", async () => {
    const calls = await launch();
    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Team from a template/ }));
    const dialog = await screen.findByRole("dialog", { name: "Team from a template" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Team from a template" })).toBeNull());
    expect(calls.filter(([c]) => c === "start_session")).toHaveLength(1);
    expect(calls.some(([c]) => c === "send_message")).toBe(false);
  });

  it("makes the chat a Lead, tells it its project's roles, and sends it a first instruction naming each member and its role", async () => {
    localStorage.setItem("settings.rolesByFolder", JSON.stringify({ [FOLDER]: [{ id: "api-reviewer", label: "API reviewer", description: "Checks the API.", brief: "Check the API: {task}", model: "haiku", isolation: "shared", readOnly: true }] }));
    const calls = await launch();
    await startOne(calls, /Build, review and test/, "add a dark mode toggle");
    const started = calls.filter(([c]) => c === "start_session").pop()![1] as { slot: string; settings: Record<string, unknown> };
    expect(started.settings).toMatchObject({ orchestrator: true });
    // The Lead is told the project's own roles so it can ask for one by id, before its first instruction.
    await waitFor(() => expect(last(calls, "orchestra_set_roles")).toMatchObject({ main: started.slot, roles: [expect.objectContaining({ id: "api-reviewer", readOnly: true })] }));
    const sent = last(calls, "send_message") as { slot: string; text: string };
    expect(sent.slot).toBe(started.slot);
    expect(sent.text).toContain("Start a team for this job: add a dark mode toggle");
    for (const part of ['- Builder (role "builder", can edit)', '- Reviewer (role "reviewer", read only)', '- QA / tester (role "qa", can edit)', "spawn_agent"]) expect(sent.text).toContain(part);
    expect(calls.findIndex(([c]) => c === "orchestra_set_roles")).toBeLessThan(calls.findIndex(([c]) => c === "send_message"));
    expect(await screen.findByRole("button", { name: "Subagents: On the canvas" })).toBeInTheDocument();
  });

});
