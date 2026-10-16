import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { initialState, type State } from "../store";
import { QUIET_AFTER_MS, STUCK_AFTER_MS, longSpan, quietFor, shortSpan, useQuiet } from "./quiet";

afterEach(() => vi.useRealTimers());

describe("how long an agent at work has been quiet", () => {
  it("is said short", () => {
    expect([shortSpan(9_000), shortSpan(61_000), shortSpan(3 * 3600_000 + 5)]).toEqual(["9s", "1m", "3h"]);
  });

  it("shows only while working, once it's been quiet a while, and keeps counting", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const { result, rerender } = renderHook(({ since, working }) => useQuiet(since, working), { initialProps: { since: 100_000 as number | null, working: true } });
    expect(result.current).toBeNull();
    act(() => vi.advanceTimersByTime(QUIET_AFTER_MS + 5_000));
    expect(result.current).toEqual({ ms: 20_000, span: "20s", stuck: false });
    // Three minutes without a word is stuck, as far as anyone can tell.
    act(() => vi.advanceTimersByTime(STUCK_AFTER_MS));
    expect(result.current).toEqual({ ms: 200_000, span: "3m", stuck: true });
    // A new event starts it again.
    rerender({ since: Date.now(), working: true });
    expect(result.current).toBeNull();
    rerender({ since: 0, working: false });
    expect(result.current).toBeNull();
  });

  it("is stuck after the time the user chose", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const { result } = renderHook(() => useQuiet(100_000, true, 10 * 60_000));
    act(() => vi.advanceTimersByTime(STUCK_AFTER_MS + 5_000));
    expect(result.current?.stuck).toBe(false);
    act(() => vi.advanceTimersByTime(7 * 60_000));
    expect(result.current?.stuck).toBe(true);
  });

  it("is said long, for a sentence", () => {
    expect([longSpan(1_000), longSpan(45_000), longSpan(4 * 60_000 + 20_000), longSpan(3600_000), longSpan(3600_000 + 5 * 60_000)]).toEqual(["1 second", "45 seconds", "4 min", "1 h", "1 h 5 min"]);
  });
});

describe("quietFor", () => {
  const working: State = { ...initialState, status: "running", activityAt: 1_000 };
  it("is how long a working chat has said nothing, once that reaches the limit", () => {
    expect(quietFor(working, 1_000 + 180_000, 180_000)).toBe(180_000);
    expect(quietFor(working, 1_000 + 179_000, 180_000)).toBeNull();
  });

  it("is nothing for a chat that isn't working, is waiting on the user, or hasn't been heard from", () => {
    expect(quietFor({ ...working, status: "idle" }, 999_999, 180_000)).toBeNull();
    expect(quietFor({ ...working, activityAt: null }, 999_999, 180_000)).toBeNull();
    const asking: State = { ...working, items: [{ type: "permission", id: "p", toolName: "Bash", input: {}, decision: null }] };
    expect(quietFor(asking, 999_999, 180_000)).toBeNull();
  });
});
