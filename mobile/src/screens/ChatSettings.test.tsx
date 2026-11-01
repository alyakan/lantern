import { Text } from "react-native";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { attachSession } from "../test/fakeSession";
import { chat, connectedWith, connectedWithControls, makeController, renderWith } from "../test/render";
import { ChatSettings } from "./ChatSettings";

const presets = [
  { id: "default", name: "Standard", summary: "Your model and effort" },
  { id: "balanced", name: "Balanced", summary: "Sonnet · Opus advisor · Haiku subagents" },
];
const controlsAnswer = (allow_auto: boolean) => ({ controls: { allow_auto, presets } });

async function open(opts: { providerUsage?: Parameters<typeof ChatSettings>[0]["providerUsage"]; allowAuto?: boolean; features?: string[]; chatOver?: Parameters<typeof chat>[0]; answers?: Parameters<typeof attachSession>[1]; context?: { tokens: number; window: number | null }; waitMs?: number } = {}) {
  const { controller } = makeController();
  const session = attachSession(controller, { ...controlsAnswer(opts.allowAuto ?? false), ...opts.answers }, opts.features ?? ["controls", "close", "workflow"]);
  const onProblem = jest.fn();
  const onClosed = jest.fn();
  const c = chat({ permissions: "ask", preset: "balanced", ...opts.chatOver });
  const view = await renderWith(
    <ChatSettings slot="a" chat={c} onProblem={onProblem} onClosed={onClosed} waitMs={opts.waitMs} context={opts.context} providerUsage={opts.providerUsage}>
      {(line) => <Text>{`under the title: ${line ?? "nothing"}`}</Text>}
    </ChatSettings>,
    // The Mac the phone is connected to lists what `features` says (an older one, nothing).
    { chats: [c], connection: opts.features ? connectedWith(opts.features) : connectedWithControls },
    controller,
  );
  await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
  return { onProblem, onClosed, c, ...view, ...session, controller };
}

const openSheet = async (section?: string) => {
  await fireEvent.press(screen.getByRole("button", { name: "Chat settings" }));
  await waitFor(() => expect(screen.getByText("Permissions")).toBeTruthy());
  if (section) await fireEvent.press(await screen.findByRole("button", { name: new RegExp(`^${section},`) }));
};

describe("the title bar's settings line", () => {
  it("says what the chat runs on, with the preset's name, as plain text", async () => {
    await open();
    await waitFor(() => expect(screen.getByText("under the title: Ask · Balanced")).toBeTruthy());
    expect(screen.queryByText(/▾/)).toBeNull();
  });

  it("is plain for a Mac that can't say, which isn't asked anything it doesn't know", async () => {
    const { asked } = await open({ features: [] });
    expect(screen.getByText("under the title: nothing")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Chat settings" })).toBeNull();
    expect(asked.some((r) => r.op === "controls")).toBe(false);
  });

  it("is plain for a chat the Mac hasn't said the mode of", async () => {
    await open({ chatOver: { permissions: null, preset: null } });
    expect(screen.getByText("under the title: nothing")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Chat settings" })).toBeNull();
  });
});

describe("the settings sheet", () => {
  it("shows current values and expands choices inline without leaving the settings", async () => {
    await open({ allowAuto: true, context: { tokens: 50000, window: 100000 } });
    await openSheet();
    expect(screen.getByRole("button", { name: "Permissions, Ask" })).toBeTruthy();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    await fireEvent.press(screen.getByRole("button", { name: "Usage & context, 50% of context" }));
    expect(screen.getByRole("button", { name: "Permissions, Ask" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Usage & context, 50% of context" }).props.accessibilityState).toMatchObject({ expanded: true });
    await fireEvent.press(screen.getByRole("button", { name: "Model preset, Balanced" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Balanced" })).toBeTruthy());
    expect(screen.getByText("Sonnet · Opus advisor · Haiku subagents")).toBeTruthy();
  });

  it("offers Auto off, saying where to turn it on, while the Mac's setting is off", async () => {
    await open({ allowAuto: false });
    await openSheet("Permissions");
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" })).toBeTruthy());
    expect(screen.getByRole("radio", { name: "Auto" }).props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getAllByText(/Let paired phones use Auto/).length).toBeGreaterThan(0);
  });

  it("offers nothing while Claude is busy, and says why", async () => {
    await open({ allowAuto: true, chatOver: { status: "working" } });
    await openSheet("Permissions");
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" })).toBeTruthy());
    expect(screen.getByRole("radio", { name: "Auto" }).props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(screen.getByRole("button", { name: /^Model preset,/ }));
    expect(screen.getByRole("radio", { name: "Balanced" }).props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getAllByText("Claude is busy in this chat. Change it once it has finished.")).toHaveLength(1);
  });
});

describe("a chat that isn't on Claude", () => {
  it("says what it runs on first in the title bar's line, and not a Claude preset: the Mac records \"Standard\" for every chat", async () => {
    await open({ chatOver: { provider: "Ollama", preset: "default" } });
    await waitFor(() => expect(screen.getByText("under the title: Ollama · Ask")).toBeTruthy());
    expect(screen.queryByText(/Standard/)).toBeNull();
  });

  it("leaves a Claude chat's line as it was", async () => {
    await open({ chatOver: { provider: null } });
    await waitFor(() => expect(screen.getByText("under the title: Ask · Balanced")).toBeTruthy());
  });

  it("is not offered Auto, with why, nor the Mac's presets, which are Claude Code's models", async () => {
    await open({ allowAuto: true, chatOver: { provider: "Ollama", preset: null } });
    await openSheet("Permissions");
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" })).toBeTruthy());
    expect(screen.getByRole("radio", { name: "Auto" }).props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getAllByText("Ollama has no Auto mode: it asks before it acts.").length).toBeGreaterThan(0);
    expect(screen.queryByRole("radio", { name: "Balanced" })).toBeNull();
  });
});

describe("switching Ask or Auto", () => {
  it("puts the chat on Auto when the Mac lets phones, says Switching… until the chat says so, then shows Auto", async () => {
    const { controller, lastOf, c } = await open({ allowAuto: true });
    await openSheet("Permissions");
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" }).props.accessibilityState).toMatchObject({ disabled: false }));
    await fireEvent.press(screen.getByRole("radio", { name: "Auto" }));
    await waitFor(() => expect(lastOf("set_permissions")).toEqual({ op: "set_permissions", slot: "a", permissions: "auto" }));
    await waitFor(() => expect(screen.getByText("under the title: Switching… · Balanced")).toBeTruthy());
    await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "chats", chats: [{ ...c, permissions: "auto" }] } }));
  });

  it("says why when the Mac refuses, and stops saying Switching…", async () => {
    const { onProblem } = await open({ allowAuto: true, answers: { set_permissions: new Error("Claude is busy in this chat. Change it once it has finished.") } });
    await openSheet("Permissions");
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" }).props.accessibilityState).toMatchObject({ disabled: false }));
    await fireEvent.press(screen.getByRole("radio", { name: "Auto" }));
    await waitFor(() => expect(onProblem).toHaveBeenCalledWith("Claude is busy in this chat. Change it once it has finished."));
    expect(screen.queryByText(/Switching…/)).toBeNull();
  });

  it("says so when the chat never changes", async () => {
    const { onProblem } = await open({ allowAuto: true, waitMs: 80 });
    await openSheet("Permissions");
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" }).props.accessibilityState).toMatchObject({ disabled: false }));
    await fireEvent.press(screen.getByRole("radio", { name: "Auto" }));
    await waitFor(() => expect(onProblem).toHaveBeenCalledWith("It didn't change. Look at Lantern on your Mac."), { timeout: 3000 });
    expect(screen.getByText("under the title: Ask · Balanced")).toBeTruthy();
  });

  it("does not ask the Mac to switch to what the chat already is", async () => {
    const { asked } = await open({ allowAuto: true });
    await openSheet("Permissions");
    await fireEvent.press(screen.getByRole("radio", { name: "Ask" }));
    expect(asked.some((r) => r.op === "set_permissions")).toBe(false);
  });
});

describe("switching the models", () => {
  it("switches to the preset picked", async () => {
    const { lastOf } = await open({ allowAuto: false, chatOver: { preset: "default" } });
    await openSheet("Model preset");
    await waitFor(() => expect(screen.getByRole("radio", { name: "Balanced" })).toBeTruthy());
    await fireEvent.press(screen.getByRole("radio", { name: "Balanced" }));
    await waitFor(() => expect(lastOf("set_preset")).toEqual({ op: "set_preset", slot: "a", preset: "balanced" }));
  });
});

describe("closing the chat from its settings", () => {
  it("asks first, then closes it on the Mac and leaves the screen", async () => {
    const { lastOf, onClosed } = await open();
    await openSheet();
    await fireEvent.press(screen.getByRole("button", { name: "Close this chat" }));
    await waitFor(() => expect(screen.getByText("Close this chat?")).toBeTruthy());
    expect(screen.getByText(/closes on your Mac too/)).toBeTruthy();
    expect(lastOf("close")).toBeUndefined();
    await fireEvent.press(screen.getByRole("button", { name: "Close chat" }));
    await waitFor(() => expect(lastOf("close")).toEqual({ op: "close", slot: "a" }));
    await waitFor(() => expect(onClosed).toHaveBeenCalled());
  });

  it("keeps the chat when it is asked to keep it", async () => {
    const { lastOf, onClosed } = await open();
    await openSheet();
    await fireEvent.press(screen.getByRole("button", { name: "Close this chat" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Keep it" })).toBeTruthy());
    await fireEvent.press(screen.getByRole("button", { name: "Keep it" }));
    expect(lastOf("close")).toBeUndefined();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("says why it didn't close when the Mac refuses, and stays", async () => {
    const { onClosed } = await open({ answers: { close: new Error("That chat is part of a team: close it on your Mac.") } });
    await openSheet();
    await fireEvent.press(screen.getByRole("button", { name: "Close this chat" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close chat" })).toBeTruthy());
    await fireEvent.press(screen.getByRole("button", { name: "Close chat" }));
    await waitFor(() => expect(screen.getByText("That chat is part of a team: close it on your Mac.")).toBeTruthy());
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("says Claude is busy instead of asking, while it is", async () => {
    await open({ chatOver: { status: "working" } });
    await openSheet();
    await fireEvent.press(screen.getByRole("button", { name: "Close this chat" }));
    await waitFor(() => expect(screen.getByText("Close this chat?")).toBeTruthy());
    expect(screen.getAllByText("The agent is busy in this chat. Stop it first, then close it.").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Close chat" })).toBeNull();
  });
});

describe("the workflow", () => {
  it("says Step by step in the title bar's line, and nothing for a plain chat", async () => {
    await open({ chatOver: { workflow: "steps" } });
    await waitFor(() => expect(screen.getByText("under the title: Step by step · Ask · Balanced")).toBeTruthy());
  });

  it("is switched to Step by step from the sheet, with Switching… until the chat says so", async () => {
    const { controller, lastOf, c } = await open({ chatOver: { workflow: "chat" } });
    await openSheet("Workflow");
    expect(screen.getByRole("button", { name: /^Workflow,/ }).props.accessibilityState).toMatchObject({ expanded: true });
    await fireEvent.press(screen.getByRole("radio", { name: "Step by step" }));
    await waitFor(() => expect(lastOf("set_workflow")).toEqual({ op: "set_workflow", slot: "a", workflow: "steps" }));
    await waitFor(() => expect(screen.getByText("under the title: Switching… · Ask · Balanced")).toBeTruthy());
    await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "chats", chats: [{ ...c, workflow: "steps" }] } }));
  });

  it("is not offered for a team's Lead, which is led on the Mac, nor by a Mac that can't switch it", async () => {
    await open({ chatOver: { workflow: "team" } });
    await openSheet();
    expect(screen.queryByText("Workflow")).toBeNull();
  });

  it("is not offered by a Mac that doesn't list it", async () => {
    await open({ features: ["controls", "close"], chatOver: { workflow: "chat" } });
    await openSheet();
    expect(screen.queryByText("Workflow")).toBeNull();
  });
});

const codexConfiguration = {
  provider: "codex", model: null, effort: "high", models: ["gpt-example"], effort_levels: ["low", "high"],
  capabilities: { supports_auto_mode: false, supports_advisor: false, supports_effort: true, model_switchable: true, supports_images: true, supports_compact: true, supports_clear: true },
};

describe("provider-neutral settings", () => {
  it("starts with the provider’s first five models and reveals older choices on request", async () => {
    const models = ["recent-1", "recent-2", "recent-3", "recent-4", "recent-5", "older-1", "older-2"];
    await open({ features: ["controls", "conversation"], answers: { conversation_settings: { ...codexConfiguration, models, model: "older-2" } } });
    await openSheet("Model");
    expect(screen.getByRole("radio", { name: "recent-5" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "older-2" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "older-1" })).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Show older models" }));
    expect(screen.getByRole("radio", { name: "older-1" })).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Hide older models" }));
    expect(screen.queryByRole("radio", { name: "older-1" })).toBeNull();
  });

  it("offers only the active provider's models and effort levels and sends a model operation", async () => {
    const { lastOf } = await open({ features: ["controls", "conversation"], chatOver: { provider: "Codex" }, answers: { conversation_settings: codexConfiguration } });
    await openSheet("Model");
    await screen.findByRole("radio", { name: "gpt-example" });
    expect(screen.queryByRole("radio", { name: "medium" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "high" })).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: /^Effort,/ }));
    expect(screen.getByRole("radio", { name: "high" })).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: /^Model,/ }));
    await fireEvent.press(screen.getByRole("radio", { name: "gpt-example" }));
    expect(lastOf("conversation_settings")).toEqual({ op: "conversation_settings", slot: "a", change: { model: "gpt-example" } });
  });

  it("offers installed providers and switches through the conversation operation", async () => {
    const { lastOf } = await open({ features: ["controls", "conversation"], answers: {
      controls: { allow_auto: false, presets, providers: [{ id: "claude", name: "Claude", auto: true, presets: true }, { id: "codex", name: "Codex", auto: false, presets: false }] },
      conversation_settings: { ...codexConfiguration, provider: "claude" },
    } });
    await openSheet("Provider");
    await fireEvent.press(await screen.findByRole("radio", { name: "Codex" }));
    expect(lastOf("conversation_settings")).toEqual({ op: "conversation_settings", slot: "a", change: { provider: "codex" } });
  });
});

it("shows the chat provider's reported windows without assuming a five-hour session", async () => {
  await open({ chatOver: { provider: "Codex" }, providerUsage: { provider: "codex", updated_at: 1, windows: [{ label: "2 hours", minutes: 120, used: .2, resets_at: null }] } });
  await openSheet("Usage & context");
  expect(screen.getByText("Codex · 2 hours: 20% used")).toBeTruthy();
  expect(screen.queryByText(/five-hour/)).toBeNull();
});

it("offers a direct conversation handoff when Claude is exhausted", async () => {
  const { lastOf } = await open({ features: ["controls", "conversation"], providerUsage: { provider: "claude", updated_at: 1, windows: [{ label: "Session", minutes: 300, used: 1, resets_at: null }] }, answers: {
    controls: { allow_auto: false, presets, providers: [{ id: "claude", name: "Claude", auto: true, presets: true }, { id: "codex", name: "Codex", auto: false, presets: false }] },
    conversation_settings: { ...codexConfiguration, provider: "claude" },
  } });
  await fireEvent.press(screen.getByRole("button", { name: "Chat settings" }));
  await fireEvent.press(await screen.findByRole("button", { name: "Switch this chat to Codex" }));
  expect(lastOf("conversation_settings")).toEqual({ op: "conversation_settings", slot: "a", change: { provider: "codex" } });
});
