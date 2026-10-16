import { beforeEach, describe, expect, it, vi } from "vitest";
import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";

// These render the whole app against the mock backend, which a loaded CI runner can take longer than
// vitest's default 5 s to do.
vi.setConfig({ testTimeout: 60_000 });
// Their finds and waits take as long on such a runner: the default 1 s is for a component, not the whole app.
configure({ asyncUtilTimeout: 20_000 });

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

const calledWith = (calls: Call[], cmd: string) => calls.filter(([c]) => c === cmd).map(([, a]) => a);
const inboxButton = () => within(screen.getByRole("banner")).getByRole("button", { name: /^What needs you/ });

beforeEach(() => {
  vi.resetModules();
  clearMocks();
  localStorage.clear();
  localStorage.setItem("settings.lastFolder", JSON.stringify(FOLDER));
  window.history.replaceState({}, "", "/");
});

describe("keeping the Mac awake", () => {
  it("tells the backend nothing is working at launch, with the setting on by default", async () => {
    const calls = await launch();
    await waitFor(() => expect(calledWith(calls, "keep_awake")).toEqual([{ working: false, allowed: true }]));
  });

  it("says so, and tells the backend, when the setting is turned off in Settings", async () => {
    const calls = await launch();
    fireEvent.click(screen.getByRole("button", { name: /^Settings/ }));
    const box = await screen.findByRole("checkbox", { name: "Keep my Mac awake while Claude works" });
    expect(box).toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(calledWith(calls, "keep_awake").pop()).toEqual({ working: false, allowed: false }));
    expect(JSON.parse(localStorage.getItem("settings.keepAwake") ?? "null")).toBe(false);
  });

  it("is told a chat is working while Claude replies, and that it stopped when the turn ends", async () => {
    const calls = await launch();
    const box = screen.getByRole("textbox", { name: "Message to Claude" });
    fireEvent.change(box, { target: { value: "retry the fetch" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(calledWith(calls, "keep_awake").pop()).toEqual({ working: true, allowed: true }));
  });
});

describe("the needs-you inbox", () => {
  it("is in the title bar with nothing waiting, whether the sidebar is shown or hidden", async () => {
    await launch();
    fireEvent.click(inboxButton());
    expect(await screen.findByText("Nothing is waiting for you.")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "What needs you" })).toBeNull();
  });

  it("stays when the sidebar is hidden", async () => {
    localStorage.setItem("sidebar.collapsed", "true");
    await launch();
    expect(inboxButton()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Show sidebar/ })).toBeInTheDocument();
  });

  it("lists a permission request, lets Allow answer it in place, and counts it until then", async () => {
    const calls = await launch();
    const box = screen.getByRole("textbox", { name: "Message to Claude" });
    fireEvent.change(box, { target: { value: "retry the fetch" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(inboxButton()).toHaveAccessibleName("What needs you, 1 waiting"), { timeout: 20_000 });
    fireEvent.click(inboxButton());
    const dialog = await screen.findByRole("dialog", { name: "What needs you" });
    const row = within(dialog).getByRole("listitem");
    expect(row).toHaveTextContent("acme-api");
    expect(row).toHaveTextContent("Wants to use Bash");
    expect(within(row).getByText("npm test -- retry")).toBeInTheDocument();
    // Allow stays dead for a moment after a row appears.
    await waitFor(() => expect(within(row).getByRole("button", { name: /^Allow / })).toHaveAttribute("aria-disabled", "false"), { timeout: 10_000 });
    fireEvent.click(within(row).getByRole("button", { name: /^Allow / }));
    await waitFor(() => expect(calledWith(calls, "respond_permission")).toHaveLength(1), { timeout: 10_000 });
    await waitFor(() => expect(within(dialog).getByText("Nothing is waiting for you.")).toBeInTheDocument(), { timeout: 10_000 });
    await waitFor(() => expect(inboxButton()).toHaveAccessibleName("What needs you"), { timeout: 10_000 });
  });
});
