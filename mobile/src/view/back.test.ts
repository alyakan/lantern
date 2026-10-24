import { goesBack, pulled } from "./back";

describe("how far a screen has been pulled", () => {
  it("is the share of the width the finger has gone, from nothing to all of it", () => {
    expect(pulled(0, 400)).toBe(0);
    expect(pulled(100, 400)).toBe(0.25);
    expect(pulled(999, 400)).toBe(1);
  });

  it("is nothing for a finger going the other way, or a window with no width", () => {
    expect(pulled(-80, 400)).toBe(0);
    expect(pulled(50, 0)).toBe(0);
  });
});

describe("whether it goes back when the finger lifts", () => {
  it("does when it was pulled well over a third of the way, and not before", () => {
    expect(goesBack(0.5, 0)).toBe(true);
    expect(goesBack(0.3, 0)).toBe(false);
  });

  it("does on a flick to the right, wherever it is, and not on one to the left, however far it was pulled", () => {
    expect(goesBack(0.05, 0.9)).toBe(true);
    expect(goesBack(0.7, -0.9)).toBe(false);
  });
});
