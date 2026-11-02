import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach } from "vitest";

// The editor isn't needed here, and doesn't load in jsdom.
vi.mock("./monaco", () => ({ LIGHT_THEME: "lantern-light", DARK_THEME: "lantern-dark" }));
vi.mock("@monaco-editor/react", () => ({ default: () => null, DiffEditor: () => null, loader: { config: () => {} } }));

/**
 * The window with the mock backend and one endpoint set up ("Ollama", with two models) beside Claude Code: an endpoint is its
 * own choice of where a chat runs, and is Claude Code sent elsewhere, so it has the skills and none of Anthropic's extras.
 */

const FOLDER = "/Users/you/projects/acme-api";
const CLAUDE = "/Users/you/.local/bin/claude";

type Call = [string, Record<string, unknown>];
let calls: Call[] = [];

async function launch(placeholder = "Ask Claude…", options: { providers?: boolean } = {}) {
  const { installMockBackend } = await import("./dev/mockBackend");
  installMockBackend({ providers: options.providers ?? false, endpoints: true });
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  const real = internals.invoke;
  internals.invoke = (cmd, args, opts) => {
    calls.push([cmd, args ?? {}]);
    return real(cmd, args, opts);
  };
  const { default: App } = await import("./App");
  render(<App />);
  await screen.findByPlaceholderText(placeholder);
  await waitFor(() => expect(document.querySelector(".model-button")).not.toBeNull());
}

type Start = { claudePath: string; settings: Record<string, unknown> };
const started = () => calls.filter(([cmd]) => cmd === "start_session").map(([, a]) => a as unknown as Start);
const opened = () => calls.filter(([cmd]) => cmd === "open_session").map(([, a]) => a as unknown as Start);
const rows = () => screen.getAllByRole("menuitemradio").map((r) => r.querySelector(".menu-row-title")?.textContent);
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

describe("with an endpoint set up", () => {
  it("offers it beside Claude as a choice of its own, by the name the user gave it", async () => {
    await launch();
    expect(screen.getByTitle("Runs on Claude")).toBeInTheDocument();
    openProvider();
    expect(rows()).toEqual(["Claude", "Ollama"]);
    expect(screen.getByRole("menuitemradio", { name: /Ollama/ })).toHaveTextContent("No auto mode, advisor");
    // Still Claude's own chat, started as it always was: nothing about an endpoint goes with it.
    expect(started()).toHaveLength(1);
    expect(started()[0].settings.provider).toBeUndefined();
    expect(started()[0].settings.endpoint).toBeUndefined();
  });

  it("starts the chat on Claude Code sent to that endpoint, on its first model, and the chat says what that can't do", async () => {
    await launch();
    openProvider();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Ollama/ }));
    await screen.findByPlaceholderText("Ask Ollama…");
    await waitFor(() => expect(started()).toHaveLength(2));
    // The program is Claude Code's, which the window found; the endpoint and its model are named; the harness is none.
    expect(started()[1].claudePath).toBe(CLAUDE);
    expect(started()[1].settings).toMatchObject({ provider: "gateway", endpoint: "ollama", mode: "ask", model: "qwen3:8b", effort: null, auto_approve: false });
    expect(started()[1].settings.advisor ?? null).toBeNull();
    expect(screen.getByTitle("Runs on Ollama")).toBeInTheDocument();
    // Kept for the project under the endpoint's own name.
    expect(JSON.parse(localStorage.getItem("settings.providerByFolder") ?? "{}")).toEqual({ [FOLDER]: "gateway:ollama" });
    // No Auto, and why; no Team, and why: a Lead is Claude Code's.
    openMode();
    expect(screen.getByRole("menuitemradio", { name: /Auto/ })).toHaveTextContent("Ollama has no Auto mode");
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: /^Workflow: Chat/ }));
    expect(screen.getByRole("menuitemradio", { name: /^Team/ })).toHaveTextContent("Ollama can't lead a team yet");
  });

  it("lists the endpoint's own models, never Claude's and never a Default that isn't there", async () => {
    await launch();
    openProvider();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Ollama/ }));
    await screen.findByPlaceholderText("Ask Ollama…");
    // Its session says Claude's models (it is Claude Code); the picker shows what the endpoint has.
    await waitFor(() => expect(modelChip().title).toMatch(/qwen3:8b/));
    fireEvent.click(modelChip());
    await waitFor(() => expect(rows()).toEqual(["qwen3:8b", "llama3"]));
    expect(modelChip().title).not.toMatch(/Opus|Sonnet|Haiku/i);
  });

  /** Claude Code prices a model it doesn't know with a made-up figure (its result says `costBasis: unknown`): a chat on an endpoint shows tokens only. */
  it("counts what a turn used in tokens, never in dollars", async () => {
    localStorage.setItem("settings.providerByFolder", JSON.stringify({ [FOLDER]: "gateway:ollama" }));
    await launch("Ask Ollama…");
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "retry on 503" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByRole("button", { name: "Stop" });
    // Provider changes stay visible, but cannot interrupt a running turn.
    expect(document.querySelector(".provider-picker button")).toBeDisabled();
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }, { timeout: 10_000 }));
    await screen.findByRole("button", { name: "Send" }, { timeout: 20_000 });
    expect(document.querySelector(".turn-usage")?.textContent).toMatch(/tokens$/);
    expect(document.querySelector(".turn-usage")?.textContent).not.toContain("$");
    expect(document.querySelector(".turn-note")?.textContent ?? "").not.toContain("$");
    fireEvent.mouseEnter(document.querySelector(".context-meter")!);
    expect(document.querySelector(".context-meter")?.getAttribute("title")).toContain("This chat so far:");
    expect(document.querySelector(".context-meter")?.getAttribute("title")).not.toContain("$");
  }, 40_000);

  it("switches to another of its models by that model's own id", async () => {
    await launch();
    openProvider();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Ollama/ }));
    await screen.findByPlaceholderText("Ask Ollama…");
    await waitFor(() => expect(modelChip().title).toMatch(/qwen3:8b/));
    fireEvent.click(modelChip());
    await waitFor(() => expect(rows()).toEqual(["qwen3:8b", "llama3"]));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /llama3/ }));
    await waitFor(() => expect(calls.some(([cmd, a]) => cmd === "set_model" && a.model === "llama3")).toBe(true));
    expect(JSON.parse(localStorage.getItem("settings.providerPrefs") ?? "{}")["gateway:ollama"]).toMatchObject({ model: "llama3" });
  });

  it("starts the project's next chats on the endpoint it was left on", async () => {
    localStorage.setItem("settings.providerByFolder", JSON.stringify({ [FOLDER]: "gateway:ollama" }));
    await launch("Ask Ollama…");
    expect(started()[0].settings).toMatchObject({ provider: "gateway", endpoint: "ollama", model: "qwen3:8b" });
  });

  /** Only a NEW chat falls back (it shows Claude's chip, so nothing is hidden); a chat that already ran there never does (below). */
  it("starts a new chat on Claude when the project's endpoint has been deleted", async () => {
    localStorage.setItem("settings.providerByFolder", JSON.stringify({ [FOLDER]: "gateway:deleted" }));
    await launch("Ask Claude…");
    expect(started()[0].settings.provider).toBeUndefined();
    expect(screen.getByTitle("Runs on Claude")).toBeInTheDocument();
  });

  it("reopens a session on its endpoint, from History", async () => {
    localStorage.setItem("settings.providerBySession", JSON.stringify({ "3f1c2a": "gateway:ollama" }));
    await launch();
    fireEvent.click(screen.getByRole("button", { name: /Continue a session|Sessions|History/i }));
    fireEvent.click(await screen.findByText("Fix the login redirect after OAuth callback"));
    await waitFor(() => expect(opened()).toHaveLength(1));
    expect(opened()[0].claudePath).toBe(CLAUDE);
    expect(opened()[0].settings).toMatchObject({ provider: "gateway", endpoint: "ollama", model: "qwen3:8b", mode: "ask" });
  });

  /** A chat that ran on an endpoint that was since deleted never reopens on Claude: its words would go where its user didn't choose. */
  it("will not reopen a session on Claude when its endpoint has been deleted, and says so", async () => {
    localStorage.setItem("settings.providerBySession", JSON.stringify({ "3f1c2a": "gateway:deleted" }));
    await launch();
    fireEvent.click(screen.getByRole("button", { name: /Continue a session|Sessions|History/i }));
    fireEvent.click(await screen.findByText("Fix the login redirect after OAuth callback"));
    await screen.findByText(/isn't set up any more, so this chat can't be reopened/);
    expect(opened()).toEqual([]);
  });

  it("is not offered to a team's agents (an agent on an endpoint comes with mixed teams)", async () => {
    // Two CLIs and an endpoint: the agent form lists the CLIs only.
    const { providerChoicesForAgents } = await import("./lib/provider");
    const { CLAUDE_LISTING, PLAIN_LISTING } = await import("./testProviders");
    const gateway = { ...CLAUDE_LISTING, id: "gateway:ollama", endpoint: { id: "ollama", name: "Ollama" } };
    expect(providerChoicesForAgents([CLAUDE_LISTING, PLAIN_LISTING, gateway]).map((l) => l.id)).toEqual(["claude", "codex"]);
  });
});
