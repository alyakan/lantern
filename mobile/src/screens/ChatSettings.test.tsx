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

async function open(opts: { allowAuto?: boolean; features?: string[]; chatOver?: Parameters<typeof chat>[0]; answers?: Parameters<typeof attachSession>[1]; waitMs?: number } = {}) {
  const { controller } = makeController();
  const session = attachSession(controller, { ...controlsAnswer(opts.allowAuto ?? false), ...opts.answers }, opts.features ?? ["controls", "close", "workflow"]);
  const onProblem = jest.fn();
  const onClosed = jest.fn();
  const c = chat({ permissions: "ask", preset: "balanced", ...opts.chatOver });
  const view = await renderWith(
    <ChatSettings slot="a" chat={c} onProblem={onProblem} onClosed={onClosed} waitMs={opts.waitMs}>
      {(line) => <Text>{`under the title: ${line ?? "nothing"}`}</Text>}
    </ChatSettings>,
    // The Mac the phone is connected to lists what `features` says (an older one, nothing).
    { chats: [c], connection: opts.features ? connectedWith(opts.features) : connectedWithControls },
    controller,
  );
  await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
  return { onProblem, onClosed, c, ...view, ...session, controller };
}

const openSheet = async () => {
  await fireEvent.press(screen.getByRole("button", { name: "Chat settings" }));
  await waitFor(() => expect(screen.getByText("Permissions")).toBeTruthy());
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
  it("is opened by pressing the title bar, and has the permissions and the models together", async () => {
    await open({ allowAuto: true });
    await openSheet();
    expect(screen.getByText("Models")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Balanced" })).toBeTruthy());
    expect(screen.getByText("Sonnet · Opus advisor · Haiku subagents")).toBeTruthy();
  });

  it("offers Auto off, saying where to turn it on, while the Mac's setting is off", async () => {
    await open({ allowAuto: false });
    await openSheet();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" })).toBeTruthy());
    expect(screen.getByRole("radio", { name: "Auto" }).props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getAllByText(/Let paired phones use Auto/).length).toBeGreaterThan(0);
  });

  it("offers nothing while Claude is busy, and says why", async () => {
    await open({ allowAuto: true, chatOver: { status: "working" } });
    await openSheet();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" })).toBeTruthy());
    expect(screen.getByRole("radio", { name: "Auto" }).props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByRole("radio", { name: "Balanced" }).props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getAllByText("Claude is busy in this chat. Change it once it has finished.").length).toBeGreaterThan(0);
  });
});

describe("switching Ask or Auto", () => {
  it("puts the chat on Auto when the Mac lets phones, says Switching… until the chat says so, then shows Auto", async () => {
    const { controller, lastOf, c } = await open({ allowAuto: true });
    await openSheet();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" }).props.accessibilityState).toMatchObject({ disabled: false }));
    await fireEvent.press(screen.getByRole("radio", { name: "Auto" }));
    await waitFor(() => expect(lastOf("set_permissions")).toEqual({ op: "set_permissions", slot: "a", permissions: "auto" }));
    await waitFor(() => expect(screen.getByText("under the title: Switching… · Balanced")).toBeTruthy());
    await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "chats", chats: [{ ...c, permissions: "auto" }] } }));
  });

  it("says why when the Mac refuses, and stops saying Switching…", async () => {
    const { onProblem } = await open({ allowAuto: true, answers: { set_permissions: new Error("Claude is busy in this chat. Change it once it has finished.") } });
    await openSheet();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" }).props.accessibilityState).toMatchObject({ disabled: false }));
    await fireEvent.press(screen.getByRole("radio", { name: "Auto" }));
    await waitFor(() => expect(onProblem).toHaveBeenCalledWith("Claude is busy in this chat. Change it once it has finished."));
    expect(screen.queryByText(/Switching…/)).toBeNull();
  });

  it("says so when the chat never changes", async () => {
    const { onProblem } = await open({ allowAuto: true, waitMs: 80 });
    await openSheet();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" }).props.accessibilityState).toMatchObject({ disabled: false }));
    await fireEvent.press(screen.getByRole("radio", { name: "Auto" }));
    await waitFor(() => expect(onProblem).toHaveBeenCalledWith("It didn't change. Look at Lantern on your Mac."), { timeout: 3000 });
    expect(screen.getByText("under the title: Ask · Balanced")).toBeTruthy();
  });

  it("does not ask the Mac to switch to what the chat already is", async () => {
    const { asked } = await open({ allowAuto: true });
    await openSheet();
    await fireEvent.press(screen.getByRole("radio", { name: "Ask" }));
    expect(asked.some((r) => r.op === "set_permissions")).toBe(false);
  });
});

describe("switching the models", () => {
  it("switches to the preset picked", async () => {
    const { lastOf } = await open({ allowAuto: false, chatOver: { preset: "default" } });
    await openSheet();
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
    expect(screen.getAllByText("Claude is busy in this chat. Stop it first, then close it.").length).toBeGreaterThan(0);
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
    await openSheet();
    expect(screen.getByText("Workflow")).toBeTruthy();
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
