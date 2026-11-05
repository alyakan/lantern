import { draftAt, shouldAsk } from "./cruise";

const s = (id: string) => ({ id, title: `T${id}`, why: "w", message: `m${id}`, target: { kind: "continue" as const, slot: "a" } });

describe("cruise", () => {
  it("asks only when it is on, the chat is idle, and this turn hasn't been asked for", () => {
    const on = { on: true, status: "idle" as const, asked: null, turnKey: "t1" };
    expect(shouldAsk(on)).toBe(true);
    // Off, working, waiting on you, asleep or stopped: never.
    for (const status of ["working", "needs_you", "asleep", "ended"] as const) expect(shouldAsk({ ...on, status })).toBe(false);
    expect(shouldAsk({ ...on, on: false })).toBe(false);
    // Nothing said yet: nothing to go on.
    expect(shouldAsk({ ...on, turnKey: "" })).toBe(false);
    // Already asked for this turn: wait for the next one.
    expect(shouldAsk({ ...on, asked: "t1" })).toBe(false);
    expect(shouldAsk({ ...on, asked: "t0" })).toBe(true);
  });

  it("shows one draft at a time, wrapping round, and none when there are none", () => {
    const items = [s("1"), s("2"), s("3")];
    expect(draftAt(items, 0)?.id).toBe("1");
    expect(draftAt(items, 1)?.id).toBe("2");
    expect(draftAt(items, 2)?.id).toBe("3");
    expect(draftAt(items, 3)?.id).toBe("1");
    expect(draftAt(items, -1)?.id).toBe("3");
    expect(draftAt([], 0)).toBeNull();
  });
});
