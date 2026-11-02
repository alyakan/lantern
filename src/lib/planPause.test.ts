import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { pauseEndsAt, loadPauseMemory, pauseAtPercent, pausedLine, pauseStep, pauseWarning, savePauseMemory, setPauseAtPercent, usePauseAtPercent, windowKey } from "./planPause";

const plan = (percent: number, resetsAt: number | null = 2_000_000) => ({ used: percent / 100, resetsAt });
const none = { paused: null, warned: null };

describe("the setting", () => {
  beforeEach(() => localStorage.clear());

  it("is off until the user sets it, and only Off, 90 and 95 are kept", () => {
    expect(pauseAtPercent()).toBe(0);
    localStorage.setItem("lantern.pauseAtPercent", "50");
    expect(pauseAtPercent()).toBe(0);
    setPauseAtPercent(80);
    expect(pauseAtPercent()).toBe(0);
    setPauseAtPercent(95);
    expect(pauseAtPercent()).toBe(95);
  });

  it("is heard by every place that reads it", () => {
    const { result } = renderHook(() => usePauseAtPercent());
    expect(result.current).toBe(0);
    act(() => setPauseAtPercent(90));
    expect(result.current).toBe(90);
  });
});

describe("pauseStep", () => {
  it("does nothing when the setting is off, or nothing is working", () => {
    expect(pauseStep(plan(99), 0, true, none)).toBeNull();
    expect(pauseStep(plan(99), 95, false, none)).toBeNull();
  });

  it("pauses at the limit, by the percentage the meter shows", () => {
    expect(pauseStep(plan(95), 95, true, none)).toBe("pause");
    expect(pauseStep({ used: 0.949, resetsAt: 1 }, 95, true, none)).toBe("pause");
    expect(pauseStep({ used: 0.944, resetsAt: 1 }, 95, true, none)).toBe("warn");
    expect(pauseStep(plan(90), 90, true, none)).toBe("pause");
  });

  it("warns from 5 points under the limit, and not before", () => {
    expect(pauseStep(plan(89), 95, true, none)).toBeNull();
    expect(pauseStep(plan(90), 95, true, none)).toBe("warn");
    expect(pauseStep(plan(94), 95, true, none)).toBe("warn");
    expect(pauseStep(plan(85), 90, true, none)).toBe("warn");
    expect(pauseStep(plan(84), 90, true, none)).toBeNull();
  });

  it("warns once and pauses once for each window, and again in the next", () => {
    const key = windowKey(plan(0));
    expect(pauseStep(plan(92), 95, true, { paused: null, warned: key })).toBeNull();
    expect(pauseStep(plan(96), 95, true, { paused: key, warned: key })).toBeNull();
    expect(pauseStep(plan(92, 3_000_000), 95, true, { paused: key, warned: key })).toBe("warn");
    expect(pauseStep(plan(96, 3_000_000), 95, true, { paused: key, warned: key })).toBe("pause");
  });

  it("tells a window with no reset time by the clock's five-hour block", () => {
    const at = 5 * 3600_000 * 10;
    expect(windowKey(plan(1, null), at + 1000)).toBe(windowKey(plan(1, null), at + 4 * 3600_000));
    expect(windowKey(plan(1, null), at + 1000)).not.toBe(windowKey(plan(1, null), at + 6 * 3600_000));
  });
});

describe("what is remembered", () => {
  beforeEach(() => localStorage.clear());

  it("is kept across a restart, and a damaged copy is forgotten", () => {
    expect(loadPauseMemory()).toEqual(none);
    savePauseMemory({ paused: "2000000", warned: "2000000" });
    expect(loadPauseMemory()).toEqual({ paused: "2000000", warned: "2000000" });
    localStorage.setItem("lantern.pauseMemory", "{not json");
    expect(loadPauseMemory()).toEqual(none);
    localStorage.setItem("lantern.pauseMemory", JSON.stringify({ paused: 5, warned: ["x"] }));
    expect(loadPauseMemory()).toEqual(none);
  });
});

describe("the words", () => {
  it("say how full the plan is and when it resets", () => {
    const now = 1_000_000_000;
    expect(pausedLine({ percent: 95, resetsAt: now / 1000 + 72 * 60 }, now)).toBe("Paused: your plan is 95% used, it resets in 1h 12m");
    expect(pausedLine({ percent: 95, resetsAt: null }, now)).toBe("Paused: your plan is 95% used");
    expect(pausedLine({ percent: 96, resetsAt: now / 1000 - 5 }, now)).toBe("Paused: your plan is 96% used, it is resetting now");
    expect(pauseWarning(90, 95)).toBe("Your plan is 90% used. Lantern will pause the teams' work at 95%.");
  });
});

it("does not invent a five-hour reset for Codex when none was reported", () => {
  expect(pauseEndsAt({ provider: "codex", resetsAt: null, since: 0 })).toBeNull();
  expect(pauseEndsAt({ provider: "codex", resetsAt: 100, since: 0 })).toBe(100000);
});
