import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach } from "vitest";

// The editor isn't needed here, and doesn't load in jsdom.
vi.mock("./monaco", () => ({ LIGHT_THEME: "lantern-light", DARK_THEME: "lantern-dark" }));
vi.mock("@monaco-editor/react", () => ({ default: () => null, DiffEditor: () => null, loader: { config: () => {} } }));

/**
 * The window with the mock backend, with one provider (Claude Code) or two (also a fake "Codex": no auto mode, advisor,
 * skills or dollar cost, and its own models). The provider controls exist only with two.
 */

const FOLDER = "/Users/you/projects/acme-api";
const CODEX = "/Users/you/.local/bin/codex";

type Call = [string, Record<string, unknown>];
let calls: Call[] = [];

async function launch(providers: boolean, placeholder = "Ask Claude…") {
  const { installMockBackend } = await import("./dev/mockBackend");
  installMockBackend({ providers });
  // Every command the window sends, as it sends it.
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  const real = internals.invoke;
  internals.invoke = (cmd, args, options) => {
    calls.push([cmd, args ?? {}]);
    return real(cmd, args, options);
  };
  const { default: App } = await import("./App");
  render(<App />);
  await screen.findByPlaceholderText(placeholder);
  await waitFor(() => expect(document.querySelector(".model-button")).not.toBeNull());
}

const started = () => calls.filter(([cmd]) => cmd === "start_session").map(([, a]) => a as { claudePath: string; settings: Record<string, unknown> });
const chip = (title: RegExp | string) => screen.queryByTitle(title);
const rows = () => screen.getAllByRole("menuitemradio").map((r) => r.querySelector(".menu-row-title")?.textContent);
/** The Permissions menu's rows that can be picked. */
const pickable = () => screen.getAllByRole("menuitemradio").filter((r) => !(r as HTMLButtonElement).disabled).map((r) => r.querySelector(".menu-row-title")?.textContent);
/** The chip for who does the work: "Models: …" with the harness presets, "Model: …" without (a provider with no advisor). */
const modelChip = () => document.querySelector<HTMLElement>(".model-picker:not(.provider-picker) .model-button")!;
const openMode = () => fireEvent.click(document.querySelector<HTMLElement>(".mode-chip")!);
const openProvider = () => fireEvent.click(within(document.querySelector<HTMLElement>(".provider-picker")!).getByRole("button"));

beforeEach(() => {
  vi.resetModules();
  clearMocks();
  localStorage.clear();
  localStorage.setItem("settings.lastFolder", JSON.stringify(FOLDER));
  calls = [];
});
afterEach(cleanup);

describe("with one provider", () => {
  it("has no provider chip, says Claude, and starts the chat as it always did", async () => {
    await launch(false);
    expect(document.querySelector(".provider-picker")).toBeNull();
    expect(chip(/^Runs on/)).toBeNull();
    expect(screen.getByRole("textbox", { name: "Message to Claude" })).toBeInTheDocument();
    const [start] = started();
    expect(start.claudePath).toBe("/Users/you/.local/bin/claude");
    // Nothing about providers goes with the start, as for a window that has never heard of them.
    expect(Object.keys(start.settings).sort()).toEqual(["advisor", "auto_approve", "effort", "mode", "model", "subagent_model"]);
    openMode();
    expect(pickable()).toEqual(["Ask", "Auto"]);
  });

  it("ignores a provider saved for the folder that isn't installed, and loads as Claude", async () => {
    localStorage.setItem("settings.providerByFolder", JSON.stringify({ [FOLDER]: "codex" }));
    await launch(false);
    expect(started()[0].settings.provider).toBeUndefined();
    expect(started()[0].claudePath).toBe("/Users/you/.local/bin/claude");
  });

  it("loads state saved before there was a choice of provider as Claude's, and has the harness, effort and slash commands", async () => {
    localStorage.setItem("settings.permissionsByFolder", JSON.stringify({ [FOLDER]: "auto" }));
    localStorage.setItem("settings.model", JSON.stringify("sonnet"));
    localStorage.setItem("settings.effort", JSON.stringify("high"));
    await launch(false);
    expect(started()[0].settings).toMatchObject({ mode: "auto", model: "sonnet", effort: "high", auto_approve: false });
    expect(modelChip().title).toMatch(/^Models: .* · Effort High$/);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/" } });
    await screen.findByRole("listbox", { name: "Commands" });
  });
});

describe("with two providers", () => {
  it("offers the choice in a new chat, beside the model, and starts on Claude to begin with", async () => {
    await launch(true);
    expect(chip("Runs on Claude")).toBeInTheDocument();
    expect(modelChip().title).toMatch(/^Models: /);
    openProvider();
    expect(rows()).toEqual(["Claude", "Codex"]);
    // What Codex lacks is said where the choice is made.
    expect(screen.getByRole("menuitemradio", { name: /Codex/ })).toHaveTextContent("No auto mode, advisor, skills or dollar cost");
    expect(started()).toHaveLength(1);
    expect(started()[0].settings.provider).toBeUndefined();
  });

  it("moves the empty chat to the other provider: its models, copy and limits follow, and the choice is kept for the folder", async () => {
    await launch(true);
    openProvider();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Codex/ }));
    await screen.findByPlaceholderText("Ask Codex…");
    await waitFor(() => expect(started()).toHaveLength(2));
    // It starts the other CLI: its program, and the provider named; the model and effort are its own (not Claude's).
    expect(started()[1].claudePath).toBe(CODEX);
    expect(started()[1].settings).toMatchObject({ provider: "codex", mode: "ask", model: null, advisor: null, subagent_model: null, auto_approve: false });
    expect(chip("Runs on Codex")).toBeInTheDocument();
    // Its models, as it lists them.
    // No harness presets (Codex has no advisor), but effort, and its own models.
    await waitFor(() => expect(modelChip().title).toMatch(/^Model: .* · Effort /));
    fireEvent.click(modelChip());
    // Its models, then the effort levels it takes.
    await waitFor(() => expect(rows()).toEqual(["Default (gpt-5-codex)", "gpt-5-codex", "gpt-5", "o3", "Default", "Low", "Medium", "High"]));
    expect(screen.getAllByRole("menuitemradio", { name: /Default/ })[0]).toHaveTextContent("Codex's setting");
    fireEvent.keyDown(document, { key: "Escape" });
    // Auto is there but off, and says why; no slash menu.
    openMode();
    expect(pickable()).toEqual(["Ask"]);
    expect(screen.getByRole("menuitemradio", { name: /Auto/ })).toHaveTextContent("Codex has no Auto mode");
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/" } });
    expect(screen.queryByRole("listbox")).toBeNull();
    // Kept like the other per-folder settings.
    expect(JSON.parse(localStorage.getItem("settings.providerByFolder") ?? "{}")).toEqual({ [FOLDER]: "codex" });
  });

  it("goes back to Claude with all of Claude's controls", async () => {
    await launch(true);
    openProvider();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Codex/ }));
    await screen.findByPlaceholderText("Ask Codex…");
    await waitFor(() => expect(chip("Runs on Codex")).toBeInTheDocument());
    openProvider();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Claude/ }));
    await screen.findByPlaceholderText("Ask Claude…");
    await waitFor(() => expect(started()).toHaveLength(3));
    expect(started()[2].settings.provider).toBeUndefined();
    expect(started()[2].claudePath).toBe("/Users/you/.local/bin/claude");
    expect(modelChip().title).toMatch(/^Models: /);
    openMode();
    expect(pickable()).toEqual(["Ask", "Auto"]);
  });

  it("starts the project's next chats on the provider it was left on", async () => {
    localStorage.setItem("settings.providerByFolder", JSON.stringify({ [FOLDER]: "codex" }));
    await launch(true, "Ask Codex…");
    expect(started()).toHaveLength(1);
    expect(started()[0].claudePath).toBe(CODEX);
    expect(started()[0].settings.provider).toBe("codex");
    expect(chip("Runs on Codex")).toBeInTheDocument();
  });

  it("starts a project saved on Auto on Ask for a provider with no auto mode, without forgetting Auto for Claude", async () => {
    localStorage.setItem("settings.providerByFolder", JSON.stringify({ [FOLDER]: "codex" }));
    localStorage.setItem("settings.permissionsByFolder", JSON.stringify({ [FOLDER]: "auto" }));
    await launch(true, "Ask Codex…");
    expect(started()[0].settings).toMatchObject({ mode: "ask", auto_approve: false });
    // The project is still on Auto for the next Claude chat.
    await waitFor(() => expect(screen.getByRole("button", { name: /^Permissions: Ask/ })).toBeInTheDocument());
    expect(JSON.parse(localStorage.getItem("settings.permissionsByFolder") ?? "{}")).toEqual({ [FOLDER]: "auto" });
  });

  it("keeps the model chosen for a provider apart from the other's", async () => {
    localStorage.setItem("settings.model", JSON.stringify("sonnet"));
    localStorage.setItem("settings.providerPrefs", JSON.stringify({ codex: { model: "o3", effort: "low" } }));
    localStorage.setItem("settings.providerByFolder", JSON.stringify({ [FOLDER]: "codex" }));
    await launch(true, "Ask Codex…");
    expect(started()[0].settings).toMatchObject({ provider: "codex", model: "o3", effort: "low" });
    openProvider();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Claude/ }));
    await waitFor(() => expect(started()).toHaveLength(2));
    expect(started()[1].settings).toMatchObject({ model: "sonnet" });
    expect(started()[1].settings.provider).toBeUndefined();
  });

  it("shows Team off for a Codex chat, with why: a team's Lead runs on Claude Code", async () => {
    localStorage.setItem("settings.providerByFolder", JSON.stringify({ [FOLDER]: "codex" }));
    await launch(true, "Ask Codex…");
    fireEvent.click(screen.getByRole("button", { name: /^Workflow: Chat/ }));
    const team = screen.getByRole("menuitemradio", { name: /^Team/ });
    expect(team).toBeDisabled();
    expect(team).toHaveTextContent("Codex can't lead a team yet");
  });

  it("starts a new team's Lead on Claude Code in a project whose chats are on Codex", async () => {
    localStorage.setItem("settings.providerByFolder", JSON.stringify({ [FOLDER]: "codex" }));
    await launch(true, "Ask Codex…");
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    // (The first of "Team" and "Team from a template…".)
    fireEvent.click(screen.getAllByRole("menuitem", { name: /^Team/ })[0]);
    await waitFor(() => expect(started()).toHaveLength(2));
    expect(started()[1].claudePath).toBe("/Users/you/.local/bin/claude");
    expect(started()[1].settings.provider).toBeUndefined();
    expect(started()[1].settings.orchestrator).toBe(true);
    // The project's chats stay on Codex: a team is the chat's own.
    expect(JSON.parse(localStorage.getItem("settings.providerByFolder") ?? "{}")).toEqual({ [FOLDER]: "codex" });
  });

  it("shows no provider chip once the chat has begun, and counts what a Codex turn used in tokens, never dollars", async () => {
    localStorage.setItem("settings.providerByFolder", JSON.stringify({ [FOLDER]: "codex" }));
    await launch(true, "Ask Codex…");
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "retry on 503" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByRole("button", { name: "Stop" });
    expect(document.querySelector(".provider-picker")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }, { timeout: 10_000 }));
    await screen.findByRole("button", { name: "Send" }, { timeout: 20_000 });
    expect(document.querySelector(".turn-usage")?.textContent).toBe("18k tokens");
    expect(document.querySelector(".turn-note")?.textContent).not.toContain("$");
    fireEvent.mouseEnter(document.querySelector(".context-meter")!);
    expect(document.querySelector(".context-meter")?.getAttribute("title")).toContain("This chat so far: 18k tokens");
  }, 40_000);

  it("reopens a session on the provider it ran on, from History", async () => {
    localStorage.setItem("settings.providerBySession", JSON.stringify({ "3f1c2a": "codex" }));
    await launch(true);
    fireEvent.click(screen.getByRole("button", { name: /Continue a session|Sessions|History/i }));
    fireEvent.click(await screen.findByText("Fix the login redirect after OAuth callback"));
    await waitFor(() => expect(calls.some(([cmd]) => cmd === "open_session")).toBe(true));
    const open = calls.find(([cmd]) => cmd === "open_session")![1] as { claudePath: string; settings: Record<string, unknown> };
    expect(open.claudePath).toBe(CODEX);
    expect(open.settings.provider).toBe("codex");
    expect(open.settings.mode).toBe("ask");
  });
});
