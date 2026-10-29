import { beforeEach, describe, expect, it, vi } from "vitest";
import { configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";

// The whole app against the mock backend: slow on a loaded runner (see App.finish.test.tsx).
vi.setConfig({ testTimeout: 60_000 });
configure({ asyncUtilTimeout: 20_000 });

vi.mock("./monaco", () => ({ LIGHT_THEME: "lantern-light", DARK_THEME: "lantern-dark" }));
vi.mock("@monaco-editor/react", () => ({ default: () => null, DiffEditor: () => null, loader: { config: () => {} } }));

const FOLDER = "/Users/you/projects/acme-api";

type Call = [string, Record<string, unknown> | undefined];

async function launch(): Promise<Call[]> {
  localStorage.setItem("settings.lastFolder", JSON.stringify(FOLDER));
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

const settle = () => waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull(), { timeout: 40_000 });
const edits = (calls: Call[]) => calls.filter(([c]) => c === "todos_edit").map(([, a]) => a?.edit);

beforeEach(() => {
  vi.resetModules();
  clearMocks();
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("to-dos in the app", () => {
  it("adds /todo from the message box to the project's list instead of sending it, and shows the Todos tab", async () => {
    const calls = await launch();
    await settle();
    const box = screen.getByRole("textbox", { name: "Message to Claude" });
    fireEvent.change(box, { target: { value: "/todo 2026-11-03 Renew the cert" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(edits(calls)).toContainEqual({ op: "add", title: "Renew the cert", due: { date: "2026-11-03", time: null } }));
    expect(calls.some(([c, a]) => c === "send_message" && String(a?.text).includes("Renew"))).toBe(false);
    expect(await screen.findByRole("tab", { name: /^Todos/ })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("button", { name: "Renew the cert" })).toBeInTheDocument();
  });

  it("starts a chat on an item with ▶, then asks whether it is done once Claude has answered", async () => {
    const calls = await launch();
    await settle();
    const box = screen.getByRole("textbox", { name: "Message to Claude" });
    fireEvent.change(box, { target: { value: "/todo" } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "Start a chat on “Write the release notes for 0.1.82”" }));
    await waitFor(() => expect(calls.some(([c, a]) => c === "send_message" && /^Work on this to-do from my list: Write the release notes/.test(String(a?.text)))).toBe(true));
    await waitFor(() => expect(edits(calls)).toContainEqual(expect.objectContaining({ op: "link", id: "t2" })));
    // The mock's turn asks to run its tests first; the question isn't asked while Claude still works.
    const allow = await screen.findByRole("button", { name: "Allow" }, { timeout: 30_000 });
    expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
    await waitFor(() => expect(allow).toBeEnabled());
    fireEvent.click(allow);
    await settle();
    fireEvent.click(await screen.findByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(edits(calls)).toContainEqual({ op: "done", id: "t2", done: true }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull());
  });
});
