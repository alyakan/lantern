import { describe, expect, it } from "vitest";
import { chatsReducer, initialChats } from "../sessions";
import { initialState, reducer, totalCost, type State } from "../store";
import type { ProviderInfo, UiEvent } from "../types";
import { CLAUDE_INFO, CLAUDE_LISTING, PLAIN, PLAIN_LISTING } from "../testProviders";
import { CLAUDE, CLAUDE_CAPABILITIES, agentName, capabilitiesOf, choicesOf, isGateway, modeOn, providerChoicesForAgents, providerIdOf, providerName, reportsUsd, wireProvider } from "./provider";

const turn = (cost: number | null, tokens: number | null, session?: number): UiEvent => ({ kind: "turn_done", is_error: false, result: null, cost_usd: cost, tokens, session_cost_usd: session ?? cost, session_tokens: tokens ?? 0, duration_ms: 1000, auth_hint: false, denied: 0, context_window: 200_000 });
const lastItem = (s: State) => s.items[s.items.length - 1];
const run = (s: State, ...events: UiEvent[]) => events.reduce((state, event) => reducer(state, { type: "ui_event", event }), s);

describe("what a chat's provider can do", () => {
  it("is everything Claude does when the chat doesn't say, including a flag an older or newer backend leaves out", () => {
    expect(capabilitiesOf(null)).toEqual(CLAUDE_CAPABILITIES);
    expect(capabilitiesOf(undefined)).toEqual(CLAUDE_CAPABILITIES);
    expect(capabilitiesOf({ id: "claude", capabilities: { supports_auto_mode: false } as never }).supports_advisor).toBe(true);
    expect(capabilitiesOf(PLAIN).supports_skills).toBe(false);
    expect(providerIdOf(null)).toBe(CLAUDE);
    expect(providerIdOf(PLAIN)).toBe("codex");
  });

  it("is named for the screen, with a name for an id this build doesn't know", () => {
    expect(providerName("claude")).toBe("Claude");
    expect(providerName("codex")).toBe("Codex");
    expect(providerName("aider")).toBe("Aider");
    expect(agentName(null)).toBe("Claude");
    expect(agentName(PLAIN)).toBe("Codex");
  });

  it("reports dollars only for a provider that does, and can run Auto only where it has one", () => {
    expect(reportsUsd(null)).toBe(true);
    expect(reportsUsd(PLAIN)).toBe(false);
    expect(modeOn("auto", capabilitiesOf(PLAIN))).toBe("ask");
    expect(modeOn("steps", capabilitiesOf(PLAIN))).toBe("steps");
    expect(modeOn("auto", capabilitiesOf(null))).toBe("auto");
  });

  it("makes the pickers and labels for more than one provider, and none for one or none", () => {
    expect(choicesOf(null).multi).toBe(false);
    expect(choicesOf([]).multi).toBe(false);
    expect(choicesOf([CLAUDE_LISTING]).multi).toBe(false);
    expect(choicesOf([CLAUDE_LISTING, PLAIN_LISTING]).multi).toBe(true);
  });
});

describe("a chat's provider in its state", () => {
  it("starts unknown, which is Claude's", () => {
    expect(initialState.provider).toBeNull();
    expect(capabilitiesOf(initialState.provider)).toEqual(CLAUDE_CAPABILITIES);
  });

  it("keeps dollars for a provider that reports them", () => {
    const s = run({ ...initialState, provider: CLAUDE_INFO, status: "running" }, turn(0.5, 1000));
    expect(totalCost(s)).toBe(0.5);
    expect(s.sessionCost).toBe(0.5);
    expect(lastItem(s)).toMatchObject({ type: "turn", cost: 0.5, tokens: 1000 });
  });

  it("counts a chat with no provider yet as Claude's, dollars included", () => {
    const s = run({ ...initialState, status: "running" }, turn(0.5, 1000));
    expect(totalCost(s)).toBe(0.5);
  });

  it("never counts dollars for a provider that doesn't report them, whatever a turn says, and keeps its tokens", () => {
    const s = run({ ...initialState, provider: PLAIN, status: "running" }, turn(0.9, 4200, 0.9));
    expect(totalCost(s)).toBe(0);
    expect(s.sessionCost).toBeNull();
    expect(s.sessionTokens).toBe(4200);
    expect(lastItem(s)).toMatchObject({ type: "turn", cost: null, tokens: 4200 });
  });

  it("takes away dollars it already counted when told late that the provider has none", () => {
    const priced = run({ ...initialState, status: "running" }, turn(0.5, 1000));
    expect(totalCost(priced)).toBe(0.5);
    const s = reducer(priced, { type: "provider_set", provider: PLAIN });
    expect(totalCost(s)).toBe(0);
    expect(s.sessionCost).toBeNull();
    expect(lastItem(s)).toMatchObject({ type: "turn", cost: null, tokens: 1000 });
  });

  it("forgets another provider's models, commands and tools when the chat moves to one, but not for the same one", () => {
    const withLists: State = {
      ...initialState,
      model: "claude-opus-5-5",
      commands: [{ name: "compact", description: "", argument_hint: "" }],
      mcpTools: ["mcp__a__b"],
      models: [{ value: "opus", display_name: "Opus", description: "", resolved_model: "claude-opus-5-5", effort_levels: [] }],
    };
    const same = reducer(withLists, { type: "provider_set", provider: CLAUDE_INFO });
    expect(same.models).toHaveLength(1);
    expect(same.commands).toHaveLength(1);
    const moved = reducer(withLists, { type: "provider_set", provider: PLAIN });
    expect([moved.models, moved.commands, moved.mcpTools, moved.model]).toEqual([[], [], [], null]);
    expect(moved.provider).toEqual(PLAIN);
  });

  it("tags a request with the chat's provider, from the chat and never from what the request says", () => {
    const asks = (state: State, input: unknown) => run(state, { kind: "permission_requested", request_id: "p1", tool_name: "Bash", input });
    const codex = { ...initialState, status: "running" as const, provider: PLAIN };
    expect(lastItem(asks(codex, { command: "ls" }))).toMatchObject({ type: "permission", provider: "codex" });
    // A Claude chat's request is as it was, whatever it claims to be.
    const claude = lastItem(asks({ ...initialState, status: "running" }, { command: "ls", provider: "codex", cwd: "/safe" }));
    expect(claude).not.toHaveProperty("provider");
    expect(lastItem(asks({ ...initialState, status: "running", provider: CLAUDE_INFO }, { command: "ls" }))).not.toHaveProperty("provider");
  });

  it("is told with a spawned agent, whose context window is its own (its first turn reports it), whatever its provider", () => {
    const main: State = { ...initialState, status: "idle", orchestrator: true, folder: "/p", contextWindow: 1_000_000 };
    const spawned = (provider?: ProviderInfo): UiEvent => ({ kind: "agent_spawned", worker: "w1", name: "W", brief: "b", folder: "/wt", branch: null, base: null, isolation: "shared", mode: "ask", ...(provider ? { provider } : {}) });
    const other = chatsReducer(initialChats(main), { type: "in", slot: "s1", action: { type: "ui_event", event: spawned(PLAIN) } });
    expect(other.slots.w1.provider).toEqual(PLAIN);
    expect(other.slots.w1.contextWindow).toBeNull();
    const same = chatsReducer(initialChats(main), { type: "in", slot: "s1", action: { type: "ui_event", event: spawned(CLAUDE_INFO) } });
    expect(same.slots.w1.contextWindow).toBeNull();
    // A backend that doesn't say (an older one) is Claude's.
    const silent = chatsReducer(initialChats(main), { type: "in", slot: "s1", action: { type: "ui_event", event: spawned() } });
    expect(silent.slots.w1.provider).toBeNull();
  });
});

describe("an endpoint the user set up", () => {
  const gateway = { ...PLAIN_LISTING, id: "gateway", models: ["qwen3:8b"], binary: null, endpoint: { id: "ollama", name: "Ollama" } };

  it("is a provider of its own, keyed by its endpoint and named as the user named it", () => {
    const { list, multi } = choicesOf([CLAUDE_LISTING, gateway]);
    expect(list.map((l) => l.id)).toEqual(["claude", "gateway:ollama"]);
    expect(multi).toBe(true);
    expect(providerName("gateway:ollama")).toBe("Ollama");
    expect(agentName({ id: "gateway:ollama", capabilities: gateway.capabilities })).toBe("Ollama");
    // An endpoint this window hasn't been told the name of is still readable.
    expect(providerName("gateway:my-llm")).toBe("My-llm");
  });

  it("tells the backend the provider and which endpoint, and nothing at all for Claude", () => {
    expect(wireProvider("gateway:ollama")).toEqual({ provider: "gateway", endpoint: "ollama" });
    expect(wireProvider("codex")).toEqual({ provider: "codex" });
    expect(wireProvider("claude")).toEqual({});
    expect(isGateway("gateway:x") && !isGateway("codex") && !isGateway("claude")).toBe(true);
  });

  it("is left to Claude alone when no endpoint is set up, so a window with none looks as before", () => {
    expect(choicesOf([CLAUDE_LISTING])).toEqual({ list: [CLAUDE_LISTING], multi: false });
    expect(choicesOf(null)).toEqual({ list: [], multi: false });
  });

  it("is not offered to a team's agents", () => {
    expect(providerChoicesForAgents(choicesOf([CLAUDE_LISTING, PLAIN_LISTING, gateway]).list).map((l) => l.id)).toEqual(["claude", "codex"]);
  });
});
