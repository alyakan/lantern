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
async function launch(over: Record<string, unknown> = {}): Promise<Call[]> {
  const { installMockBackend } = await import("./dev/mockBackend");
  installMockBackend();
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  const calls: Call[] = [];
  const answer = internals.invoke;
  internals.invoke = (cmd, args, options) => {
    calls.push([cmd, args]);
    // `over`: what a command answers instead (the window reads Settings' "Let paired phones use Auto" through remote_settings).
    return cmd in over ? Promise.resolve(over[cmd]) : answer(cmd, args, options);
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
    await fromPhone(ask({ id: "f", permissions: "bypassPermissions" }));
    await waitFor(() => expect(answers(calls)).toHaveLength(6));
    expect({ started: sessions(calls).length, sent: sent(calls).length }).toEqual(before);
    for (const a of answers(calls)) expect(a).toMatchObject({ slot: null, error: expect.any(String) });
    expect(answers(calls).find((a) => a?.id === "e")?.error).toContain("Auto from a phone is off");
    expect(answers(calls).find((a) => a?.id === "f")?.error).toContain("Ask or Auto");
  });
});

/** What Settings says about phones using Auto, as remote_settings answers it. */
const settingsSaying = (allow: boolean) => ({ remote_settings: { enabled: true, show_titles: false, allow_phone_auto: allow, devices: [], connected: [], listening: true, pairing: false } });
const fromPhoneEvent = (event: string, payload: Record<string, unknown>) => (globalThis as unknown as { mockEmit: (e: string, p?: unknown) => Promise<void> }).mockEmit(event, payload);
const restarts = (calls: Call[]) => calls.filter(([c]) => c === "restart_session");
const harnessApplied = (calls: Call[]) => calls.filter(([c]) => c === "apply_harness");

describe("a chat a paired phone starts on Auto or on a preset", () => {
  it("starts on Auto when Settings let phones use it", async () => {
    const calls = await launch(settingsSaying(true));
    const before = sessions(calls).length;
    await fromPhone(ask({ permissions: "auto" }));
    await waitFor(() => expect(sessions(calls).length).toBe(before + 1));
    expect((sessions(calls)[sessions(calls).length - 1]?.[1]?.settings as { mode: string }).mode).toBe("auto");
    expect(answers(calls)[0]).toMatchObject({ error: null });
  });

  it("starts nothing on Auto while Settings don't let phones use it, whatever the request says", async () => {
    const calls = await launch(settingsSaying(false));
    const before = sessions(calls).length;
    await fromPhone(ask({ permissions: "auto" }));
    await waitFor(() => expect(answers(calls)).toHaveLength(1));
    expect(sessions(calls).length).toBe(before);
    expect(answers(calls)[0]).toMatchObject({ slot: null, error: expect.stringContaining("Auto from a phone is off") });
  });

  it("runs on the preset the phone chose, and doesn't make it the project's", async () => {
    const calls = await launch();
    const before = sessions(calls).length;
    await fromPhone(ask({ preset: "thrifty" }));
    await waitFor(() => expect(sessions(calls).length).toBe(before + 1));
    expect((sessions(calls)[sessions(calls).length - 1]?.[1]?.settings as { model: string }).model).toBe("haiku");
    expect(JSON.parse(localStorage.getItem("settings.harnessByFolder") ?? "{}")[FOLDER]).toBeUndefined();
  });

  it("starts nothing on a preset the window doesn't have, rather than quietly running another", async () => {
    const calls = await launch();
    const before = sessions(calls).length;
    await fromPhone(ask({ preset: "made-up" }));
    await waitFor(() => expect(answers(calls)).toHaveLength(1));
    expect(sessions(calls).length).toBe(before);
    expect(answers(calls)[0]).toMatchObject({ slot: null, error: "That isn't one of your presets." });
  });

  it("tells the backend which presets a phone may choose between", async () => {
    const calls = await launch();
    await waitFor(() => expect(calls.some(([c]) => c === "remote_window_controls")).toBe(true));
    const presets = calls.find(([c]) => c === "remote_window_controls")?.[1]?.presets as { id: string; name: string; summary: string }[];
    expect(presets.map((p) => p.id)).toEqual(expect.arrayContaining(["default", "balanced", "thrifty", "max"]));
    expect(presets.find((p) => p.id === "balanced")?.summary).toBe("Sonnet · Opus advisor · Haiku subagents");
  });
});

describe("a chat a paired phone switches", () => {
  const firstSlot = (calls: Call[]) => String(sessions(calls)[0]?.[1]?.slot);

  it("goes to Auto when Settings let phones, leaving the project's Permissions as they were", async () => {
    const calls = await launch(settingsSaying(true));
    await quiet();
    await fromPhoneEvent("remote-set-permissions", { slot: firstSlot(calls), permissions: "auto" });
    await waitFor(() => expect(restarts(calls)).toHaveLength(1));
    expect(restarts(calls)[0][1]).toMatchObject({ slot: firstSlot(calls), mode: "auto" });
    await quiet();
    expect(JSON.parse(localStorage.getItem("settings.permissionsByFolder") ?? "{}")[FOLDER]).not.toBe("auto");
  });

  it("stays on Ask when Settings don't let phones use Auto, whatever the request says", async () => {
    const calls = await launch(settingsSaying(false));
    await quiet();
    await fromPhoneEvent("remote-set-permissions", { slot: firstSlot(calls), permissions: "auto" });
    await quiet();
    expect(restarts(calls)).toHaveLength(0);
  });

  it("is put on a preset the window has, without making it the project's, and not on one it hasn't", async () => {
    const calls = await launch();
    await quiet();
    await fromPhoneEvent("remote-set-preset", { slot: firstSlot(calls), preset: "made-up" });
    await quiet();
    expect(harnessApplied(calls)).toHaveLength(0);
    await fromPhoneEvent("remote-set-preset", { slot: firstSlot(calls), preset: "max" });
    await waitFor(() => expect(harnessApplied(calls)).toHaveLength(1));
    expect(harnessApplied(calls)[0][1]).toMatchObject({ slot: firstSlot(calls), model: "opus" });
    await quiet();
    expect(JSON.parse(localStorage.getItem("settings.harnessByFolder") ?? "{}")[FOLDER]).toBeUndefined();
  });

  it("does nothing for a chat it doesn't have", async () => {
    const calls = await launch(settingsSaying(true));
    await quiet();
    await fromPhoneEvent("remote-set-permissions", { slot: "nope", permissions: "auto" });
    await fromPhoneEvent("remote-set-preset", { slot: "nope", preset: "max" });
    await quiet();
    expect(restarts(calls)).toHaveLength(0);
    expect(harnessApplied(calls)).toHaveLength(0);
  });
});

describe("a chat a paired phone closes", () => {
  const firstSlot = (calls: Call[]) => String(sessions(calls)[0]?.[1]?.slot);
  const closed = (calls: Call[]) => calls.filter(([c]) => c === "close_session").map(([, a]) => a?.slot);

  it("is closed as the sidebar closes one", async () => {
    const calls = await launch();
    await quiet();
    await fromPhoneEvent("remote-close-chat", { slot: firstSlot(calls) });
    await waitFor(() => expect(closed(calls)).toContain(firstSlot(calls)));
  });

  it("does nothing for a chat it doesn't have", async () => {
    const calls = await launch();
    await quiet();
    await fromPhoneEvent("remote-close-chat", { slot: "nope" });
    await quiet();
    expect(closed(calls)).not.toContain("nope");
  });
});
