import { memo } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { useSteady } from "./steady";

describe("useSteady", () => {
  it("keeps the same functions across renders, so a memoised row isn't drawn again, and calls the latest", () => {
    const drawn = vi.fn();
    const Row = memo(function Row({ onPick }: { onPick: (n: number) => string }) {
      drawn();
      return <button onClick={() => onPick(1)}>{onPick(1)}</button>;
    });
    function Parent({ word }: { word: string }) {
      // A new closure every render, as App's are.
      const handlers = useSteady({ onPick: (n: number) => `${word} ${n}` });
      return <Row onPick={handlers.onPick} />;
    }
    const { rerender, getByRole } = render(<Parent word="first" />);
    rerender(<Parent word="second" />);
    rerender(<Parent word="third" />);
    expect(drawn).toHaveBeenCalledTimes(1);
    expect(getByRole("button").textContent).toBe("first 1");
  });

  it("calls the closure from the latest render", () => {
    const seen: string[] = [];
    let steady: { onPick: () => void } | null = null;
    function Parent({ word }: { word: string }) {
      steady = useSteady({ onPick: () => seen.push(word) });
      return null;
    }
    const { rerender } = render(<Parent word="a" />);
    const first = steady!;
    rerender(<Parent word="b" />);
    expect(steady).toBe(first);
    first.onPick();
    expect(seen).toEqual(["b"]);
  });
});
