import { describe, expect, it } from "vitest";
import { dropIndex, settleOf, shiftOf } from "./useReorder";

// An expanded project (144 tall, and 6 to the next: its list's margin) above two folded ones (26 tall, 2 apart).
const tops = [0, 150, 178];
const heights = [144, 26, 26];
const spans = [150, 28, 28];

describe("reordering by dragging", () => {
  it("drops an item before the first other item whose middle it is above", () => {
    expect(dropIndex(tops, heights, 2, 0)).toBe(2);
    expect(dropIndex(tops, heights, 2, -110)).toBe(1);
    expect(dropIndex(tops, heights, 2, -120)).toBe(0);
    expect(dropIndex(tops, heights, 0, 140)).toBe(2);
  });

  it("moves the items it passes by its own span, the gap after it included", () => {
    expect([0, 1].map((i) => shiftOf(i, 2, 0, spans[2]))).toEqual([28, 28]);
    expect([1, 2].map((i) => shiftOf(i, 0, 2, spans[0]))).toEqual([-150, -150]);
    expect(shiftOf(2, 0, 1, spans[0])).toBe(0);
  });

  it("settles the dropped item exactly where the new order puts it, whatever the gaps", () => {
    // To the top: where the first one was.
    expect(tops[2] + settleOf(tops, spans, 2, 0)).toBe(0);
    // The expanded one to the bottom: after the two others, which moved up by its span (0 and 28), so at 56.
    expect(tops[0] + settleOf(tops, spans, 0, 2)).toBe(56);
    expect(settleOf(tops, spans, 1, 1)).toBe(0);
  });
});
