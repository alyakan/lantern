import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatsReducer, initialChats } from "./sessions";
import { initialState, type State } from "./store";
import type { ModelOption } from "./types";
import { BUILT_IN } from "./lib/harness";
import { ChatStoreContext, createChatStore, NodeActionsContext, type NodeActions } from "./lib/canvasContext";
import { orchestraNodes } from "./lib/orchestraView";
import { Canvas, newLayout } from "./components/Canvas";
import { MessageInput } from "./components/MessageInput";
import { PermissionsMenu, WorkflowMenu } from "./components/ModeMenu";
import { ModelsPicker } from "./components/ModelsPicker";
import { NewAgent } from "./components/NewAgent";

// The editor isn't needed here, and doesn't load in jsdom.
vi.mock("./monaco", () => ({ LIGHT_THEME: "lantern-light", DARK_THEME: "lantern-dark" }));
vi.mock("@monaco-editor/react", () => ({ default: () => null, DiffEditor: () => null, loader: { config: () => {} } }));

/**
 * What a user with only Claude Code sees, pinned. A chat can run on another agent CLI, and with one provider the window
 * must look and behave exactly as it did before: these snapshots were taken on the window before it knew of providers, and
 * a change to any of them is a change to what every Claude-only user sees.
 */

afterEach(cleanup);

const MODELS: ModelOption[] = [
  { value: "default", resolved_model: "claude-opus-5-5", display_name: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks", effort_levels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "opus", resolved_model: "claude-opus-5-5", display_name: "Opus 5.5", description: "For complex work and everyday tasks", effort_levels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "sonnet", resolved_model: "claude-sonnet-5-5", display_name: "Sonnet 5.5", description: "Most efficient for simpler tasks", effort_levels: ["low", "medium", "high", "xhigh", "max"] },
];

describe("single provider: the menus", () => {
  it("permissions and workflow", () => {
    const { container } = render(
      <>
        <PermissionsMenu permissions="ask" onChange={() => {}} />
        <WorkflowMenu workflow="chat" onChange={() => {}} />
      </>,
    );
    expect(container).toMatchSnapshot("closed");
    fireEvent.click(screen.getByRole("button", { name: /^Permissions/ }));
    expect(container).toMatchSnapshot("permissions open");
  });

  it("models, with Claude's list and with the built-in short list", () => {
    const withList = render(<ModelsPicker running="claude-opus-5-5" chosen={null} options={MODELS} effort={{ chosen: "high", levels: ["low", "high"], onChoose: () => {} }} presets={BUILT_IN} preset="default" onPreset={() => {}} onChoose={() => {}} />);
    expect(withList.container).toMatchSnapshot("closed");
    fireEvent.click(withList.container.querySelector("button.model-button")!);
    expect(withList.container).toMatchSnapshot("presets");
    fireEvent.click(screen.getByRole("menuitem", { name: /Customize/ }));
    expect(withList.container).toMatchSnapshot("customize");
    cleanup();
    const builtIn = render(<ModelsPicker running={null} chosen="sonnet" defaultModel="claude-opus-5-5" ids={{ sonnet: "claude-sonnet-5-5" }} onChoose={() => {}} />);
    fireEvent.click(builtIn.container.querySelector("button.model-button")!);
    expect(builtIn.container).toMatchSnapshot("built-in open");
  });
});

describe("single provider: the chat box", () => {
  const props = {
    status: "idle" as const,
    onSend: () => {},
    onStop: () => {},
    permissions: "ask" as const,
    onPermissionsChange: () => {},
    workflow: "chat" as const,
    onWorkflowChange: () => {},
    model: "claude-opus-5-5",
    branch: "main",
    models: { chosen: null, onChoose: () => {}, options: MODELS },
    effort: { chosen: "high", onChoose: () => {} },
    harness: { presets: BUILT_IN, chosen: "default", onChoose: () => {} },
    usage: { used: 61_480, window: 200_000, lastTurnMs: 8_200, session: { cost: 0.9, tokens: 400_000 }, actions: { onCompact: () => {}, onClear: () => {} } },
    commands: [{ name: "compact", description: "Clear conversation history but keep a summary", argument_hint: "" }],
  };

  it("the footer and meta line", () => {
    const { container } = render(<MessageInput {...props} />);
    expect(container).toMatchSnapshot();
  });

  it("what the box says in each state", () => {
    const say = (status: "no_folder" | "starting" | "ended" | "running" | "idle") => {
      const { container, unmount } = render(<MessageInput status={status} onSend={() => {}} onStop={() => {}} />);
      const box = container.querySelector("textarea")!;
      const out = [box.getAttribute("placeholder"), box.getAttribute("aria-label")];
      unmount();
      return out;
    };
    expect(["no_folder", "starting", "ended", "running", "idle"].map((s) => say(s as never))).toMatchSnapshot();
  });

  it("the slash menu lists Claude's commands", () => {
    render(<MessageInput {...props} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/" } });
    expect(document.querySelector("[role=listbox]")).toMatchSnapshot();
  });
});

describe("single provider: a team's canvas", () => {
  const actions = { spawn: vi.fn(() => Promise.resolve()), draft: () => "", setDraft: () => {} } as unknown as NodeActions;
  const lead: State = { ...initialState, status: "idle", claudePath: "/bin/claude", folder: "/p", orchestrator: true, mode: "auto" };

  it("the cards' meta lines and the team list", () => {
    let c = initialChats(lead);
    c = chatsReducer(c, { type: "in", slot: "s1", action: { type: "ui_event", event: { kind: "agent_spawned", worker: "w1", name: "Login form", brief: "Build it", folder: "/wt/w1", branch: "lantern/login-form", base: "main", isolation: "worktree", mode: "ask" } } });
    const turn = { kind: "turn_done" as const, is_error: false, result: null, cost_usd: 0.42, tokens: 9_000, session_cost_usd: 0.42, session_tokens: 9_000, duration_ms: 1000, auth_hint: false, denied: 0, context_window: 200_000 };
    c = chatsReducer(c, { type: "in", slot: "s1", action: { type: "ui_event", event: turn } });
    c = chatsReducer(c, { type: "in", slot: "w1", action: { type: "ui_event", event: { ...turn, cost_usd: 0.1, session_cost_usd: 0.1 } } });
    const store = createChatStore();
    store.set(c.slots);
    const { container } = render(
      <ChatStoreContext.Provider value={store}>
        <NodeActionsContext.Provider value={actions}>
          <Canvas nodes={orchestraNodes(c, () => "Lead")} layout={newLayout()} activeSlot="s1" attention={[]} onFocus={() => {}} onOpen={() => {}} />
        </NodeActionsContext.Provider>
      </ChatStoreContext.Provider>,
    );
    expect([...container.querySelectorAll(".node-meta-text")].map((m) => m.textContent)).toMatchSnapshot("meta");
    fireEvent.click(screen.getByRole("button", { name: /^Team/ }));
    expect(container.querySelector(".canvas-team-list")).toMatchSnapshot("team list");
  });

  it("the + Agent form", () => {
    const store = createChatStore();
    store.set({ s1: lead });
    render(
      <ChatStoreContext.Provider value={store}>
        <NodeActionsContext.Provider value={actions}>
          <NewAgent main="s1" />
        </NodeActionsContext.Provider>
      </ChatStoreContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "+ Agent" }));
    expect(screen.getByRole("dialog", { name: "New agent" })).toMatchSnapshot();
  });
});

describe("single provider: the whole window", () => {
  const FOLDER = "/Users/you/projects/acme-api";

  beforeEach(() => {
    vi.resetModules();
    clearMocks();
    localStorage.clear();
    localStorage.setItem("settings.lastFolder", JSON.stringify(FOLDER));
  });

  it("the empty chat's box, and what a turn leaves", async () => {
    const { installMockBackend } = await import("./dev/mockBackend");
    installMockBackend();
    const { default: App } = await import("./App");
    render(<App />);
    await screen.findByPlaceholderText("Ask Claude…");
    // Once Claude has said which model it runs: before that the chip says "Default", and the snapshot raced it.
    await waitFor(() => expect(document.querySelector(".model-button")?.textContent).toContain("Opus 5.5"));
    expect(document.querySelector(".composer")).toMatchSnapshot("composer");
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "retry on 503" } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }, { timeout: 10_000 }));
    await screen.findByRole("button", { name: "Send" }, { timeout: 20_000 });
    expect(document.querySelector(".turn-note")?.textContent ?? null).toMatchSnapshot("turn note");
    expect(document.querySelector(".context-meter")?.getAttribute("title") ?? null).toMatchSnapshot("meter");
  }, 30_000);
});
