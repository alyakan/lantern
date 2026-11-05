import { change, percent, tokens, wait } from "./insights";

describe("insights figures", () => {
  it("says tokens short", () => {
    expect(tokens(820)).toBe("820");
    expect(tokens(54_318)).toBe("54k");
    expect(tokens(9_140_000)).toBe("9.1M");
    expect(tokens(57_545_000)).toBe("58M");
  });

  it("says a change and whether it is good", () => {
    expect(change({ now: 175_000, before: 248_000 }, true)).toEqual({ text: "▼ 29%", good: true });
    expect(change({ now: 60_000, before: 54_000 }, true)).toEqual({ text: "▲ 11%", good: false });
    expect(change({ now: 54_300, before: 54_000 }, true)).toEqual({ text: "same", good: true });
    expect(change({ now: 0.91, before: 0.88 }, false, true)).toEqual({ text: "▲ 3 pts", good: true });
    expect(change({ now: 1, before: null }, true)).toBeNull();
  });

  it("says shares and waits plainly", () => {
    expect(percent(0.714)).toBe("71%");
    expect(wait(40_000)).toBe("40 s");
    expect(wait(6 * 60_000)).toBe("6 min");
    expect(wait(2 * 3_600_000)).toBe("2 h");
  });
});
