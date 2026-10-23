import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatsReducer, initialChats } from "./sessions";
import { initialState, reducer, type ChatItem, type State } from "./store";
import type { ModelOption, UiEvent } from "./types";
import { BUILT_IN } from "./lib/harness";
import { ChatStoreContext, createChatStore, NodeActionsContext, type NodeActions } from "./lib/canvasContext";
import { orchestraNodes } from "./lib/orchestraView";
import { Canvas, newLayout } from "./components/Canvas";
import { MessageInput } from "./components/MessageInput";
import { ModeGuide } from "./components/ModeGuide";
import { PermissionsMenu } from "./components/ModeMenu";
import { ModelsPicker } from "./components/ModelsPicker";
import { SettingsView } from "./components/SettingsView";
import { CLAUDE_INFO, CLAUDE_LISTING, PLAIN, PLAIN_LISTING } from "./testProviders";
import { MODEL_CHOICES, modelChoicesFor, modelLabel, modelOptionsFor } from "./lib/models";
import { ProvidersContext, choicesOf } from "./lib/provider";
import { NewAgent } from "./components/NewAgent";
import { ProviderPicker, lacks } from "./components/ProviderPicker";
import { ChatView } from "./components/ChatView";
import { activityStatus } from "./lib/status";
import { attentionFor } from "./lib/attention";

// The settings pages talk to the backend; none of that is wanted here.
vi.mock("./api", async (real) => ({ ...(await real<typeof import("./api")>()), api: { claudeRequest: () => Promise.resolve({}), skillIndex: () => Promise.resolve([]) } }));

/**
 * Two providers: Claude Code (every capability) and one without an auto mode, advisor, skills or dollar cost. What the second
 * hasn't got is not on screen for its chats; Claude's chats keep all of it.
 */

afterEach(cleanup);

const MODELS: ModelOption[] = [{ value: "default", resolved_model: "claude-opus-5-5", display_name: "Default", description: "", effort_levels: ["low", "high"] }];
const COMMANDS = [{ name: "compact", description: "Summarise", argument_hint: "" }, { name: "review", description: "Review the diff", argument_hint: "" }];

const box = (provider: typeof PLAIN | null) => (
  <MessageInput
    status="idle"
    provider={provider}
    onSend={() => {}}
    onStop={() => {}}
    permissions="ask"
    onPermissionsChange={() => {}}
    models={{ chosen: null, onChoose: () => {}, options: MODELS }}
    effort={{ chosen: null, onChoose: () => {} }}
    harness={{ presets: BUILT_IN, chosen: "default", onChoose: () => {} }}
    usage={{ used: 1000, window: 200_000, lastTurnMs: null, actions: { onCompact: () => {}, onClear: () => {} }, session: { cost: null, tokens: 5000 } }}
    commands={COMMANDS}
    findFiles={() => Promise.resolve([{ path: "/p/src/net/fetchJson.ts", rel: "src/net/fetchJson.ts", hits: [] }])}
    mcpIssues={[{ name: "linear", problem: "needs you to log in" }]}
  />
);

/** The chip for who does the work: "Models: …" with the harness presets, "Model: …" without. */
const modelChip = () => document.querySelector<HTMLElement>(".model-picker:not(.provider-picker) .model-button")!;

describe("the Permissions choices", () => {
  const pickable = () => screen.getAllByRole("menuitemradio").filter((r) => !(r as HTMLButtonElement).disabled).map((r) => r.querySelector(".menu-row-title")?.textContent);

  it("has Auto off, saying why, where the provider has no auto mode, and on where it has", () => {
    render(<PermissionsMenu permissions="ask" onChange={() => {}} auto={false} agent="Codex" />);
    fireEvent.click(screen.getByRole("button", { name: /^Permissions/ }));
    expect(pickable()).toEqual(["Ask"]);
    expect(screen.getByRole("menuitemradio", { name: /Auto/ })).toHaveTextContent("Codex has no Auto mode");
    cleanup();
    render(<PermissionsMenu permissions="ask" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^Permissions/ }));
    expect(pickable()).toEqual(["Ask", "Auto"]);
  });

  it("leaves Auto out of the guide for a provider without it, and opens a guide asked for Auto on Ask's page", () => {
    render(<ModeGuide open="auto" permissions="ask" workflow="chat" flavour={null} onClose={() => {}} auto={false} />);
    expect(screen.getByRole("heading", { name: "Ask" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Auto" })).toBeNull();
    cleanup();
    render(<ModeGuide open="auto" permissions="ask" workflow="chat" flavour={null} onClose={() => {}} />);
    expect(screen.getByRole("heading", { name: "Auto" })).toBeInTheDocument();
  });
});

describe("the chat box, per provider", () => {
  it("offers a Claude chat effort, the harness presets, the slash menu and its context actions", () => {
    render(box(CLAUDE_INFO));
    expect(modelChip().title).toMatch(/^Models: .* · Effort /);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/" } });
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeInTheDocument();
    expect(screen.getByText("needs you to log in", { exact: false })).toBeInTheDocument();
  });

  it("treats a chat whose provider isn't known as Claude's", () => {
    render(box(null));
    expect(modelChip().title).toMatch(/^Models: /);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/" } });
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeInTheDocument();
  });

  it("gives a chat on the other provider no presets, no Auto, and no slash menu, but keeps effort, the model and file mentions", async () => {
    render(box(PLAIN));
    // No harness presets (they need an advisor), but effort, which the provider takes.
    expect(modelChip().title).toMatch(/^Model: .* · Effort /);
    // Auto is off in the Permissions menu.
    fireEvent.click(screen.getByRole("button", { name: /^Permissions/ }));
    expect(screen.getByRole("menuitemradio", { name: /Auto/ })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    // A "/" is just text: no menu, and no MCP login prompts that belong to it.
    const text = screen.getByRole("textbox");
    fireEvent.change(text, { target: { value: "/" } });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByText("needs you to log in", { exact: false })).toBeNull();
    // "@" still finds files.
    fireEvent.change(text, { target: { value: "@fet" } });
    expect(await screen.findByText(/fetchJson\.ts/)).toBeInTheDocument();
  });

  it("has no Compact and Clear (they are slash commands) for a provider without skills", () => {
    const usage = { used: 190_000, window: 200_000, lastTurnMs: null, actions: { onCompact: () => {}, onClear: () => {} } };
    const { container } = render(<MessageInput status="idle" provider={PLAIN} onSend={() => {}} onStop={() => {}} usage={usage} />);
    expect(container.querySelector(".context-compact")).toBeNull();
    cleanup();
    const claude = render(<MessageInput status="idle" provider={CLAUDE_INFO} onSend={() => {}} onStop={() => {}} usage={usage} />);
    expect(claude.container.querySelector(".context-compact")).not.toBeNull();
  });

  it("names the provider where the box talks about the agent, and says Claude for Claude and for none", () => {
    const say = (provider: typeof PLAIN | null, status: "idle" | "starting" | "ended") => {
      const { container, unmount } = render(<MessageInput status={status} provider={provider} onSend={() => {}} onStop={() => {}} />);
      const area = container.querySelector("textarea")!;
      const out = [area.getAttribute("placeholder"), area.getAttribute("aria-label")];
      unmount();
      return out;
    };
    expect(say(PLAIN, "idle")).toEqual(["Ask Codex…", "Message to Codex"]);
    expect(say(PLAIN, "starting")[0]).toBe("Starting Codex…");
    expect(say(PLAIN, "ended")[0]).toBe("Codex stopped — restart to continue");
    expect(say(CLAUDE_INFO, "idle")).toEqual(["Ask Claude…", "Message to Claude"]);
    expect(say(null, "ended")[0]).toBe("Claude stopped — restart to continue");
  });
});

describe("settings, per provider", () => {
  const tabs = (provider: typeof PLAIN | null) => {
    render(<SettingsView open="mcp" provider={provider} onClose={() => {}} slot="s1" live mcpTools={[]} commands={[]} harness={{ saved: BUILT_IN.slice(1), onSave: () => {}, folder: "/p", folderDefault: "default", onFolderDefault: () => {}, fallbackModel: null }} />);
    const names = [...document.querySelectorAll(".mode-guide-tab")].map((t) => t.textContent);
    cleanup();
    return names;
  };

  it("has Skills and the harness page for Claude, and neither for a provider with no skills and no advisor", () => {
    const claude = tabs(CLAUDE_INFO);
    expect(tabs(null)).toEqual(claude);
    expect(claude).toContain("Skills");
    const plain = tabs(PLAIN);
    expect(plain).not.toContain("Skills");
    expect(plain).toEqual(claude.filter((t) => t !== "Skills" && t !== claude[0]));
  });

  it("opens another page when asked for one its provider has none of", () => {
    render(<SettingsView open="skills" provider={PLAIN} onClose={() => {}} slot="s1" live mcpTools={[]} commands={[]} />);
    expect(document.querySelector(".mode-guide-tab.active")?.textContent).not.toBe("Skills");
  });
});

describe("what a team has used", () => {
  const done = (cost: number | null, tokens: number): UiEvent => ({ kind: "turn_done", is_error: false, result: null, cost_usd: cost, tokens, session_cost_usd: cost, session_tokens: tokens, duration_ms: 1, auth_hint: false, denied: 0, context_window: 200_000 });
  const spawned = (id: string, provider?: typeof PLAIN): UiEvent => ({ kind: "agent_spawned", worker: id, name: id.toUpperCase(), brief: "b", folder: `/wt/${id}`, branch: null, base: null, isolation: "shared", mode: "ask", ...(provider ? { provider } : {}) });
  const team = (providers: (typeof PLAIN | undefined)[]) => {
    let c = initialChats({ ...initialState, status: "idle", folder: "/p", orchestrator: true, provider: CLAUDE_INFO });
    providers.forEach((p, i) => {
      c = chatsReducer(c, { type: "in", slot: "s1", action: { type: "ui_event", event: spawned(`w${i + 1}`, p) } });
      // The other provider's turn says a price it doesn't have: it must not be counted.
      c = chatsReducer(c, { type: "in", slot: `w${i + 1}`, action: { type: "ui_event", event: done(p ? 0.9 : 0.1, 12_000) } });
    });
    return c;
  };

  it("counts dollars only for an agent whose provider reports them, and tokens for every agent", () => {
    const c = team([undefined, PLAIN]);
    expect(c.slots.w1.sessionCost).toBe(0.1);
    expect(c.slots.w2.sessionCost).toBeNull();
    expect(c.slots.w2.items.find((it) => it.type === "turn")).toMatchObject({ cost: null, tokens: 12_000 });
  });

  it("shows on the canvas each card's own figure and the team's total, never a price the other provider didn't give", () => {
    const actions = { draft: () => "", setDraft: () => {}, spawn: vi.fn() } as unknown as NodeActions;
    const chats = team([undefined, PLAIN]);
    const store = createChatStore();
    store.set(chats.slots);
    const { container } = render(
      <ChatStoreContext.Provider value={store}>
        <NodeActionsContext.Provider value={actions}>
          <Canvas nodes={orchestraNodes(chats, () => "Lead")} layout={newLayout()} activeSlot="s1" attention={[]} onFocus={() => {}} onOpen={() => {}} />
        </NodeActionsContext.Provider>
      </ChatStoreContext.Provider>,
    );
    const metas = [...container.querySelectorAll(".node-meta-text")].map((m) => m.textContent ?? "");
    expect(metas.some((m) => m.includes("$0.10"))).toBe(true);
    expect(metas.join(" ")).not.toContain("$0.90");
    expect(screen.getByRole("button", { name: "Team" }).textContent).not.toContain("$1.00");
  });
});

describe("the model picker, per provider", () => {
  const names = () => screen.getAllByRole("menuitemradio").map((r) => [r.querySelector(".menu-row-title")?.textContent, r.querySelector(".menu-row-meta")?.textContent]);

  it("lists the provider's own models as its CLI names them, and a Default that is its own", () => {
    render(<ModelsPicker running={null} chosen="o3" options={modelOptionsFor(PLAIN_LISTING.models, "Codex")} agent="Codex" onChoose={() => {}} />);
    fireEvent.click(modelChip());
    expect(names()).toEqual([["Default", "Codex's setting"], ["gpt-5-codex", ""], ["gpt-5", ""], ["o3", ""]]);
    expect(screen.getByRole("menuitemradio", { name: /^o3/ })).toHaveAttribute("aria-checked", "true");
  });

  it("keeps Claude's list and wording for Claude", () => {
    render(<ModelsPicker running={null} chosen={null} onChoose={() => {}} />);
    fireEvent.click(modelChip());
    expect(names()[0]).toEqual(["Default", expect.any(String)]);
    expect(names().map((n) => n[0])).toContain("Sonnet 5.5");
  });

  it("does not mangle a model id that isn't Claude's", () => {
    for (const id of ["gpt-5-codex", "gpt-5.1", "o3-mini", "claudette-1", "some-proxy-model"]) expect(modelLabel(id)).toBe(id);
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelChoicesFor("claude", ["x"], "Claude")).toBe(MODEL_CHOICES);
  });
});

describe("the + Agent form, per provider", () => {
  const mount = (list: typeof CLAUDE_LISTING[], mainProvider: typeof PLAIN | null = CLAUDE_INFO) => {
    const spawn = vi.fn(() => Promise.resolve());
    const store = createChatStore();
    store.set({ s1: { ...initialState, status: "idle", orchestrator: true, provider: mainProvider } });
    render(
      <ProvidersContext.Provider value={choicesOf(list)}>
        <ChatStoreContext.Provider value={store}>
          <NodeActionsContext.Provider value={{ spawn } as unknown as NodeActions}>
            <NewAgent main="s1" />
          </NodeActionsContext.Provider>
        </ChatStoreContext.Provider>
      </ProvidersContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "+ Agent" }));
    const form = screen.getByRole("dialog", { name: "New agent" });
    const select = (name: string) => within(form).getByLabelText(name) as HTMLSelectElement;
    const options = (name: string) => [...select(name).options].map((o) => o.textContent);
    const start = () => {
      fireEvent.change(within(form).getByLabelText("Task"), { target: { value: "Read the code" } });
      fireEvent.click(within(form).getByRole("button", { name: "Start agent" }));
    };
    return { spawn, form, select, options, start };
  };
  const sent = (spawn: ReturnType<typeof vi.fn>) => (spawn.mock.calls[0] as unknown[])[1] as Record<string, unknown>;

  it("has no provider choice with one provider, and sends no provider", () => {
    const { form, spawn, start } = mount([CLAUDE_LISTING]);
    expect(within(form).queryByLabelText("Runs on")).toBeNull();
    start();
    expect(sent(spawn).provider).toBeUndefined();
  });

  it("has none when the backend lists nobody (it can't be asked), as for Claude alone", () => {
    const { form } = mount([]);
    expect(within(form).queryByLabelText("Runs on")).toBeNull();
  });

  it("puts the provider choice before the model, on the Lead's own to begin with, and lists that provider's models", () => {
    const { form, select, options } = mount([CLAUDE_LISTING, PLAIN_LISTING]);
    const labels = [...form.querySelectorAll("label")].map((l) => l.firstChild?.textContent?.trim());
    expect(labels.indexOf("Runs on")).toBeGreaterThan(-1);
    expect(labels.indexOf("Runs on")).toBeLessThan(labels.indexOf("Model"));
    expect(select("Runs on").value).toBe("claude");
    expect(options("Runs on")).toEqual(["Claude · the Lead's", "Codex"]);
    expect(options("Model")).toEqual(MODEL_CHOICES.map((m) => `${m.label} · ${m.hint}`));
  });

  it("lists the other provider's models once it is chosen, forgetting a model picked for the first, and starts the agent on it", () => {
    const { select, options, start, spawn } = mount([CLAUDE_LISTING, PLAIN_LISTING]);
    fireEvent.change(select("Model"), { target: { value: "opus" } });
    fireEvent.change(select("Runs on"), { target: { value: "codex" } });
    expect(options("Model")).toEqual(["Default · Codex's setting", "gpt-5-codex · ", "gpt-5 · ", "o3 · "]);
    expect(select("Model").value).toBe("");
    fireEvent.change(select("Model"), { target: { value: "o3" } });
    start();
    expect(sent(spawn)).toMatchObject({ model: "o3", provider: "codex" });
  });

  it("is the Lead's own provider by default, whichever that is, and names another only when it is chosen", () => {
    const codexLead = mount([CLAUDE_LISTING, PLAIN_LISTING], PLAIN);
    expect(codexLead.select("Runs on").value).toBe("codex");
    expect(codexLead.options("Runs on")).toEqual(["Claude", "Codex · the Lead's"]);
    codexLead.start();
    expect(sent(codexLead.spawn).provider).toBeUndefined();
    cleanup();
    const again = mount([CLAUDE_LISTING, PLAIN_LISTING], PLAIN);
    fireEvent.change(again.select("Runs on"), { target: { value: "claude" } });
    again.start();
    expect(sent(again.spawn).provider).toBe("claude");
  });
});

describe("the provider picker", () => {
  const options = [
    { id: "claude", name: "Claude", capabilities: CLAUDE_INFO.capabilities },
    { id: "codex", name: "Codex", capabilities: PLAIN.capabilities },
  ];

  it("names the provider the chat is on, lists them with what each lacks, and changes only to another", () => {
    const onChoose = vi.fn();
    render(<ProviderPicker options={options} chosen="claude" onChoose={onChoose} />);
    const chip = screen.getByTitle("Runs on Claude");
    expect(chip).toHaveTextContent("Claude");
    fireEvent.click(chip);
    expect(screen.getAllByRole("menuitemradio").map((r) => r.textContent)).toEqual(["Claude", "CodexNo auto mode, advisor, skills or dollar cost"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Claude/ }));
    expect(onChoose).not.toHaveBeenCalled();
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Codex/ }));
    expect(onChoose).toHaveBeenCalledWith("codex");
  });

  it("says what is lacked in words, for one thing or several, and nothing for a provider that has it all", () => {
    expect(lacks(CLAUDE_INFO.capabilities)).toBe("");
    expect(lacks({ ...CLAUDE_INFO.capabilities, supports_skills: false })).toBe("No skills");
    expect(lacks({ ...CLAUDE_INFO.capabilities, supports_advisor: false, reports_cost_usd: false })).toBe("No advisor or dollar cost");
    expect(lacks(PLAIN.capabilities)).toBe("No auto mode, advisor, skills or dollar cost");
  });

  it("is in the chat box only with more than one provider to pick from", () => {
    const box = (providers?: { options: typeof options; chosen: string; onChoose: () => void }) => <MessageInput status="idle" onSend={() => {}} onStop={() => {}} providers={providers} />;
    const { rerender } = render(box());
    expect(document.querySelector(".provider-picker")).toBeNull();
    rerender(box({ options: options.slice(0, 1), chosen: "claude", onChoose: () => {} }));
    expect(document.querySelector(".provider-picker")).toBeNull();
    rerender(box({ options, chosen: "claude", onChoose: () => {} }));
    expect(document.querySelector(".provider-picker")).not.toBeNull();
  });
});

describe("which provider, on the canvas", () => {
  const spawned = (id: string, provider?: typeof PLAIN): UiEvent => ({ kind: "agent_spawned", worker: id, name: id.toUpperCase(), brief: "b", folder: `/wt/${id}`, branch: null, base: null, isolation: "shared", mode: "ask", ...(provider ? { provider } : {}) });
  const canvas = (list: (typeof CLAUDE_LISTING)[]) => {
    let c = initialChats({ ...initialState, status: "idle", folder: "/p", orchestrator: true, provider: CLAUDE_INFO });
    c = chatsReducer(c, { type: "in", slot: "s1", action: { type: "ui_event", event: spawned("w1", PLAIN) } });
    const store = createChatStore();
    store.set(c.slots);
    const actions = { draft: () => "", setDraft: () => {}, spawn: vi.fn() } as unknown as NodeActions;
    return render(
      <ProvidersContext.Provider value={choicesOf(list)}>
        <ChatStoreContext.Provider value={store}>
          <NodeActionsContext.Provider value={actions}>
            <Canvas nodes={orchestraNodes(c, () => "Lead")} layout={newLayout()} activeSlot="s1" attention={[]} onFocus={() => {}} onOpen={() => {}} />
          </NodeActionsContext.Provider>
        </ChatStoreContext.Provider>
      </ProvidersContext.Provider>,
    );
  };

  it("puts the provider in each card and the team list when the app has more than one, and nowhere with one", () => {
    const two = canvas([CLAUDE_LISTING, PLAIN_LISTING]);
    const metas = [...two.container.querySelectorAll(".node-meta-text")].map((m) => m.textContent);
    expect(metas).toEqual(["Runs the team · Claude", "Shared folder · Codex"]);
    fireEvent.click(screen.getByRole("button", { name: /^Team/ }));
    expect([...two.container.querySelectorAll(".team-provider")].map((p) => p.textContent)).toEqual(["Claude", "Codex"]);
    cleanup();
    const one = canvas([CLAUDE_LISTING]);
    expect([...one.container.querySelectorAll(".node-meta-text")].map((m) => m.textContent)).toEqual(["Runs the team", "Shared folder"]);
    fireEvent.click(screen.getByRole("button", { name: /^Team/ }));
    expect(one.container.querySelector(".team-provider")).toBeNull();
  });
});

describe("the words a chat uses for its agent", () => {
  const chat = (provider: typeof PLAIN | null, patch: Partial<State> = {}): State => ({ ...initialState, folder: "/p", provider, ...patch });

  it("names the agent in the title bar while it starts", () => {
    expect(activityStatus(chat(PLAIN, { status: "starting" }), null).text).toBe("Starting Codex…");
    expect(activityStatus(chat(null, { status: "starting" }), null).text).toBe("Starting Claude…");
  });

  it("names it in a notification, and says Claude when not told", () => {
    const items: ChatItem[] = [{ type: "turn", id: "t1", isError: false, stopped: false, result: null, durationMs: 1, denied: 0 }];
    expect(attentionFor(items, "/p/acme", () => "", "Codex")?.title).toBe("Codex · acme");
    expect(attentionFor(items, "/p/acme", () => "")?.title).toBe("Claude · acme");
    expect(attentionFor(items, null, () => "")?.title).toBe("Claude");
  });

  it("names it in the banners for a crash and a login, and keeps Claude's own login command", () => {
    const ended: UiEvent = { kind: "session_ended", code: 1, stderr_tail: "boom" };
    expect(reducer(chat(PLAIN, { status: "running" }), { type: "ui_event", event: ended }).banner?.text).toBe("Codex stopped unexpectedly (exit code 1). boom");
    expect(reducer(chat(null, { status: "running" }), { type: "ui_event", event: ended }).banner?.text).toBe("Claude stopped unexpectedly (exit code 1). boom");
    const login: UiEvent = { kind: "turn_done", is_error: true, result: "x", cost_usd: null, duration_ms: 1, auth_hint: true, denied: 0, context_window: null };
    expect(reducer(chat(null, { status: "running" }), { type: "ui_event", event: login }).banner?.text).toBe("Claude isn't logged in. Run `claude /login` in a terminal, then send your message again.");
    expect(reducer(chat(PLAIN, { status: "running" }), { type: "ui_event", event: login }).banner?.text).toBe("Codex isn't signed in. Run `codex login` in a terminal, then send your message again.");
  });

  it("names it where a chat follows up on its own, and in the empty chat's line", () => {
    const woken = reducer(chat(PLAIN, { status: "idle" }), { type: "ui_event", event: { kind: "thinking", parent: null } });
    expect(woken.items[0]).toMatchObject({ type: "user", auto: true, text: "Codex followed up on its own" });
    const { container } = render(<ChatView state={chat(PLAIN, { status: "idle" })} onDecide={() => {}} onOpenFile={() => {}} onStopShell={() => {}} onShellInput={() => {}} testRunFor={() => undefined} onOpenTestRun={() => {}} />);
    expect(container.querySelector(".empty")?.textContent).toBe("What should Codex work on?");
  });
});
