import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QUIET_MINUTES_DEFAULT, quietMinutes, setQuietMinutes, useQuietAfter } from "./quietSetting";

describe("how long an agent may be quiet", () => {
  beforeEach(() => localStorage.clear());

  it("is 3 minutes until the user sets it, and only the offered choices are kept", () => {
    expect(quietMinutes()).toBe(QUIET_MINUTES_DEFAULT);
    expect(QUIET_MINUTES_DEFAULT).toBe(3);
    localStorage.setItem("lantern.quietMinutes", "4");
    expect(quietMinutes()).toBe(3);
    localStorage.setItem("lantern.quietMinutes", "nonsense");
    expect(quietMinutes()).toBe(3);
    setQuietMinutes(7);
    expect(quietMinutes()).toBe(3);
  });

  it("is saved, and every place that reads it hears of the change", () => {
    const { result } = renderHook(() => useQuietAfter());
    expect(result.current).toBe(3 * 60_000);
    act(() => setQuietMinutes(10));
    expect(quietMinutes()).toBe(10);
    expect(result.current).toBe(10 * 60_000);
  });
});
