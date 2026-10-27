import { BUTTON, PIN_AT, follow, settle, swiping, trayWidth } from "./rowSwipe";

describe("when a drag is a swipe", () => {
  it("is not one until it has gone a little way, and is mostly sideways", () => {
    expect(swiping(4, 0)).toBe(false);
    expect(swiping(30, 30)).toBe(false);
    expect(swiping(30, 24)).toBe(false);
    expect(swiping(30, 8)).toBe(true);
    expect(swiping(-30, 8)).toBe(true);
  });
});

describe("where the row is while a finger has it", () => {
  const tray = trayWidth(2);
  it("follows the finger from where it began", () => {
    expect(follow(0, -40, tray, true)).toBe(-40);
    expect(follow(-tray, 50, tray, true)).toBe(-tray + 50);
  });
  it("drags harder past the end of the tray, and past the pin", () => {
    expect(follow(0, -tray - 100, tray, true)).toBeGreaterThan(-tray - 100);
    expect(follow(0, -tray - 100, tray, true)).toBeLessThan(-tray);
    expect(follow(0, PIN_AT + 100, tray, true)).toBeGreaterThan(PIN_AT);
    expect(follow(0, PIN_AT + 100, tray, true)).toBeLessThan(PIN_AT + 100);
  });
  it("does not go right for a row with nothing to pin", () => {
    expect(follow(0, 60, tray, false)).toBe(0);
  });
});

describe("what happens when the finger lifts", () => {
  const tray = trayWidth(2);
  it("pins when pulled right past the hint, and only for a row that can be pinned", () => {
    expect(settle(PIN_AT, 0, tray, true)).toBe("pin");
    expect(settle(PIN_AT - 1, 0, tray, true)).toBe("closed");
    expect(settle(PIN_AT + 20, 0, tray, false)).toBe("closed");
  });
  it("opens when pulled left a third of the way, or flicked left", () => {
    expect(settle(-tray / 3, 0, tray, true)).toBe("open");
    expect(settle(-20, 0, tray, true)).toBe("closed");
    expect(settle(-20, -0.8, tray, true)).toBe("open");
  });
  it("closes when an open tray is flicked or dragged back", () => {
    expect(settle(-tray, 0, tray, true)).toBe("open");
    expect(settle(-tray + 20, 0.9, tray, true)).toBe("closed");
    expect(settle(-20, 0, tray, true)).toBe("closed");
  });
  it("never opens a tray with no buttons", () => {
    expect(settle(-100, -2, 0, true)).toBe("closed");
  });
  it("makes a tray as wide as its buttons", () => {
    expect(trayWidth(1)).toBe(BUTTON);
    expect(trayWidth(0)).toBe(0);
  });
});
