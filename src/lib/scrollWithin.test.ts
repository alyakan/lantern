import { describe, expect, it, vi } from "vitest";
import { scrollWithin } from "./scrollWithin";

// jsdom lays nothing out: a 300px-tall container at the top of the window, scrolled down by 100px.
function setup(itemTop: number, itemHeight: number) {
  const container = document.createElement("div");
  const el = document.createElement("div");
  container.getBoundingClientRect = () => ({ top: 0, bottom: 300 }) as DOMRect;
  el.getBoundingClientRect = () => ({ top: itemTop, bottom: itemTop + itemHeight, height: itemHeight }) as DOMRect;
  Object.defineProperty(container, "clientHeight", { value: 300 });
  container.scrollTop = 100;
  container.scrollTo = vi.fn() as typeof container.scrollTo;
  return { container, el };
}

describe("scrollWithin", () => {
  it("scrolls the container just enough to show an item above or below it", () => {
    const up = setup(-20, 30);
    scrollWithin(up.container, up.el, "nearest");
    expect(up.container.scrollTo).toHaveBeenCalledWith({ top: 80, behavior: "auto" });

    const down = setup(290, 30);
    scrollWithin(down.container, down.el, "nearest");
    expect(down.container.scrollTo).toHaveBeenCalledWith({ top: 120, behavior: "auto" });
  });

  it("leaves the container alone when the item already shows", () => {
    const { container, el } = setup(50, 30);
    scrollWithin(container, el, "nearest");
    expect(container.scrollTo).not.toHaveBeenCalled();
  });

  it("can put the item in the middle", () => {
    const { container, el } = setup(500, 100);
    scrollWithin(container, el, "center", "smooth");
    expect(container.scrollTo).toHaveBeenCalledWith({ top: 500, behavior: "smooth" });
  });

  it("never scrolls the page", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { container, el } = setup(500, 100);
    scrollWithin(container, el, "center");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
