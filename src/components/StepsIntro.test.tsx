import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StepsIntro } from "./StepsIntro";

describe("StepsIntro", () => {
  it("shows what to ask for each flavour, Learn included, and picks one or none", () => {
    const onPick = vi.fn();
    const { rerender } = render(<StepsIntro picked={null} onPick={onPick} />);
    const intro = screen.getByRole("region", { name: "Step by step" });
    expect(intro).toHaveTextContent("Claude suggests how to work");
    expect(screen.getByRole("button", { name: /Learn.*interview/ })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: /Review/ }));
    expect(onPick).toHaveBeenLastCalledWith("review");
    rerender(<StepsIntro picked="review" onPick={onPick} />);
    expect(screen.getByRole("button", { name: /Review/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /Review/ }));
    expect(onPick).toHaveBeenLastCalledWith(null);
  });
});
