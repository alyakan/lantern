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

const started = (calls: Call[]) => [...calls].reverse().find(([c]) => c === "start_session")?.[1]?.settings as Record<string, unknown> | undefined;
const saved = () => JSON.parse(localStorage.getItem("settings.projectNotes") ?? "{}");

beforeEach(() => {
  vi.resetModules();
  clearMocks();
  localStorage.clear();
  localStorage.setItem("settings.lastFolder", JSON.stringify(FOLDER));
  window.history.replaceState({}, "", "/");
});

describe("project notes in the app", () => {
  it("are written from the project's ⋯ menu, kept by Lantern and marked on the project", async () => {
    await launch();
    const project = await screen.findByRole("region", { name: "acme-api" });
    expect(within(project).queryByRole("img", { name: "Has project notes" })).toBeNull();
    fireEvent.click(within(project).getByRole("button", { name: "More for acme-api" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Project notes…" }));
    const dialog = await screen.findByRole("dialog", { name: /Project notes: acme-api/ });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Project notes" }), { target: { value: "  Always use pnpm.  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(screen.queryByRole("dialog", { name: /Project notes/ })).toBeNull();
    expect(saved()).toEqual({ [FOLDER]: "Always use pnpm." });
    expect(await within(project).findByRole("img", { name: "Has project notes" })).toBeInTheDocument();
    // Saving them touches no file of the project: nothing but Lantern's own storage changed.
  });

  it("open from the command palette for the project on screen, and Clear then Save takes them away", async () => {
    localStorage.setItem("settings.projectNotes", JSON.stringify({ [FOLDER]: "The API is in /server." }));
    await launch();
    await screen.findByRole("region", { name: "Start" });
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
    const palette = await screen.findByRole("dialog", { name: /Command palette/i });
    fireEvent.click(within(palette).getAllByRole("option").find((o) => o.textContent?.startsWith("Project notes…"))!);
    const dialog = await screen.findByRole("dialog", { name: /Project notes: acme-api/ });
    const box = within(dialog).getByRole("textbox", { name: "Project notes" });
    expect(box).toHaveValue("The API is in /server.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(saved()).toEqual({});
    expect(screen.queryByRole("img", { name: "Has project notes" })).toBeNull();
  });

  it("go to a chat started in the project, which says so; a project without notes sends none", async () => {
    localStorage.setItem("settings.projectNotes", JSON.stringify({ [FOLDER]: "Answer in plain language." }));
    const calls = await launch();
    await waitFor(() => expect(started(calls)).toBeDefined());
    expect(started(calls)).toMatchObject({ project_notes: "Answer in plain language." });
    const line = await screen.findByText("Project notes applied");
    expect(line.closest("details")).not.toHaveAttribute("open");
    expect(within(line.closest("details")!).getByText("Answer in plain language.")).toBeInTheDocument();
  });

  it("are not sent, and not claimed, for a project that has none", async () => {
    const calls = await launch();
    await waitFor(() => expect(started(calls)).toBeDefined());
    expect(started(calls)).not.toHaveProperty("project_notes");
    expect(screen.queryByText("Project notes applied")).toBeNull();
  });

  it("changed while a chat runs leave that chat as it was: only a chat started after the save gets them", async () => {
    const calls = await launch();
    await waitFor(() => expect(started(calls)).toBeDefined());
    const before = calls.filter(([c]) => c === "start_session").length;
    const project = await screen.findByRole("region", { name: "acme-api" });
    fireEvent.click(within(project).getByRole("button", { name: "More for acme-api" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Project notes…" }));
    const dialog = await screen.findByRole("dialog", { name: /Project notes: acme-api/ });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Project notes" }), { target: { value: "Never touch /legacy." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    // Saving starts nothing and restarts nothing, and the chat on screen doesn't claim them.
    expect(calls.filter(([c]) => c === "start_session").length).toBe(before);
    expect(calls.some(([c]) => c === "restart_session")).toBe(false);
    expect(screen.queryByText("Project notes applied")).toBeNull();
    // A new chat in the project is the one that gets them.
    fireEvent.click(within(project).getByRole("button", { name: "New chat in acme-api" }));
    await waitFor(() => expect(started(calls)).toMatchObject({ project_notes: "Never touch /legacy." }));
  });
});
