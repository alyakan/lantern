import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { initialState, type ChatItem } from "../store";
import { recallScroll } from "../lib/scrollMemory";
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

  it("follows new messages by scrolling only the chat, never the page around it", () => {
    // scrollIntoView scrolls every scrollable ancestor too, the page included: message by message, the whole app
    // slid up and out of the window.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const props = { onDecide: () => {}, onOpenFile: () => {} };
    const { container, rerender } = render(<ChatView state={{ ...initialState, status: "running", folder: "/p", items }} {...props} />);
    const chat = container.querySelector(".chat") as HTMLElement;
    Object.defineProperty(chat, "scrollHeight", { value: 2000, configurable: true });

    rerender(<ChatView state={{ ...initialState, status: "running", folder: "/p", items: [...items, { type: "assistant", id: "a2", text: "More." }] }} {...props} />);
    expect(chat.scrollTop).toBe(2000);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("stays at the end when what is in the chat grows after it showed (code coloured, a diagram drawn), and leaves a reader who scrolled up alone", () => {
    // jsdom has no ResizeObserver: ones that say what they watch and let the test say when something resized.
    const observers: { targets: Element[]; cb: () => void }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        targets: Element[] = [];
        constructor(cb: () => void) {
          observers.push({ targets: this.targets, cb });
        }
        observe(el: Element) {
          this.targets.push(el);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    try {
      const { container } = render(<ChatView state={{ ...initialState, status: "idle", folder: "/p", items }} onDecide={() => {}} onOpenFile={() => {}} />);
      const chat = container.querySelector(".chat") as HTMLElement;
      // The chat's own observer: it watches the chat, and also what is in it, since that is what grows.
      const mine = observers.find((o) => o.targets.includes(chat));
      expect(mine).toBeDefined();
      expect(mine!.targets.some((el) => el !== chat && chat.contains(el))).toBe(true);
      const resized = () => mine!.cb();
      let height = 2000;
      Object.defineProperty(chat, "scrollHeight", { get: () => height, configurable: true });
      Object.defineProperty(chat, "clientHeight", { value: 500, configurable: true });
      let top = 0;
      Object.defineProperty(chat, "scrollTop", { get: () => top, set: (v: number) => (top = v), configurable: true });
      // At the end, as a chat shown at its end is.
      top = 1500;
      fireEvent.scroll(chat);
      height = 2600;
      resized();
      expect(top).toBe(2600);
      // A reader who scrolled up to read isn't pulled to the end by it.
      top = 600;
      fireEvent.scroll(chat);
      height = 3200;
      resized();
      expect(top).not.toBe(3200);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("doesn't take the scroll event its own move to the end makes for the reader scrolling up, even when the chat has grown by then", () => {
    // Lantern puts a chat at its end by setting its scroll position; the browser reports that a frame later, and by then
    // the code in it has its colours and the chat is taller. Read as the reader's, it said "scrolled up": what was
    // remembered was the middle of the chat, and coming back to it put you there.
    const observers: { targets: Element[]; cb: () => void }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        targets: Element[] = [];
        constructor(cb: () => void) {
          observers.push({ targets: this.targets, cb });
        }
        observe(el: Element) {
          this.targets.push(el);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    try {
      const props = { onDecide: () => {}, onOpenFile: () => {} };
      const { container, rerender } = render(<ChatView state={{ ...initialState, status: "idle", folder: "/p", items }} {...props} />);
      const chat = container.querySelector(".chat") as HTMLElement;
      const mine = observers.find((o) => o.targets.includes(chat))!;
      let height = 2000;
      Object.defineProperty(chat, "scrollHeight", { get: () => height, configurable: true });
      Object.defineProperty(chat, "clientHeight", { value: 500, configurable: true });
      let top = 0;
      Object.defineProperty(chat, "scrollTop", { get: () => top, set: (v: number) => (top = v), configurable: true });
      // A new message: Lantern follows it to the end.
      rerender(<ChatView state={{ ...initialState, status: "idle", folder: "/p", items: [...items, { type: "assistant", id: "a2", text: "More." }] }} {...props} />);
      expect(top).toBe(2000);
      // The chat grows before the browser reports that move, which is then 200px from the end.
      height = 2700;
      fireEvent.scroll(chat);
      mine.cb();
      expect(top).toBe(2700);
      // And what was remembered is "at the end" (-1): coming back to this chat follows its end.
      expect(recallScroll("s1:chat")).toBe(-1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("announces that Claude is thinking while it runs", () => {
    render(<ChatView state={{ ...initialState, status: "running", folder: "/p", items }} onDecide={() => {}} onOpenFile={() => {}} />);
    expect(screen.getByRole("status", { name: "Claude is thinking" })).toBeInTheDocument();
  });

  it("goes to the end when you send, even if you'd scrolled up from it", () => {
    const props = { onDecide: () => {}, onOpenFile: () => {} };
    const { container, rerender } = render(<ChatView state={{ ...initialState, status: "idle", folder: "/p", items }} {...props} />);
    const chat = container.querySelector(".chat") as HTMLElement;
    Object.defineProperty(chat, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(chat, "clientHeight", { value: 500, configurable: true });
    let top = 0;
    Object.defineProperty(chat, "scrollTop", { get: () => top, set: (v: number) => (top = v), configurable: true });
    top = 600;
    fireEvent.scroll(chat);
    rerender(<ChatView state={{ ...initialState, status: "running", folder: "/p", items: [...items, { type: "user", id: "u2", text: "Also this" }] }} {...props} />);
    expect(top).toBe(2000);
  });
});
