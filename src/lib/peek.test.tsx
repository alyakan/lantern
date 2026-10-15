import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { PEEK_DELAY_MS, PEEK_SLIDE_MS, usePeek } from "./peek";

// Plain fake timers: the hook only uses setTimeout, and nothing here awaits a promise.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("usePeek", () => {
  it("opens once the pointer has rested on the edge for a moment, not before", () => {
    const { result } = renderHook(() => usePeek(true));
    act(() => result.current.hover());
    advance(PEEK_DELAY_MS - 1);
    expect(result.current.phase).toBe("off");
    advance(1);
    expect(result.current.phase).toBe("in");
  });

  it("does not open when the pointer passes through the edge", () => {
    const { result } = renderHook(() => usePeek(true));
    act(() => result.current.hover());
    advance(100);
    act(() => result.current.unhover());
    advance(1000);
    expect(result.current.phase).toBe("off");
  });

  it("slides away on close, and is gone once the slide is over", () => {
    const { result } = renderHook(() => usePeek(true));
    act(() => result.current.hover());
    advance(PEEK_DELAY_MS);
    act(() => result.current.close());
    expect(result.current.phase).toBe("out");
    advance(PEEK_SLIDE_MS);
    expect(result.current.phase).toBe("off");
  });

  it("closes on Escape, and listens for it only while it shows", () => {
    const { result } = renderHook(() => usePeek(true));
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(result.current.phase).toBe("off");
    act(() => result.current.hover());
    advance(PEEK_DELAY_MS);
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(result.current.phase).toBe("out");
  });

  it("can open again while it slides away", () => {
    const { result } = renderHook(() => usePeek(true));
    act(() => result.current.hover());
    advance(PEEK_DELAY_MS);
    act(() => result.current.close());
    act(() => result.current.hover());
    advance(PEEK_DELAY_MS);
    expect(result.current.phase).toBe("in");
    advance(PEEK_SLIDE_MS * 2);
    expect(result.current.phase).toBe("in");
  });

  it("is over at once when the sidebar is shown", () => {
    const { result, rerender } = renderHook(({ hidden }) => usePeek(hidden), { initialProps: { hidden: true } });
    act(() => result.current.hover());
    advance(PEEK_DELAY_MS);
    expect(result.current.phase).toBe("in");
    rerender({ hidden: false });
    expect(result.current.phase).toBe("off");
  });

  it("skips the wait for the slide under Reduce Motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    try {
      const { result } = renderHook(() => usePeek(true));
      act(() => result.current.hover());
      advance(PEEK_DELAY_MS);
      act(() => result.current.close());
      advance(0);
      expect(result.current.phase).toBe("off");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
