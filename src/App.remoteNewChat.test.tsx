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
  await waitFor(() => expect(calls.some(([c]) => c === "start_session")).toBe(true));
  return calls;
}

/** What the backend sends the window when a phone starts a chat (see remote::NewChatRequest). */
const fromPhone = (request: Record<string, unknown>) => (globalThis as unknown as { mockEmit: (e: string, p?: unknown) => Promise<void> }).mockEmit("remote-new-chat", request);
const sessions = (calls: Call[]) => calls.filter(([c]) => c === "start_session");
const sent = (calls: Call[]) => calls.filter(([c]) => c === "send_message").map(([, a]) => String(a?.text));
const answers = (calls: Call[]) => calls.filter(([c]) => c === "remote_new_chat_done").map(([, a]) => a);
const quiet = () => new Promise((r) => setTimeout(r, 600));
const ask = (over: Record<string, unknown> = {}) => ({ id: "req-1", folder: FOLDER, text: "add a dark mode toggle", permissions: "ask", ...over });

beforeEach(() => {
  vi.resetModules();
  clearMocks();
  localStorage.clear();
  localStorage.setItem("settings.lastFolder", JSON.stringify(FOLDER));
  window.history.replaceState({}, "", "/");
});

describe("what the backend is told for a phone's suggestions", () => {
  it("is where this window found claude, once it has", async () => {
    const calls = await launch();
    await waitFor(() => expect(calls.some(([c]) => c === "remote_claude_path")).toBe(true));
    const told = calls.find(([c]) => c === "remote_claude_path")?.[1]?.path;
    expect(typeof told).toBe("string");
    expect(String(told).startsWith("/")).toBe(true);
  });
});

describe("a chat a paired phone starts", () => {
  it("starts in a project the user works in, sends the first message, and says which chat it made", async () => {
    const calls = await launch();
    const before = sessions(calls).length;
    await fromPhone(ask());
    await waitFor(() => expect(sessions(calls).length).toBe(before + 1));
    await waitFor(() => expect(sent(calls).some((t) => t.includes("add a dark mode toggle"))).toBe(true));
    expect(sessions(calls)[sessions(calls).length - 1]?.[1]?.folder).toBe(FOLDER);
    const [done] = answers(calls);
    expect(done).toMatchObject({ id: "req-1", error: null });
    expect(String(done?.slot)).toMatch(/^s\d+$/);
  });

  it("starts on Ask even when the project was left on Auto", async () => {
    localStorage.setItem("settings.permissionsByFolder", JSON.stringify({ [FOLDER]: "auto" }));
    const calls = await launch();
    const before = sessions(calls).length;
    await fromPhone(ask());
    await waitFor(() => expect(sessions(calls).length).toBe(before + 1));
    const settings = sessions(calls)[sessions(calls).length - 1]?.[1]?.settings as { mode: string; auto_approve: boolean };
    expect(settings.mode).toBe("ask");
    expect(settings.auto_approve).toBe(false);
  });

  it("leaves what the window shows and the project's Permissions as they were", async () => {
    localStorage.setItem("settings.permissionsByFolder", JSON.stringify({ [FOLDER]: "auto" }));
    const calls = await launch();
    const shown = (await screen.findByRole("button", { name: /^Permissions: / })).getAttribute("aria-label") ?? "";
    expect(shown).toContain("Auto");
    const before = sessions(calls).length;
    await fromPhone(ask());
    await waitFor(() => expect(sessions(calls).length).toBe(before + 1));
    await quiet();
    // The chat on screen is the one the user was in, still on Auto, and the project is still remembered as Auto.
    expect((await screen.findByRole("button", { name: /^Permissions: / })).getAttribute("aria-label")).toBe(shown);
    expect(JSON.parse(localStorage.getItem("settings.permissionsByFolder") ?? "{}")[FOLDER]).toBe("auto");
  });

  it("starts nothing in a folder it doesn't know, nothing without a message, nothing that isn't on Ask, and says why", async () => {
    const calls = await launch();
    const before = { started: sessions(calls).length, sent: sent(calls).length };
    await fromPhone(ask({ id: "a", folder: "/etc" }));
    await fromPhone(ask({ id: "b", text: "   " }));
    await fromPhone(ask({ id: "c", text: "x".repeat(20_001) }));
    await fromPhone(ask({ id: "d", text: 42 }));
    await fromPhone(ask({ id: "e", permissions: "auto" }));
    await waitFor(() => expect(answers(calls)).toHaveLength(5));
    expect({ started: sessions(calls).length, sent: sent(calls).length }).toEqual(before);
    for (const a of answers(calls)) expect(a).toMatchObject({ slot: null, error: expect.any(String) });
    expect(answers(calls).find((a) => a?.id === "e")?.error).toContain("Ask");
  });
});
