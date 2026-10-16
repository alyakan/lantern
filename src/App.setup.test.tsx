import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";

// These render the whole app against the mock backend, which a loaded CI runner can take longer than
// vitest's default 5 s to do.
vi.setConfig({ testTimeout: 30_000 });

// The editor isn't needed here, and doesn't load in jsdom.
vi.mock("./monaco", () => ({ LIGHT_THEME: "lantern-light", DARK_THEME: "lantern-dark" }));
vi.mock("@monaco-editor/react", () => ({ default: () => null, DiffEditor: () => null, loader: { config: () => {} } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined), revealItemInDir: vi.fn().mockResolvedValue(undefined) }));

const FOLDER = "/Users/you/projects/acme-api";

type Call = [string, Record<string, unknown> | undefined];

/** Opens the app on a project with an empty chat, recording every command it sends to the backend. */
async function launch(): Promise<Call[]> {
  const { installMockBackend } = await import("./dev/mockBackend");
  installMockBackend();
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

const calledWith = (calls: Call[], cmd: string) => calls.filter(([c]) => c === cmd).map(([, a]) => a);

beforeEach(() => {
  vi.resetModules();
  clearMocks();
  localStorage.clear();
  localStorage.setItem("settings.lastFolder", JSON.stringify(FOLDER));
  window.history.replaceState({}, "", "/");
});

async function openSetup() {
  const acme = await screen.findByRole("region", { name: "acme-api" });
  fireEvent.click(within(acme).getByRole("button", { name: "More for acme-api" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Project setup…" }));
  return screen.findByRole("dialog");
}

describe("a project's setup in the app", () => {
  it("is saved from the project's ⋯ menu, kept for the folder, and sent to the backend", async () => {
    const calls = await launch();
    const dialog = await openSetup();
    expect(within(dialog).getByText("Project setup for acme-api")).toBeInTheDocument();
    // What the project's files suggest is offered, not applied.
    fireEvent.click(await within(dialog).findByRole("button", { name: "Fill in" }));
    expect(calledWith(calls, "set_project_setup").filter((a) => (a?.commands as string[]).length > 0)).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calledWith(calls, "set_project_setup").some((a) => a?.folder === FOLDER && (a.commands as string[]).join() === "npm ci" && a.run === "npm run dev")).toBe(true));
    expect(JSON.parse(localStorage.getItem("settings.projectSetupByFolder")!)).toEqual({ [FOLDER]: { commands: ["npm ci"], run: "npm run dev" } });
    // Opening it again starts from what was saved.
    const again = await openSetup();
    expect((within(again).getByRole("textbox", { name: /Run in each new agent's worktree/ }) as HTMLTextAreaElement).value).toBe("npm ci");
  });

  it("is sent to the backend at launch, so a new agent finds it", async () => {
    localStorage.setItem("settings.projectSetupByFolder", JSON.stringify({ [FOLDER]: { commands: ["npm ci"], run: "" } }));
    const calls = await launch();
    await waitFor(() => expect(calledWith(calls, "set_project_setup")).toContainEqual({ folder: FOLDER, commands: ["npm ci"], run: null }));
  });
});

describe("the Run button in the app", () => {
  it("isn't in the title bar until the project has a Run command", async () => {
    await launch();
    await screen.findByRole("region", { name: "acme-api" });
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
  });

  it("starts the project's command in the chat, shows what it prints and its address, and stops it", async () => {
    localStorage.setItem("settings.projectSetupByFolder", JSON.stringify({ [FOLDER]: { commands: [], run: "npm run dev" } }));
    const calls = await launch();
    const run = await screen.findByRole("button", { name: "Run" });
    // Nothing runs until it is pressed.
    expect(calledWith(calls, "run_project")).toEqual([]);
    fireEvent.click(run);
    await waitFor(() => expect(calledWith(calls, "run_project")).toHaveLength(1));
    const [started] = calledWith(calls, "run_project");
    expect(String(started?.id)).toMatch(/^run-/);
    const panel = await screen.findByRole("group", { name: "Run" });
    expect(await within(panel).findByRole("link", { name: "http://localhost:5173/" }, { timeout: 5000 })).toBeInTheDocument();
    expect(within(panel).getByRole("status")).toHaveTextContent("Running");
    expect(run).toBeDisabled();
    fireEvent.click(within(panel).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(calledWith(calls, "stop_shell")).toContainEqual(expect.objectContaining({ id: started?.id })));
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Run" })).getByRole("status")).toHaveTextContent("Stopped"));
    // Closing the panel leaves nothing of it.
    fireEvent.click(screen.getByRole("button", { name: "Close the Run panel" }));
    expect(screen.queryByRole("group", { name: "Run" })).toBeNull();
    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
  });
});
