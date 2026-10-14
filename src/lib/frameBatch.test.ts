import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { batchPerFrame } from "./frameBatch";

describe("batchPerFrame", () => {
  let frames: (() => void)[];
  beforeEach(() => {
    vi.useFakeTimers();
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames[id - 1] = () => {};
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const frame = () => frames.splice(0).forEach((f) => f());

  it("hands over everything that came in a frame together, in order, once", () => {
    const got: number[][] = [];
    const b = batchPerFrame<number>((items) => got.push(items));
    [1, 2, 3].forEach((n) => b.push(n));
    expect(got).toEqual([]);
    frame();
    expect(got).toEqual([[1, 2, 3]]);
    // Nothing is left to hand over later: the timer that backed the frame up found nothing.
    vi.advanceTimersByTime(200);
    expect(got).toEqual([[1, 2, 3]]);
    b.push(4);
    frame();
    expect(got).toEqual([[1, 2, 3], [4]]);
  });

  it("does not wait for a frame that never comes (a hidden window)", () => {
    const got: number[][] = [];
    const b = batchPerFrame<number>((items) => got.push(items), 50);
    b.push(1);
    b.push(2);
    vi.advanceTimersByTime(49);
    expect(got).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(got).toEqual([[1, 2]]);
    // And a frame arriving later for what was already handed over does nothing.
    frame();
    expect(got).toEqual([[1, 2]]);
  });

  it("can be flushed at once, and then waits for the next item to start over", () => {
    const got: string[][] = [];
    const b = batchPerFrame<string>((items) => got.push(items));
    b.push("a");
    b.flush();
    expect(got).toEqual([["a"]]);
    b.flush();
    expect(got).toEqual([["a"]]);
    b.push("b");
    frame();
    expect(got).toEqual([["a"], ["b"]]);
  });
});
