import { describe, expect, it } from "vitest";
import { anchorOf, scrollToAnchor } from "./scrollAnchor";

/**
 * A chat laid out by hand (jsdom has no layout): each turn is a pinned prompt and rows of the given heights, stacked from
 * the top; the scroller's view starts at its scrollTop.
 */
function chat(turns: { id: string; head: number; rows: number[] }[]) {
  const scroller = document.createElement("div");
  let y = 0;
  const place = (el: HTMLElement, top: number, height: number) => {
    el.getBoundingClientRect = () => ({ top: top - scroller.scrollTop, bottom: top + height - scroller.scrollTop, height } as DOMRect);
  };
  for (const t of turns) {
    const section = document.createElement("section");
    section.dataset.turn = t.id;
    const start = y;
    const head = document.createElement("div");
    head.className = "turn-head";
    section.appendChild(head);
    y += t.head;
    for (const h of t.rows) {
      const row = document.createElement("div");
      place(row, y, h);
      section.appendChild(row);
      y += h;
    }
    place(section, start, y - start);
    scroller.appendChild(section);
  }
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 400, height: 400 } as DOMRect);
  return scroller;
}

describe("a chat's place", () => {
  it("is the turn, the row and how far down it, and comes back to the same text when the rows' heights change", () => {
    const narrow = chat([
      { id: "t1", head: 40, rows: [200, 300] },
      { id: "t2", head: 40, rows: [400, 100] },
    ]);
    // Halfway down t2's first row: 40 + 200 + 300 + 40 + 200.
    narrow.scrollTop = 780;
    const anchor = anchorOf(narrow)!;
    expect(anchor).toEqual({ turn: "t2", row: 1, within: 0.5 });
    // Wider, every row is half as tall: the same place is 20 + 100 + 150 + 40 + 100 down, not 780.
    const wide = chat([
      { id: "t1", head: 40, rows: [100, 150] },
      { id: "t2", head: 40, rows: [200, 50] },
    ]);
    expect(scrollToAnchor(wide, anchor)).toBe(true);
    expect(wide.scrollTop).toBe(40 + 100 + 150 + 40 + 100);
  });

  it("is the turn's top, in pixels, when the view starts above its first row", () => {
    const scroller = chat([
      { id: "t1", head: 40, rows: [200] },
      { id: "t2", head: 60, rows: [100] },
    ]);
    scroller.scrollTop = 250;
    expect(anchorOf(scroller)).toEqual({ turn: "t2", row: -1, within: 10 });
  });

  it("leaves the view alone when the turn isn't there", () => {
    const scroller = chat([{ id: "t1", head: 40, rows: [200] }]);
    scroller.scrollTop = 30;
    expect(scrollToAnchor(scroller, { turn: "gone", row: 1, within: 0.5 })).toBe(false);
    expect(scroller.scrollTop).toBe(30);
  });
});
