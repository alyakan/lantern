import { describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useState } from "react";

const parsed = vi.hoisted(() => ({ count: 0 }));
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => {
    parsed.count += 1;
    return <p>{children}</p>;
  },
}));

import { Md } from "./Md";

/** A streaming chat redraws every message each time one word arrives: a message that didn't change must not be parsed again. */
describe("Md", () => {
  it("does not parse an unchanged message again when its parent redraws", () => {
    let bump: () => void = () => {};
    function Stream() {
      const [words, setWords] = useState(1);
      bump = () => setWords((n) => n + 1);
      return (
        <>
          <Md>{"Retrying only idempotent requests keeps side effects safe."}</Md>
          <Md>{"word ".repeat(words)}</Md>
        </>
      );
    }
    const { container } = render(<Stream />);
    expect(parsed.count).toBe(2);
    for (let i = 0; i < 3; i++) act(() => bump());
    // Only the message that is still growing was parsed again.
    expect(container.querySelectorAll("p")).toHaveLength(2);
    expect(parsed.count).toBe(2 + 3);
  });
});
