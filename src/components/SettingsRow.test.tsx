import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsHint, SettingsRow } from "./SettingsRow";

describe("a settings row and its help", () => {
  it("draws the control with its words, and the help under it", () => {
    render(<SettingsRow lead label="Keep awake" control={<input type="checkbox" aria-label="Keep awake" defaultChecked />} hint="Stops the Mac sleeping." />);
    expect(screen.getByRole("checkbox", { name: "Keep awake" })).toBeChecked();
    expect(screen.getByText("Stops the Mac sleeping.")).toBeInTheDocument();
  });

  it("keeps a long help clamped until More, and lets it out", () => {
    const long = "A".repeat(200);
    render(<SettingsHint>{long}</SettingsHint>);
    const more = screen.getByRole("button", { name: "More" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(long)).toHaveClass("clamped");
    fireEvent.click(more);
    expect(screen.getByRole("button", { name: "Less" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(long)).not.toHaveClass("clamped");
  });

  it("offers no More for a short help", () => {
    render(<SettingsHint>Short.</SettingsHint>);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
