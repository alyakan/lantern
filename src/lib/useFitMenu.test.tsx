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
});
