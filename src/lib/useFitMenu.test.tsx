import { describe, expect, it } from "vitest";
import { useRef } from "react";
import { render } from "@testing-library/react";
import { useFitMenu } from "./useFitMenu";

/** A dropdown `height` tall that opens at `top`, under a button at `anchor`, in a window 800 tall. */
function open(top: number, height: number, anchor: number) {
  window.innerHeight = 800;
  const Menu = () => {
    const ref = useRef<HTMLDivElement>(null);
    useFitMenu(ref);
    return (
      <div className="anchor">
        <div className="menu" ref={(el) => {
          if (el) {
            el.getBoundingClientRect = () => ({ top, bottom: top + height, height }) as DOMRect;
            el.parentElement!.getBoundingClientRect = () => ({ top: anchor, bottom: anchor + 24, height: 24 }) as DOMRect;
          }
          ref.current = el;
        }} />
      </div>
    );
  };
  const { container } = render(<Menu />);
  return container.querySelector<HTMLElement>(".menu")!;
}

describe("a dropdown kept inside the window", () => {
  it("is left as styled when it fits below", () => {
    const menu = open(100, 300, 70);
    expect(menu.style.bottom).toBe("");
    expect(menu.style.maxHeight).toBe("");
  });

  it("opens upward, no taller than the room above, when there's more room there", () => {
    // Below: 800 - 500 - 12 = 288. Above the button at 470: 470 - 6 - 12 = 452.
    const menu = open(500, 480, 470);
    expect(menu.style.bottom).toBe("calc(100% + 6px)");
    expect(menu.style.maxHeight).toBe("452px");
  });

  it("stays below, capped to the room there, when there's more room below", () => {
    const menu = open(200, 700, 170);
    expect(menu.style.bottom).toBe("");
    expect(menu.style.maxHeight).toBe("588px");
  });

  // The menus under the chat box are styled to open upward: the button is at `anchor`, the menu ends just above it.
  it("is left as styled when it opens upward and fits", () => {
    const menu = open(60, 390, 456);
    expect(menu.style.top).toBe("");
    expect(menu.style.maxHeight).toBe("");
  });

  it("opens upward, capped to the room above, when it would stick out of the top", () => {
    // Above the button at 456: 456 - 6 - 12 = 438. Below it: 800 - 480 - 6 - 12 = 302.
    const menu = open(-30, 480, 456);
    expect(menu.style.bottom).toBe("");
    expect(menu.style.maxHeight).toBe("438px");
  });

  it("opens downward instead when an upward menu has more room below", () => {
    // Above the button at 300: 300 - 6 - 12 = 282. Below it: 800 - 324 - 6 - 12 = 458.
    const menu = open(-170, 460, 300);
    expect(menu.style.top).toBe("calc(100% + 6px)");
    expect(menu.style.bottom).toBe("auto");
    expect(menu.style.maxHeight).toBe("458px");
  });
});
