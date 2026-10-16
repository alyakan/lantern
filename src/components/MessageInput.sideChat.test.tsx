import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { api } from "../api";
import { availableActions, resetActionsForTest, runAction } from "../lib/actions";
import { MessageInput } from "./MessageInput";

vi.mock("../api", () => ({ api: { asideAsk: vi.fn(), asideStop: vi.fn(), asideStopAnswering: vi.fn(), onAsideEvent: vi.fn() } }));

beforeEach(() => {
  vi.resetAllMocks();
  resetActionsForTest();
  vi.mocked(api.onAsideEvent).mockResolvedValue(() => {});
  vi.mocked(api.asideStop).mockResolvedValue(undefined);
});

const box = (props: Partial<Parameters<typeof MessageInput>[0]> = {}) => <MessageInput status="idle" folder="/repo" onSend={() => {}} onStop={() => {}} {...props} />;

describe("MessageInput's side chat", () => {
  it("opens from the button beside the box, and closes with Escape, with the cursor back in the box", () => {
    render(box());
    const button = screen.getByRole("button", { name: "Ask a side question" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(screen.getByRole("dialog", { name: "Side chat" })).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("Message to Claude")).toHaveFocus();
    expect(api.asideStop).toHaveBeenCalledTimes(1);
  });

  it("opens from the shortcut and the command palette's action, and the same again closes it", () => {
    render(box());
    expect(availableActions().find((a) => a.id === "side-chat")).toMatchObject({ title: "Ask a side question…", shortcut: "⌘B" });
    act(() => void runAction("side-chat"));
    expect(screen.getByRole("dialog", { name: "Side chat" })).toBeInTheDocument();
    // Within the same moment it's the same keystroke arriving twice; a moment later it is a second press.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 1000);
    act(() => void runAction("side-chat"));
    vi.useRealTimers();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("works while Claude is in the middle of a turn, and leaves the message box and its queue alone", () => {
    const onStop = vi.fn();
    render(box({ status: "running", onStop }));
    expect(screen.getByLabelText("Message to Claude")).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Ask a side question" }));
    expect(screen.getByRole("dialog", { name: "Side chat" })).toBeInTheDocument();
    expect(onStop).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Queued messages")).toBeNull();
    // The turn's Stop is still there for the chat.
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("is offered only where there is a chat to ask about", () => {
    const { rerender } = render(box({ folder: null }));
    expect(screen.queryByRole("button", { name: "Ask a side question" })).toBeNull();
    expect(availableActions().some((a) => a.id === "side-chat")).toBe(false);
    rerender(box({ hero: true }));
    expect(screen.queryByRole("button", { name: "Ask a side question" })).toBeNull();
    rerender(box({ status: "starting" }));
    expect(screen.queryByRole("button", { name: "Ask a side question" })).toBeNull();
    rerender(box());
    expect(screen.getByRole("button", { name: "Ask a side question" })).toBeInTheDocument();
  });
});
