import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, render, screen, waitFor } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";

// These render the whole app against the mock backend, which a loaded CI runner can take longer than vitest's default 5 s to do.
vi.setConfig({ testTimeout: 60_000 });
configure({ asyncUtilTimeout: 20_000 });

// The editor isn't needed here, and doesn't load in jsdom.
vi.mock("./monaco", () => ({ LIGHT_THEME: "lantern-light", DARK_THEME: "lantern-dark" }));
vi.mock("@monaco-editor/react", () => ({ default: () => null, DiffEditor: () => null, loader: { config: () => {} } }));

/**
 * A chat's model, effort or provider changed in place (a phone's chat settings): what the window makes of it. On Standard the
 * change is the provider's own (every Standard chat's); on a preset it is that chat's alone (Custom); on another provider the
 * preset is gone, as the backend dropped its advisor and subagents.
 */

const FOLDER = "/Users/you/projects/acme-api";
const CLAUDE = { id: "claude", capabilities: { supports_auto_mode: true, supports_advisor: true, reports_cost_usd: true, supports_skills: true, supports_effort: true, model_switchable: true, supports_lantern_tools: true, can_lead_team: true, phone_approvals: true } };
const CODEX = { id: "codex", capabilities: { supports_auto_mode: false, supports_advisor: false, reports_cost_usd: false, supports_skills: false, supports_effort: true, model_switchable: true, supports_lantern_tools: true, can_lead_team: false, phone_approvals: false } };

type Call = [string, Record<string, unknown>];
let calls: Call[] = [];

async function launch() {
  const { installMockBackend } = await import("./dev/mockBackend");
  installMockBackend({ providers: true });
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  const real = internals.invoke;
  internals.invoke = (cmd, args, options) => {
    calls.push([cmd, args ?? {}]);
    return real(cmd, args, options);
  };
  const { default: App } = await import("./App");
  render(<App />);
  await screen.findByRole("button", { name: /^Permissions: / });
  await waitFor(() => expect(calls.some(([c]) => c === "start_session")).toBe(true));
  return String(calls.find(([c]) => c === "start_session")![1].slot);
}

const configured = (slot: string, provider: typeof CLAUDE, model: string | null, effort: string | null) =>
  (globalThis as unknown as { mockEmit: (e: string, p?: unknown) => Promise<void> }).mockEmit("conversation-configured", { slot, provider, mode: "ask", autoApprove: false, model, effort });
const saved = <T,>(key: string): T | null => JSON.parse(localStorage.getItem(key) ?? "null");
const chipTitle = () => document.querySelector<HTMLElement>(".model-picker:not(.provider-picker) .model-button")?.title ?? "";
/** The settings the chat's next preset switch (a restart) starts claude with. */
const presetCalls = () => calls.filter(([c]) => c === "apply_preset");

beforeEach(() => {
  vi.resetModules();
  clearMocks();
  localStorage.clear();
  localStorage.setItem("settings.lastFolder", JSON.stringify(FOLDER));
  calls = [];
});
afterEach(cleanup);

describe("a chat's model changed in place", () => {
  it("on Standard, is Claude's model for every Standard chat, as before", async () => {
    const slot = await launch();
    await configured(slot, CLAUDE, "opus", "high");
    await waitFor(() => expect(saved("settings.model")).toBe("opus"));
    expect(saved("settings.effort")).toBe("high");
  });

  it("on a preset, makes that chat Custom and leaves the app's model and the project's preset alone", async () => {
    localStorage.setItem("settings.harnessByFolder", JSON.stringify({ [FOLDER]: "balanced" }));
    localStorage.setItem("settings.model", JSON.stringify("haiku"));
    const slot = await launch();
    await waitFor(() => expect(chipTitle()).toContain("Balanced"));
    await configured(slot, CLAUDE, "opus", "high");
    await waitFor(() => expect(chipTitle()).toMatch(/Custom \(Balanced, changed\)/));
    const custom = saved<{ id: string; model: string; effort: string; advisor: string }[]>("settings.harnessPresets")?.find((h) => h.id === "custom");
    expect(custom).toMatchObject({ model: "opus", effort: "high", advisor: "opus", from: "Balanced" });
    expect(saved("settings.model")).toBe("haiku");
    expect(saved<Record<string, string>>("settings.harnessByFolder")?.[FOLDER]).toBe("balanced");
    // Nothing restarts: the backend has already applied it.
    expect(presetCalls()).toHaveLength(0);
  });

  it("on a preset, changes nothing when the model and effort are the preset's own", async () => {
    localStorage.setItem("settings.harnessByFolder", JSON.stringify({ [FOLDER]: "balanced" }));
    const slot = await launch();
    await waitFor(() => expect(chipTitle()).toContain("Balanced"));
    await configured(slot, CLAUDE, "sonnet", "high");
    await new Promise((r) => setTimeout(r, 300));
    expect(chipTitle()).toContain("Balanced");
    expect(chipTitle()).not.toContain("Custom");
  });

  it("on another provider, leaves the preset behind, so coming back to Claude is Standard", async () => {
    localStorage.setItem("settings.harnessByFolder", JSON.stringify({ [FOLDER]: "balanced" }));
    const slot = await launch();
    await waitFor(() => expect(chipTitle()).toContain("Balanced"));
    await configured(slot, CODEX, "gpt-5-codex", null);
    // (On Codex the chip has no presets at all.)
    await waitFor(() => expect(chipTitle()).not.toContain("Balanced"));
    await configured(slot, CLAUDE, null, null);
    await waitFor(() => expect(chipTitle()).toMatch(/^Model: /));
    // Standard is no preset at all: the chip names none.
    expect(chipTitle()).not.toContain("Preset:");
    expect(saved<Record<string, string>>("settings.harnessByFolder")?.[FOLDER]).toBe("balanced");
  });
});
