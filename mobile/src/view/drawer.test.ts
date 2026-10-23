import { dragProgress, isSideways, settlesOpen, velocityOf } from "./drawer";

describe("a drag of the chats' column", () => {
  it("is sideways only when it has gone far enough, and mostly across", () => {
    expect(isSideways(30, 4)).toBe(true);
    expect(isSideways(-30, 10)).toBe(true);
    // Too short to tell from a tap, or a scroll that wobbles.
    expect(isSideways(6, 0)).toBe(false);
    expect(isSideways(30, 40)).toBe(false);
    expect(isSideways(30, 16)).toBe(false);
  });

  it("follows the finger from where the column was, and stops at its ends", () => {
    expect(dragProgress(0, 170, 340)).toBe(0.5);
    expect(dragProgress(0, 900, 340)).toBe(1);
    expect(dragProgress(0, -50, 340)).toBe(0);
    expect(dragProgress(1, -170, 340)).toBe(0.5);
    expect(dragProgress(1, 60, 340)).toBe(1);
    expect(dragProgress(1, -900, 340)).toBe(0);
  });

  it("settles by how far it got, and by the flick when the finger was quick", () => {
    expect(settlesOpen(0.6, 0)).toBe(true);
    expect(settlesOpen(0.4, 0)).toBe(false);
    // A flick to the right opens it from a short way; a flick to the left shuts it from most of the way.
    expect(settlesOpen(0.1, 0.8)).toBe(true);
    expect(settlesOpen(0.9, -0.8)).toBe(false);
    // A slow drift does not count as a flick.
    expect(settlesOpen(0.4, 0.2)).toBe(false);
  });

  it("measures how fast the finger went, and not from no time at all", () => {
    expect(velocityOf(0, 0, 80, 100)).toBe(0.8);
    expect(velocityOf(100, 50, 40, 100)).toBeCloseTo(-1.2);
    expect(velocityOf(0, 10, 50, 10)).toBe(0);
  });
});
