import { beforeEach, describe, expect, it, vi } from "vitest";
import { configure, render, screen, waitFor } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";

// These render the whole app against the mock backend, which a loaded CI runner can take longer than
// vitest's default 5 s to do.
vi.setConfig({ testTimeout: 60_000 });
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
  // The window's chat is up (a project reopened and its session started) before the panel asks for anything.
  await waitFor(() => expect(calls.some(([c]) => c === "start_session")).toBe(true));
  return calls;
}

/** What the backend sends the main window when the menu bar panel asked for something (see menubar_act). */
const fromPanel = (action: unknown) => (globalThis as unknown as { mockEmit: (e: string, p?: unknown) => Promise<void> }).mockEmit("menubar-action", action);
const sent = (calls: Call[]) => calls.filter(([c]) => c === "send_message").map(([, a]) => String(a?.text));
const started = (calls: Call[]) => calls.filter(([c]) => c === "start_session").map(([, a]) => a?.folder);
const quiet = () => new Promise((r) => setTimeout(r, 600));

beforeEach(() => {
  vi.resetModules();
  clearMocks();
  localStorage.clear();
  localStorage.setItem("settings.lastFolder", JSON.stringify(FOLDER));
  window.history.replaceState({}, "", "/");
});

describe("what the menu bar panel asks of the main window", () => {
  it("starts a chat in a project the user knows and sends what was typed as its first message", async () => {
    const calls = await launch();
    await fromPanel({ kind: "new_chat", folder: FOLDER, text: "add a dark mode toggle" });
    await waitFor(() => expect(sent(calls).some((t) => t.includes("add a dark mode toggle"))).toBe(true));
    expect(started(calls).every((f) => f === FOLDER)).toBe(true);
  });

  it("starts nothing in a folder it doesn't know, and nothing without a message", async () => {
    const calls = await launch();
    const before = { started: started(calls).length, sent: sent(calls).length };
    await fromPanel({ kind: "new_chat", folder: "/etc", text: "do something" });
    await fromPanel({ kind: "new_chat", folder: FOLDER, text: "   " });
    await fromPanel({ kind: "new_chat", folder: FOLDER, text: "x".repeat(20_001) });
    await fromPanel({ kind: "new_chat", folder: FOLDER, text: 42 });
    await quiet();
    expect({ started: started(calls).length, sent: sent(calls).length }).toEqual(before);
  });

  it("opens Storage and Settings when asked", async () => {
    await launch();
    await fromPanel({ kind: "storage" });
    expect(await screen.findByRole("tab", { name: "Disk" })).toBeInTheDocument();
    await fromPanel({ kind: "settings" });
    expect(await screen.findByRole("radio", { name: "Lantern and readout" })).toBeInTheDocument();
  });

  it("publishes the open chats for the panel, and again when it asks", async () => {
    const calls = await launch();
    const published = () => calls.filter(([c, a]) => c === "plugin:event|emit" && a?.event === "menubar-chats");
    await waitFor(() => expect(published().length).toBeGreaterThan(0));
    const first = published().length;
    await (globalThis as unknown as { mockEmit: (e: string) => Promise<void> }).mockEmit("menubar-need-chats");
    await waitFor(() => expect(published().length).toBeGreaterThan(first));
    const latest = published()[published().length - 1];
    expect(JSON.stringify(latest?.[1]?.payload)).toContain(FOLDER.split("/").pop());
  });

  it("pushes the saved menu bar choice to the backend when the window starts", async () => {
    localStorage.setItem("lantern.menuBar", JSON.stringify({ mode: "icon", ram: false }));
    const calls = await launch();
    await waitFor(() => expect(calls.find(([c]) => c === "set_menu_bar")?.[1]).toEqual({ config: { mode: "icon", ram: false, disk: true, alerts: true } }));
  });
});
