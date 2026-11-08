import { fireEvent, render, screen } from "@testing-library/react-native";
import type { Suggestion } from "../protocol/generated/Suggestion";
import { CruiseBar } from "./Cruise";

const nextStep: Suggestion = { id: "c1", title: "Re-run the tests", why: "One is red.", message: "Re-run the tests.", target: { kind: "continue", slot: "a" } };

const bar = (p: { on?: boolean; resting?: boolean; asking?: boolean; draft?: Suggestion | null; error?: string | null; onToggle?: () => void; onAsk?: () => void; onDo?: () => void; onAnother?: () => void; onStop?: () => void; replies?: string[]; onReply?: (text: string) => void } = {}) => (
  <CruiseBar
    on={p.on ?? true}
    resting={p.resting ?? true}
    asking={p.asking ?? false}
    draft={p.draft ?? null}
    error={p.error ?? null}
    onToggle={p.onToggle ?? (() => {})}
    onAsk={p.onAsk ?? (() => {})}
    onDo={p.onDo ?? (() => {})}
    onAnother={p.onAnother ?? (() => {})}
    onStop={p.onStop ?? (() => {})}
    replies={p.replies}
    onReply={p.onReply}
  />
);

describe("Cruise, over the message box", () => {
  it("is one pill when off, and turning it on is a press", async () => {
    const onToggle = jest.fn();
    await render(bar({ on: false, onToggle }));
    await fireEvent.press(screen.getByRole("button", { name: /Cruise/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("off, it shares its row with the quick replies: the answers first, then Cruise, all chips of one kind", async () => {
    const onReply = jest.fn();
    const onToggle = jest.fn();
    await render(bar({ on: false, replies: ["Yes", "No"], onReply, onToggle }));
    expect(screen.getByLabelText("Quick replies")).toBeTruthy();
    const names = screen.getAllByRole("button").map((b) => b.props.accessibilityLabel);
    expect(names).toEqual(["Reply: Yes", "Reply: No", "Cruise: suggest the next step each time the chat is idle"]);
    await fireEvent.press(screen.getByRole("button", { name: "Reply: No" }));
    expect(onReply).toHaveBeenCalledWith("No");
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("on, it leaves the replies out: its card is the row", async () => {
    await render(bar({ on: true, replies: ["Yes", "No"] }));
    expect(screen.queryByRole("button", { name: "Reply: Yes" })).toBeNull();
  });

  it("shows the next step; Do it, Another and Stop each do their one thing", async () => {
    const onDo = jest.fn();
    const onAnother = jest.fn();
    const onStop = jest.fn();
    await render(bar({ draft: nextStep, onDo, onAnother, onStop }));
    expect(screen.getByText("Re-run the tests")).toBeTruthy();
    expect(screen.getByText("One is red.")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Do it: Re-run the tests" }));
    await fireEvent.press(screen.getByRole("button", { name: "Another suggestion" }));
    await fireEvent.press(screen.getByRole("button", { name: "Stop Cruise" }));
    expect(onDo).toHaveBeenCalledTimes(1);
    expect(onAnother).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("shows Another as loading, and takes no second press while it asks", async () => {
    const onAnother = jest.fn();
    await render(bar({ draft: nextStep, asking: true, onAnother }));
    const button = screen.getByRole("button", { name: "Asking for another suggestion" });
    expect(button).toBeDisabled();
    await fireEvent.press(button);
    expect(onAnother).not.toHaveBeenCalled();
    expect(screen.getByText("Another…")).toBeTruthy();
  });

  it("offers Next step when nothing is drafted, and that asks (it isn't Another)", async () => {
    const onAsk = jest.fn();
    const onAnother = jest.fn();
    await render(bar({ onAsk, onAnother }));
    await fireEvent.press(screen.getByRole("button", { name: "Suggest a next step" }));
    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(onAnother).not.toHaveBeenCalled();
  });

  it("waits while the chat isn't at rest, and never sends by itself", async () => {
    const onDo = jest.fn();
    await render(bar({ resting: false, draft: nextStep, onDo }));
    expect(screen.queryByText("Re-run the tests")).toBeNull();
    expect(screen.getByText(/Waiting for this turn to end/)).toBeTruthy();
    expect(onDo).not.toHaveBeenCalled();
  });

  it("says it is thinking, and says why when it couldn't", async () => {
    const view = await render(bar({ asking: true }));
    expect(screen.getByText(/Thinking about the next step/)).toBeTruthy();
    await view.rerender(bar({ error: "Claude didn't answer in time." }));
    expect(screen.getByText("Claude didn't answer in time.")).toBeTruthy();
  });
});
