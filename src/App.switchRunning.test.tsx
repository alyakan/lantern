import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";
import { CONTINUE_TEXT } from "./lib/pendingSwitch";

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
  installMockBackend({});
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  const calls: Call[] = [];
  const answer = internals.invoke;
  internals.invoke = (cmd, args, options) => {
    calls.push([cmd, args]);
    return cmd in over ? Promise.resolve(over[cmd]) : answer(cmd, args, options);
  };
  const { default: App } = await import("./App");
  render(<App />);
  await screen.findByRole("button", { name: /^Permissions: / });
  await waitFor(() => expect(calls.some(([c]) => c === "start_session")).toBe(true));
  return calls;
}

const settingsSaying = (allow: boolean) => ({ remote_settings: { enabled: true, show_titles: false, rich_notifications: false, allow_phone_auto: allow, devices: [], connected: [], listening: true, pairing: false } });
const fromPhone = (payload: Record<string, unknown>) => (globalThis as unknown as { mockEmit: (e: string, p?: unknown) => Promise<void> }).mockEmit("remote-queue-switch", payload);
const of = (calls: Call[], cmd: string) => calls.filter(([c]) => c === cmd);
const sent = (calls: Call[]) => of(calls, "send_message").map(([, a]) => String(a?.text));
const slotOf = (calls: Call[]) => String(of(calls, "start_session")[0]?.[1]?.slot);

/** Sends `text` in the chat on screen; "keep going" works until it is stopped. */
async function say(calls: Call[], text: string) {
  // Once its claude has started and is doing nothing: a message typed before is queued (or dropped), not sent.
  const box = await screen.findByRole("textbox", { name: "Message to Claude" });
  await waitFor(() => expect(box.getAttribute("placeholder") ?? "").not.toMatch(/^(Open a folder|Starting |Queue a message)/));
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(sent(calls).some((t) => t.includes(text))).toBe(true));
}

/** Picks from a menu under the chat box, opening it again until the row shows (a click mid-render can leave it shut). */
async function pick(chip: RegExp, row: RegExp) {
  const find = () => within(document.querySelector(".composer-meta") as HTMLElement).getByRole("button", { name: chip });
  await waitFor(() => expect(find()).toBeEnabled());
  await waitFor(() => {
    if (find().getAttribute("aria-expanded") !== "true") fireEvent.click(find());
    fireEvent.click(screen.getByRole("menuitemradio", { name: row }));
  });
}

// A mock turn a test started (the carry-on) runs on after it, and its events would land in the next test's chat: let it end.
afterEach(() => new Promise((r) => setTimeout(r, 1500)));

beforeEach(() => {
  vi.resetModules();
  clearMocks();
  localStorage.clear();
  localStorage.setItem("settings.lastFolder", JSON.stringify(FOLDER));
  window.history.replaceState({}, "", "/");
});

describe("changing a working chat at the Mac", () => {
  it("asks, then on Apply now stops the turn, restarts on the new settings, and tells Claude to carry on", async () => {
    const calls = await launch();
    await say(calls, "keep going until done");
    await pick(/^Permissions: /, /^Auto/);
    const dialog = await screen.findByRole("alertdialog", { name: "Change this chat's settings now?" });
    expect(of(calls, "interrupt")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply now" }));
    await waitFor(() => expect(of(calls, "interrupt")).toHaveLength(1));
    await waitFor(() => expect(of(calls, "restart_session")).toHaveLength(1));
    expect(of(calls, "restart_session")[0][1]).toMatchObject({ mode: "auto" });
    await waitFor(() => expect(sent(calls).some((t) => t.includes(CONTINUE_TEXT))).toBe(true));
    // One restart, one carry-on.
    expect(of(calls, "restart_session")).toHaveLength(1);
    expect(sent(calls).filter((t) => t.includes(CONTINUE_TEXT))).toHaveLength(1);
  });

  it("changes nothing on Cancel", async () => {
    const calls = await launch();
    await say(calls, "keep going until done");
    await pick(/^Permissions: /, /^Auto/);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await new Promise((r) => setTimeout(r, 400));
    expect(of(calls, "interrupt")).toHaveLength(0);
    expect(of(calls, "restart_session")).toHaveLength(0);
  });

  it("on When it finishes stops nothing, shows what waits, and switches once the turn is done, with no carry-on", async () => {
    const calls = await launch();
    await say(calls, "add retries, quick");
    await pick(/^Workflow: /, /^Step by step/);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "When it finishes" }));
    expect(await screen.findByText("Step by step once Claude finishes")).toBeInTheDocument();
    // What waits is told to a phone too.
    await waitFor(() => expect(of(calls, "remote_window_chats").some(([, a]) => JSON.stringify(a).includes('"when":"finished"'))).toBe(true));
    await waitFor(() => expect(of(calls, "restart_session")).toHaveLength(1));
    expect(of(calls, "interrupt")).toHaveLength(0);
    expect(of(calls, "restart_session")[0][1]).toMatchObject({ mode: "steps" });
    await new Promise((r) => setTimeout(r, 400));
    expect(sent(calls).some((t) => t.includes(CONTINUE_TEXT))).toBe(false);
  });
});

describe("a phone's change to a working chat", () => {
  it("is applied now: stopped, restarted on it, and carried on, with Auto as Settings let phones", async () => {
    const calls = await launch(settingsSaying(true));
    await say(calls, "keep going until done");
    await fromPhone({ slot: slotOf(calls), change: { permissions: "auto" }, when: "now" });
    await waitFor(() => expect(of(calls, "interrupt")).toHaveLength(1));
    await waitFor(() => expect(of(calls, "restart_session")).toHaveLength(1));
    expect(of(calls, "restart_session")[0][1]).toMatchObject({ mode: "auto" });
    await waitFor(() => expect(sent(calls).some((t) => t.includes(CONTINUE_TEXT))).toBe(true));
    // A phone's choice isn't the project's next default.
    expect(JSON.parse(localStorage.getItem("settings.permissionsByFolder") ?? "{}")[FOLDER]).not.toBe("auto");
  });

  it("isn't taken for Auto while Settings don't let phones use it, nor for a preset this window doesn't have", async () => {
    const calls = await launch(settingsSaying(false));
    await say(calls, "keep going until done");
    await fromPhone({ slot: slotOf(calls), change: { permissions: "auto" }, when: "now" });
    await fromPhone({ slot: slotOf(calls), change: { preset: "made-up" }, when: "now" });
    await new Promise((r) => setTimeout(r, 400));
    expect(of(calls, "interrupt")).toHaveLength(0);
    expect(screen.queryByText(/Stopping to switch/)).toBeNull();
  });

  it("stays on Ask, restarting nothing, when Auto was turned off while it waited, and says so once it is done", async () => {
    let allow = true;
    const calls = await launch({ remote_settings: undefined });
    // Settings as they are when each is read: Auto allowed when the phone asks, turned off by the time it is applied.
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const before = internals.invoke;
    internals.invoke = (cmd, args, options) => (cmd === "remote_settings" ? Promise.resolve({ ...settingsSaying(allow).remote_settings }) : before(cmd, args, options));
    await say(calls, "keep going until done");
    await fromPhone({ slot: slotOf(calls), change: { permissions: "auto" }, when: "finished" });
    expect(await screen.findByText("Auto once Claude finishes")).toBeInTheDocument();
    allow = false;
    // The turn ends (stopped here by hand): the change comes to be applied, and is refused.
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText(/Auto from a phone was turned off/)).toBeInTheDocument();
    expect(of(calls, "restart_session")).toHaveLength(0);
  });

  it("changes the provider's settings now: stopped, then the backend is asked, then it carries on once", async () => {
    const calls = await launch(settingsSaying(true));
    await say(calls, "keep going until done");
    await fromPhone({ slot: slotOf(calls), change: { conversation: { effort: "low" } }, when: "now" });
    await waitFor(() => expect(of(calls, "interrupt")).toHaveLength(1));
    await waitFor(() => expect(of(calls, "conversation_settings").some(([, a]) => JSON.stringify(a?.change) === '{"effort":"low"}')).toBe(true));
    await waitFor(() => expect(sent(calls).filter((t) => t.includes(CONTINUE_TEXT))).toHaveLength(1));
  });

  it("is ignored when it isn't one setting it knows", async () => {
    const calls = await launch(settingsSaying(true));
    await say(calls, "keep going until done");
    for (const change of [{ workflow: "team" }, { shell: "rm -rf /" }, "auto"]) await fromPhone({ slot: slotOf(calls), change, when: "now" });
    await fromPhone({ slot: slotOf(calls), change: { permissions: "auto" }, when: "soon" });
    await new Promise((r) => setTimeout(r, 400));
    expect(of(calls, "interrupt")).toHaveLength(0);
  });
});
