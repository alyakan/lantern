import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { attachSession } from "../test/fakeSession";
import { chat, connected, connectedWithControls, makeController, renderWith } from "../test/render";
import { ControlChips } from "./ControlChips";

const presets = [
  { id: "default", name: "Standard", summary: "Your model and effort" },
  { id: "balanced", name: "Balanced", summary: "Sonnet · Opus advisor · Haiku subagents" },
];
const controlsAnswer = (allow_auto: boolean) => ({ controls: { allow_auto, presets } });

async function open(opts: { allowAuto?: boolean; features?: string[]; chatOver?: Parameters<typeof chat>[0]; answers?: Parameters<typeof attachSession>[1]; waitMs?: number } = {}) {
  const { controller } = makeController();
  const session = attachSession(controller, { ...controlsAnswer(opts.allowAuto ?? false), ...opts.answers }, opts.features ?? ["controls"]);
  const onProblem = jest.fn();
  const c = chat({ permissions: "ask", preset: "balanced", ...opts.chatOver });
  const view = await renderWith(<ControlChips slot="a" chat={c} onProblem={onProblem} waitMs={opts.waitMs} />, { chats: [c], connection: opts.features && !opts.features.includes("controls") ? connected : connectedWithControls }, controller);
  await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
  return { onProblem, c, ...view, ...session, controller };
}

describe("the chips under a chat's title", () => {
  it("say what the chat runs on, with the preset's name", async () => {
    await open();
    expect(screen.getByText("Ask ▾")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Balanced ▾")).toBeTruthy());
  });

  it("are not there for a Mac that can't say, which isn't asked anything it doesn't know", async () => {
    const { asked } = await open({ features: [] });
    expect(screen.queryByText("Ask ▾")).toBeNull();
    expect(asked.some((r) => r.op === "controls")).toBe(false);
  });

  it("are not there for a chat the Mac hasn't said the mode of", async () => {
    await open({ chatOver: { permissions: null, preset: null } });
    expect(screen.queryByText(/▾/)).toBeNull();
  });
});

describe("switching Ask or Auto", () => {
  it("offers Auto off, saying where to turn it on, while the Mac's setting is off", async () => {
    await open({ allowAuto: false });
    await fireEvent.press(screen.getByText("Ask ▾"));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" })).toBeTruthy());
    expect(screen.getByRole("radio", { name: "Auto" }).props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getAllByText(/Let paired phones use Auto/).length).toBeGreaterThan(0);
  });

  it("puts the chat on Auto when the Mac lets phones, says Switching… until the chat says so, then shows Auto", async () => {
    const { controller, lastOf, c } = await open({ allowAuto: true });
    await fireEvent.press(screen.getByText("Ask ▾"));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" }).props.accessibilityState).toMatchObject({ disabled: false }));
    await fireEvent.press(screen.getByRole("radio", { name: "Auto" }));
    await waitFor(() => expect(lastOf("set_permissions")).toEqual({ op: "set_permissions", slot: "a", permissions: "auto" }));
    await waitFor(() => expect(screen.getByText("Switching… ▾")).toBeTruthy());
    await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "chats", chats: [{ ...c, permissions: "auto" }] } }));
  });

  it("says why when the Mac refuses, and stops saying Switching…", async () => {
    const { onProblem } = await open({ allowAuto: true, answers: { set_permissions: new Error("Claude is busy in this chat. Change it once it has finished.") } });
    await fireEvent.press(screen.getByText("Ask ▾"));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" }).props.accessibilityState).toMatchObject({ disabled: false }));
    await fireEvent.press(screen.getByRole("radio", { name: "Auto" }));
    await waitFor(() => expect(onProblem).toHaveBeenCalledWith("Claude is busy in this chat. Change it once it has finished."));
    expect(screen.queryByText("Switching… ▾")).toBeNull();
  });

  it("says so when the chat never changes", async () => {
    const { onProblem } = await open({ allowAuto: true, waitMs: 80 });
    await fireEvent.press(screen.getByText("Ask ▾"));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" }).props.accessibilityState).toMatchObject({ disabled: false }));
    await fireEvent.press(screen.getByRole("radio", { name: "Auto" }));
    await waitFor(() => expect(onProblem).toHaveBeenCalledWith("It didn't change. Look at Lantern on your Mac."), { timeout: 3000 });
    expect(screen.getByText("Ask ▾")).toBeTruthy();
  });

  it("offers nothing while Claude is busy, and says why", async () => {
    await open({ allowAuto: true, chatOver: { status: "working" } });
    await fireEvent.press(screen.getByText("Ask ▾"));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" })).toBeTruthy());
    expect(screen.getByRole("radio", { name: "Auto" }).props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getAllByText("Claude is busy in this chat. Change it once it has finished.").length).toBeGreaterThan(0);
  });

  it("does not ask the Mac to switch to what the chat already is", async () => {
    const { asked } = await open({ allowAuto: true });
    await fireEvent.press(screen.getByText("Ask ▾"));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Ask" })).toBeTruthy());
    await fireEvent.press(screen.getByRole("radio", { name: "Ask" }));
    expect(asked.some((r) => r.op === "set_permissions")).toBe(false);
  });
});

describe("switching the models", () => {
  it("lists the Mac's presets with what each does, and switches to the one picked", async () => {
    const { lastOf } = await open({ allowAuto: false, chatOver: { preset: "default" } });
    await waitFor(() => expect(screen.getByText("Standard ▾")).toBeTruthy());
    await fireEvent.press(screen.getByText("Standard ▾"));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Balanced" })).toBeTruthy());
    expect(screen.getByText("Sonnet · Opus advisor · Haiku subagents")).toBeTruthy();
    await fireEvent.press(screen.getByRole("radio", { name: "Balanced" }));
    await waitFor(() => expect(lastOf("set_preset")).toEqual({ op: "set_preset", slot: "a", preset: "balanced" }));
  });
});
