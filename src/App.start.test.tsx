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

const last = (calls: Call[], cmd: string) => [...calls].reverse().find(([c]) => c === cmd)?.[1];

/** The mock plays a turn on timers that outlive the test: wait for it to end, so it can't reach the next test's chat. */
const settle = () => waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull(), { timeout: 15000 });

beforeEach(() => {
  vi.resetModules();
  clearMocks();
  localStorage.clear();
  localStorage.setItem("settings.lastFolder", JSON.stringify(FOLDER));
  window.history.replaceState({}, "", "/");
});

describe("the start screen", () => {
  it("is on an empty chat in every Workflow, with Build, Review a PR, Debug, Design and Start a team", async () => {
    await launch();
    const start = await screen.findByRole("region", { name: "Start" });
    expect([...within(start).getAllByRole("button").map((b) => b.querySelector(".steps-intro-flavour-name")?.textContent)].filter(Boolean)).toEqual(["Build", "Review a PR", "Debug", "Design", "Start a team"]);
    // The box is there too, to say what you're after in your own words.
    expect(screen.getByRole("textbox", { name: "Message to Claude" })).toBeInTheDocument();
  });

  it("Build, Debug and Design make the Workflow Step by step in that flavour", async () => {
    const calls = await launch();
    fireEvent.click(await screen.findByRole("button", { name: /^Design/ }));
    await waitFor(() => expect(last(calls, "restart_session")).toMatchObject({ mode: "steps" }));
    expect(await screen.findByRole("button", { name: "Workflow: Step by step · Design" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Design/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("Start a team makes the chat a team's Lead", async () => {
    const calls = await launch();
    fireEvent.click(within(await screen.findByRole("region", { name: "Start" })).getByRole("button", { name: /^Start a team/ }));
    await waitFor(() => expect(last(calls, "restart_session")).toMatchObject({ team: true }));
    expect(await screen.findByRole("button", { name: "Workflow: Team" })).toBeInTheDocument();
  });

  it("Build and Debug offer Explain as you go, and Claude is told when it's on", async () => {
    const calls = await launch();
    expect(screen.queryByRole("checkbox", { name: /Explain as you go/ })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /^Debug/ }));
    const option = await screen.findByRole("checkbox", { name: /Explain as you go/ });
    fireEvent.click(option);
    expect(option).toBeChecked();
    await waitFor(() => expect(screen.getByRole("button", { name: "Workflow: Step by step · Debug" })).toBeEnabled());
    const box = screen.getByRole("textbox", { name: "Message to Claude" });
    fireEvent.change(box, { target: { value: "saving crashes" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(last(calls, "send_message")?.text).toContain("switched to Debug, explaining as you go."));
    await settle();
  });
});

describe("Review a PR", () => {
  it("lists the open pull requests and starts Step by step Review on the one chosen", async () => {
    const calls = await launch();
    fireEvent.click(await screen.findByRole("button", { name: /^Review a PR/ }));
    const dialog = await screen.findByRole("dialog", { name: "Review a PR" });
    expect(last(calls, "list_open_prs")).toEqual({ folder: FOLDER });
    const list = await within(dialog).findByRole("list", { name: "Open pull requests" });
    expect(within(list).getAllByRole("button")).toHaveLength(3);
    fireEvent.click(within(list).getByRole("button", { name: /#128.*Retry fetchJson/ }));
    await waitFor(() => expect(last(calls, "restart_session")).toMatchObject({ mode: "steps" }));
    await waitFor(() => expect(last(calls, "send_message")?.text).toContain("Review PR #128"));
    expect(last(calls, "send_message")?.text).toContain("switched to Review");
    await settle();
  });

  it("says why when gh can't list them, and a number can still be typed", async () => {
    window.history.replaceState({}, "", "/?prs=missing");
    const calls = await launch();
    fireEvent.click(await screen.findByRole("button", { name: /^Review a PR/ }));
    const dialog = await screen.findByRole("dialog", { name: "Review a PR" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The GitHub CLI (gh) isn't installed");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "PR number" }), { target: { value: "#42" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    await waitFor(() => expect(last(calls, "send_message")?.text).toContain("Review PR #42"));
    await settle();
  });
});

describe("the Work menu in the command palette", () => {
  const openPalette = async () => {
    await screen.findByRole("region", { name: "Start" });
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
    return screen.findByRole("dialog", { name: /Command palette/i });
  };

  it("lists Build, Review a PR…, Debug, Design and Start a team (⇧⌘N), and runs them", async () => {
    const calls = await launch();
    const palette = await openPalette();
    const titles = within(palette).getAllByRole("option").map((o) => o.textContent ?? "");
    for (const title of ["Build", "Review a PR…", "Debug", "Design", "Start a team"]) expect(titles.some((t) => t.startsWith(title)), title).toBe(true);
    expect(titles.find((t) => t.startsWith("Start a team"))).toContain("⇧⌘N");
    fireEvent.click(within(palette).getAllByRole("option").find((o) => o.textContent?.startsWith("Design"))!);
    await waitFor(() => expect(last(calls, "restart_session")).toMatchObject({ mode: "steps" }));
    expect(await screen.findByRole("button", { name: "Workflow: Step by step · Design" })).toBeInTheDocument();
  });

  it("⇧⌘N starts a team in an empty chat", async () => {
    const calls = await launch();
    await screen.findByRole("region", { name: "Start" });
    fireEvent.keyDown(window, { key: "n", metaKey: true, shiftKey: true });
    await waitFor(() => expect(last(calls, "restart_session")).toMatchObject({ team: true }));
  });
});
