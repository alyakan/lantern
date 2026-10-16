import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api";
import type { AsideEvent, UiEvent } from "../types";
import { SideChat } from "./SideChat";

vi.mock("../api", () => ({ api: { asideAsk: vi.fn(), asideStop: vi.fn(), asideStopAnswering: vi.fn(), onAsideEvent: vi.fn() } }));
const ask = vi.mocked(api.asideAsk);
const stop = vi.mocked(api.asideStop);
const stopAnswering = vi.mocked(api.asideStopAnswering);
const listen = vi.mocked(api.onAsideEvent);

let listeners: ((e: AsideEvent) => void)[] = [];
/** What the backend would send: every open side chat hears it, and only the one it names takes it. */
const say = (aside: string, event?: UiEvent, note?: string) => act(() => listeners.forEach((cb) => cb({ aside, event, note })));
const idOf = () => ask.mock.calls[ask.mock.calls.length - 1][1];
const done = (): UiEvent => ({ kind: "turn_done", is_error: false, result: null, cost_usd: null, tokens: null, session_cost_usd: 0.02, session_tokens: 1200, duration_ms: 900, auth_hint: false, denied: 0, context_window: 200_000 });
const text = (t: string, id = "b:0"): UiEvent => ({ kind: "assistant_text", parent: null, block_id: id, text: t });

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  listeners = [];
  listen.mockImplementation((cb) => {
    listeners.push(cb);
    return Promise.resolve(() => void (listeners = listeners.filter((l) => l !== cb)));
  });
  ask.mockResolvedValue(true);
  stop.mockResolvedValue(undefined);
  stopAnswering.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

function open() {
  const onClose = vi.fn();
  const view = render(<SideChat onClose={onClose} />);
  const box = screen.getByLabelText("Side question");
  const type = (q: string) => {
    fireEvent.change(box, { target: { value: q } });
    fireEvent.submit(box.closest("form")!);
  };
  return { ...view, onClose, box, type };
}

describe("SideChat", () => {
  it("says it isn't added to the chat and can only read, and starts with the cursor in its box", () => {
    const { box } = open();
    expect(screen.getByRole("dialog", { name: "Side chat" })).toBeInTheDocument();
    expect(screen.getByText("This isn't added to the chat.")).toBeInTheDocument();
    expect(screen.getByText("Read only: it can read your files but not change anything.")).toBeInTheDocument();
    expect(box).toHaveFocus();
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks about the chat it is in, streams the answer in and shows what it used", async () => {
    const { type, box } = open();
    type("  which file was that in?  ");
    expect(ask).toHaveBeenCalledWith("s1", expect.stringMatching(/^a[a-z0-9]+$/), "which file was that in?", null);
    expect(box).toHaveValue("");
    expect(screen.getByText("which file was that in?")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Thinking");
    say(idOf(), { kind: "tool_started", parent: null, tool_use_id: "t", name: "Read", summary: "/p/src/retry.ts" });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Reading retry.ts"));
    say(idOf(), { kind: "text_delta", parent: null, block_id: "b:0", text: "It is in **retry.ts**" });
    await waitFor(() => expect(screen.getByText("retry.ts", { selector: "strong" })).toBeInTheDocument());
    say(idOf(), text("It is in **retry.ts**."));
    say(idOf(), done());
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.getByText(/Used by this side chat: \$0\.02 · 1\.2k tokens/)).toBeInTheDocument();
  });

  it("only listens to its own side chat's events", async () => {
    const { type } = open();
    type("one");
    say("someone-else", text("not mine"));
    say(idOf(), text("mine"));
    await waitFor(() => expect(screen.getByText("mine")).toBeInTheDocument());
    expect(screen.queryByText("not mine")).toBeNull();
  });

  it("a follow-up continues the same side chat, and the model is fixed after the first question", async () => {
    const { type } = open();
    fireEvent.change(screen.getByLabelText("Model for the side chat"), { target: { value: "haiku" } });
    expect(localStorage.getItem("lantern.sideChatModel")).toBe("haiku");
    type("first");
    const id = idOf();
    say(id, text("one"));
    say(id, done());
    await screen.findByRole("button", { name: "Ask" });
    expect(screen.getByLabelText("Side question")).toHaveAttribute("placeholder", "Ask a follow-up…");
    expect(screen.getByLabelText("Model for the side chat")).toBeDisabled();
    type("second");
    expect(ask).toHaveBeenLastCalledWith("s1", id, "second", "haiku");
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
  });

  it("won't take another question while one is being answered, and Stop ends the answer", async () => {
    const { type } = open();
    type("slow one");
    const submit = screen.getByRole("button", { name: "Stop" });
    type("impatient");
    expect(ask).toHaveBeenCalledTimes(1);
    fireEvent.click(submit);
    expect(stopAnswering).toHaveBeenCalledWith(idOf());
    say(idOf(), undefined, "Stopped.");
    await waitFor(() => expect(screen.getByText("Stopped.")).toBeInTheDocument());
    // Stopped, it can be asked again.
    expect(screen.getByRole("button", { name: "Ask" })).toBeInTheDocument();
  });

  it("says when the question couldn't be asked, and when the chat had nothing to go on", async () => {
    ask.mockRejectedValueOnce("Too many side chats are open. Close one first.");
    const { type } = open();
    type("hello");
    await waitFor(() => expect(screen.getByText("Too many side chats are open. Close one first.")).toBeInTheDocument());
    ask.mockResolvedValueOnce(false);
    type("again");
    await waitFor(() => expect(screen.getByText(/This chat has no messages yet/)).toBeInTheDocument());
  });

  it("Escape closes it, and closing stops the side chat whichever way it closes", () => {
    const { onClose, unmount } = open();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("leaves Escape to whatever used it first", () => {
    const { onClose } = open();
    const used = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    used.preventDefault();
    document.dispatchEvent(used);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("the Close button closes it", () => {
    const { onClose } = open();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Close side chat" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("copies the latest answer, as written", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    const { type } = open();
    expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
    type("q");
    say(idOf(), text("It is **here**."));
    say(idOf(), done());
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("It is **here**.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
  });

  it("an answer that failed says why, in its place", async () => {
    const { type } = open();
    type("q");
    say(idOf(), { kind: "turn_done", is_error: true, result: "The model is overloaded.", cost_usd: null, duration_ms: null, auth_hint: false, denied: 0, context_window: null });
    await waitFor(() => expect(screen.getByText("The model is overloaded.")).toBeInTheDocument());
  });
});
