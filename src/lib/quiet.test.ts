import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QUIET_AFTER_MS, shortSpan, useQuiet } from "./quiet";

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
    expect(result.current).toBe("20s");
    // A new event starts it again.
    rerender({ since: Date.now(), working: true });
    expect(result.current).toBeNull();
    rerender({ since: 0, working: false });
    expect(result.current).toBeNull();
  });
});
