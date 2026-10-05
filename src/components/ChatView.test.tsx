import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { initialState, type ChatItem } from "../store";
import { ChatView } from "./ChatView";

const items: ChatItem[] = [
  { type: "user", id: "u1", text: "Add retries" },
  { type: "assistant", id: "a1", text: "Done." },
];

describe("ChatView", () => {
  it("offers a way back to the end once you've scrolled up from it", () => {
    const { container } = render(<ChatView state={{ ...initialState, status: "idle", folder: "/p", items }} onDecide={() => {}} onOpenFile={() => {}} />);
    const chat = container.querySelector(".chat") as HTMLElement;
    // jsdom lays nothing out: a 2000px conversation in a 500px view.
    Object.defineProperty(chat, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(chat, "clientHeight", { value: 500, configurable: true });
    let top = 0;
    Object.defineProperty(chat, "scrollTop", { get: () => top, set: (v: number) => (top = v), configurable: true });
    chat.scrollTo = ((opts: ScrollToOptions) => (top = opts.top ?? top)) as typeof chat.scrollTo;

    top = 1500;
    fireEvent.scroll(chat);
    expect(screen.queryByRole("button", { name: /Latest/ })).toBeNull();
    top = 600;
    fireEvent.scroll(chat);
    fireEvent.click(screen.getByRole("button", { name: /Latest/ }));
    expect(top).toBe(2000);
    fireEvent.scroll(chat);
    expect(screen.queryByRole("button", { name: /Latest/ })).toBeNull();
  });
});
