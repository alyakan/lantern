import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { EffortPicker } from "./EffortPicker";
import { MessageInput } from "./MessageInput";

describe("EffortPicker", () => {
  it("offers Default plus the levels the model supports, lowest first, and picks one", () => {
    const onChoose = vi.fn();
    render(<EffortPicker chosen={null} levels={["max", "low", "high"]} onChoose={onChoose} />);
    fireEvent.click(screen.getByRole("button", { name: /Default/ }));
    expect(screen.getAllByRole("menuitemradio").map((r) => r.querySelector(".menu-row-title")?.textContent)).toEqual(["Default", "Low", "High", "Max"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Max/ }));
    expect(onChoose).toHaveBeenCalledWith("max");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("names the chosen level on the chip and fills its bars to match", () => {
    render(<EffortPicker chosen="xhigh" levels={["low", "medium", "high", "xhigh", "max"]} onChoose={() => {}} />);
    const chip = screen.getByRole("button", { name: /Extra high/ });
    const bars = [...chip.querySelectorAll("rect")].map((r) => r.getAttribute("opacity"));
    expect(bars).toEqual(["1", "1", "1", "1", "0.28"]);
  });
});

describe("MessageInput effort chip", () => {
  const option = (value: string, effort_levels: string[]) => ({ value, resolved_model: value, display_name: value, description: "", effort_levels });
  const options = [option("default", ["low", "high"]), option("haiku", [])];

  it("shows the chosen model's levels, and hides for a model with no effort setting", () => {
    const models = { chosen: null as string | null, onChoose: () => {}, options };
    const effort = { chosen: null, onChoose: () => {} };
    const { rerender } = render(<MessageInput status="idle" onSend={() => {}} onStop={() => {}} models={models} effort={effort} />);
    fireEvent.click(screen.getByTitle("Thinking effort: Default"));
    const menu = screen.getByRole("menu", { name: "Thinking effort" });
    expect([...menu.querySelectorAll(".menu-row-title")].map((t) => t.textContent)).toEqual(["Default", "Low", "High"]);
    rerender(<MessageInput status="idle" onSend={() => {}} onStop={() => {}} models={{ ...models, chosen: "haiku" }} effort={effort} />);
    expect(screen.queryByTitle(/Thinking effort/)).toBeNull();
  });
});
