import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { backOf, HISTORY_MAX, pushed, useChatHistory } from "./chatHistory";

describe("the chat history", () => {
  it("keeps each chat once, newest on top, and only so many", () => {
    expect(pushed(["a", "b"], "a")).toEqual(["b", "a"]);
    const long = Array.from({ length: HISTORY_MAX }, (_, i) => `s${i}`);
    expect(pushed(long, "x")).toHaveLength(HISTORY_MAX);
    expect(pushed(long, "x")[HISTORY_MAX - 1]).toBe("x");
  });

  it("goes back to the newest chat still open, past closed ones and the one on screen", () => {
    const open = (s: string) => s !== "c";
    expect(backOf(["a", "b", "c"], "d", open)).toEqual({ to: "b", rest: ["a"] });
    expect(backOf(["a", "d"], "d", open)).toEqual({ to: "a", rest: [] });
    expect(backOf(["c"], "d", open)).toBeNull();
  });

  it("remembers every chat left, and going back doesn't add the one it leaves, so Back again goes further", () => {
    const shown: string[] = [];
    let active = "a";
    const { result, rerender } = renderHook(() => useChatHistory(active, () => true, (s) => shown.push(s)));
    expect(result.current.canGoBack).toBe(false);
    active = "b";
    rerender();
    active = "c";
    rerender();
    act(() => result.current.goBack());
    expect(shown).toEqual(["b"]);
    active = "b";
    rerender();
    act(() => result.current.goBack());
    expect(shown).toEqual(["b", "a"]);
    active = "a";
    rerender();
    expect(result.current.canGoBack).toBe(false);
  });
});
