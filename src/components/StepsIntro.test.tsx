import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StepsIntro } from "./StepsIntro";

describe("StepsIntro", () => {
  it("says what the flavour does and its stages, and switches flavour", () => {
    const onFlavour = vi.fn();
    const { rerender } = render(<StepsIntro mode="steps" onFlavour={onFlavour} />);
    const intro = screen.getByRole("region", { name: "Step by step" });
    expect(intro).toHaveTextContent("one small step at a time");
    expect(intro).toHaveTextContent("Builds it when you say Next");
    expect(screen.getByRole("radio", { name: "Build" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Review" }));
    expect(onFlavour).toHaveBeenCalledWith("review");
    rerender(<StepsIntro mode="review" onFlavour={onFlavour} />);
    expect(intro).toHaveTextContent("one file at a time");
    expect(screen.getByRole("radio", { name: "Review" })).toHaveAttribute("aria-checked", "true");
  });
});
