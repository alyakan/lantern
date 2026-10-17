import { act, render, screen } from "@testing-library/react";
import { memo } from "react";
import { describe, expect, it } from "vitest";
import { initialState, type State } from "../store";
import { ChatStoreContext, createChatStore, createOffScreen, OffScreenContext, useChatState, useChatStateWhile, useOnScreen } from "./canvasContext";

const chat = (text: string): State => ({ ...initialState, items: [{ type: "user", id: "u", text }] });

describe("the chat store", () => {
  it("redraws only the agent whose chat changed", () => {
    const store = createChatStore();
    const a = chat("a");
    const b = chat("b");
    store.set({ a, b });
    const renders: Record<string, number> = { a: 0, b: 0 };
    const Agent = memo(function Agent({ slot }: { slot: string }) {
      const s = useChatState(slot);
      renders[slot]++;
      return <p data-testid={slot}>{s?.items[0]?.type === "user" ? s.items[0].text : ""}</p>;
    });
    render(
      <ChatStoreContext.Provider value={store}>
        <Agent slot="a" />
        <Agent slot="b" />
      </ChatStoreContext.Provider>,
    );
    expect(renders).toEqual({ a: 1, b: 1 });
    act(() => store.set({ a, b: chat("b2") }));
    expect(renders).toEqual({ a: 1, b: 2 });
    expect(screen.getByTestId("b").textContent).toBe("b2");
    expect(screen.getByTestId("a").textContent).toBe("a");
    // The same chats again redraw nothing.
    const same = { a, b: store.get("b")! };
    act(() => store.set(same));
    expect(renders).toEqual({ a: 1, b: 2 });
  });

  it("gives nothing for a chat that is gone, and stops listening when an agent leaves", () => {
    const store = createChatStore();
    store.set({ a: chat("a") });
    function Agent() {
      return <p data-testid="x">{useChatState("gone") ? "has" : "none"}</p>;
    }
    const { unmount } = render(
      <ChatStoreContext.Provider value={store}>
        <Agent />
      </ChatStoreContext.Provider>,
    );
    expect(screen.getByTestId("x").textContent).toBe("none");
    unmount();
    expect(() => act(() => store.set({}))).not.toThrow();
  });
});

describe("cards off the screen", () => {
  it("tells its subscribers only when the set of cards off the screen is different", () => {
    const off = createOffScreen();
    let told = 0;
    off.subscribe(() => told++);
    off.set(new Set(["a"]));
    off.set(new Set(["a"]));
    expect(told).toBe(1);
    expect(off.has("a")).toBe(true);
    off.set(new Set());
    expect(told).toBe(2);
    expect(off.has("a")).toBe(false);
  });

  it("keeps an agent's chat as it was while its card is off the screen, without redrawing, and catches up when it is back", () => {
    const store = createChatStore();
    store.set({ a: chat("one") });
    const off = createOffScreen();
    let renders = 0;
    const Agent = memo(function Agent({ slot }: { slot: string }) {
      const s = useChatStateWhile(slot, useOnScreen(slot));
      renders++;
      return <p data-testid={slot}>{s?.items[0]?.type === "user" ? s.items[0].text : ""}</p>;
    });
    render(
      <ChatStoreContext.Provider value={store}>
        <OffScreenContext.Provider value={off}>
          <Agent slot="a" />
        </OffScreenContext.Provider>
      </ChatStoreContext.Provider>,
    );
    expect(screen.getByTestId("a").textContent).toBe("one");
    act(() => off.set(new Set(["a"])));
    const before = renders;
    act(() => store.set({ a: chat("two") }));
    act(() => store.set({ a: chat("three") }));
    expect(renders).toBe(before);
    expect(screen.getByTestId("a").textContent).toBe("one");
    act(() => off.set(new Set()));
    expect(screen.getByTestId("a").textContent).toBe("three");
    act(() => store.set({ a: chat("four") }));
    expect(screen.getByTestId("a").textContent).toBe("four");
  });

  it("shows a chat's state once even when its card starts off the screen", () => {
    const store = createChatStore();
    store.set({ a: chat("hello") });
    const off = createOffScreen();
    off.set(new Set(["a"]));
    function Agent() {
      const s = useChatStateWhile("a", useOnScreen("a"));
      return <p data-testid="a">{s?.items[0]?.type === "user" ? s.items[0].text : ""}</p>;
    }
    render(
      <ChatStoreContext.Provider value={store}>
        <OffScreenContext.Provider value={off}>
          <Agent />
        </OffScreenContext.Provider>
      </ChatStoreContext.Provider>,
    );
    expect(screen.getByTestId("a").textContent).toBe("hello");
  });
});
