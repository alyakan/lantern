import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ModelPicker } from "./ModelPicker";

describe("ModelPicker", () => {
  it("shows the running model and picks another", () => {
    const onChoose = vi.fn();
    render(<ModelPicker running="claude-opus-5-5" chosen={null} onChoose={onChoose} />);
    fireEvent.click(screen.getByRole("button", { name: /Opus 5\.5/ }));
    expect(screen.getByRole("menuitemradio", { name: /Default/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Sonnet/ }));
    expect(onChoose).toHaveBeenCalledWith("sonnet");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("shows the choice until the running model confirms it", () => {
    const { rerender } = render(<ModelPicker running="claude-opus-5-5" chosen="haiku" onChoose={() => {}} />);
    expect(screen.getByRole("button", { name: /^Haiku 4\.5$/ })).toBeInTheDocument();
    rerender(<ModelPicker running="claude-haiku-4-5-20251001" chosen="haiku" onChoose={() => {}} />);
    expect(screen.getByRole("button", { name: /Haiku 4\.5/ })).toBeInTheDocument();
  });

  it("names the model Default stands for", () => {
    // Nothing chosen: the running model is the default.
    const { unmount } = render(<ModelPicker running="claude-opus-5-5" chosen={null} onChoose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Opus 5\.5/ }));
    expect(screen.getByRole("menuitemradio", { name: /Default/ })).toHaveTextContent("Default (Opus 5.5)Claude Code's setting");
    unmount();

    // Another model chosen: the default remembered from earlier.
    render(<ModelPicker running="claude-haiku-4-5-20251001" chosen="haiku" defaultModel="claude-opus-5-5" onChoose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Haiku/ }));
    expect(screen.getByRole("menuitemradio", { name: /Default/ })).toHaveTextContent("Default (Opus 5.5)Claude Code's setting");
  });

  it("shows versions on the chip and every row, before claude has reported anything", () => {
    render(<ModelPicker running={null} chosen={null} defaultModel="claude-opus-5-5" ids={{ sonnet: "claude-sonnet-6" }} onChoose={() => {}} />);
    const chip = screen.getByRole("button", { name: /Default \(Opus 5\.5\)/ });
    fireEvent.click(chip);
    const rows = screen.getAllByRole("menuitemradio").map((r) => r.querySelector(".menu-row-title")?.textContent);
    // Sonnet uses the id claude reported last time; the others fall back to the known ids.
    expect(rows).toEqual(["Default (Opus 5.5)", "Opus 5.5", "Sonnet 6", "Haiku 4.5"]);
  });

  it("offers the models claude lists, Fable included, with older versions below", () => {
    const options = [
      { value: "default", resolved_model: "claude-opus-5-5", display_name: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks", effort_levels: [] },
      { value: "opus", resolved_model: "claude-opus-5-5", display_name: "Opus 5.5", description: "For complex work and everyday tasks", effort_levels: [] },
      { value: "claude-fable-5-1", resolved_model: "claude-fable-5-1", display_name: "Fable 5.1", description: "For your toughest challenges", effort_levels: [] },
      { value: "sonnet", resolved_model: "claude-sonnet-5-5", display_name: "Sonnet 5.5", description: "Most efficient for simpler tasks", effort_levels: [] },
      { value: "haiku", resolved_model: "claude-haiku-4-5-20251001", display_name: "Haiku 4.5", description: "Fastest for quick answers", effort_levels: [] },
      { value: "claude-opus-4-8", resolved_model: "claude-opus-4-8", display_name: "Opus 4.8", description: "Best for everyday, complex tasks", effort_levels: [] },
    ];
    const onChoose = vi.fn();
    const { rerender } = render(<ModelPicker running={null} chosen={null} options={options} onChoose={onChoose} />);
    fireEvent.click(screen.getByRole("button", { name: /Default \(Opus 5\.5\)/ }));
    const titles = () => screen.getAllByRole("menuitemradio").map((r) => r.querySelector(".menu-row-title")?.textContent);
    // Older versions start folded away.
    expect(titles()).toEqual(["Default (Opus 5.5)", "Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 4.5"]);
    const older = screen.getByRole("button", { name: "Older models" });
    expect(older).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(older);
    expect(titles()).toEqual(["Default (Opus 5.5)", "Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 4.5", "Opus 4.8"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Fable 5\.1/ }));
    expect(onChoose).toHaveBeenCalledWith("claude-fable-5-1");
    // Its full id is the choice, and the chip names it.
    rerender(<ModelPicker running="claude-opus-5-5" chosen="claude-fable-5-1" options={options} onChoose={onChoose} />);
    expect(screen.getByRole("button", { name: /^Fable 5\.1$/ })).toBeInTheDocument();
  });

  it("opens the older models when the one in use is among them", () => {
    const options = [
      { value: "default", resolved_model: "claude-opus-5-5", display_name: "Default (recommended)", description: "", effort_levels: [] },
      ...["opus", "claude-fable-5-1", "sonnet", "haiku"].map((value) => ({ value, resolved_model: value, display_name: value, description: "", effort_levels: [] })),
      { value: "claude-opus-4-8", resolved_model: "claude-opus-4-8", display_name: "Opus 4.8", description: "", effort_levels: [] },
    ];
    render(<ModelPicker running={null} chosen="claude-opus-4-8" options={options} onChoose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Opus 4\.8/ }));
    expect(screen.getByRole("button", { name: "Older models" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitemradio", { name: /Opus 4\.8/ })).toHaveAttribute("aria-checked", "true");
  });

  it("falls back to a hint when the default has never been seen", () => {
    render(<ModelPicker running={null} chosen="sonnet" onChoose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Sonnet/ }));
    expect(screen.getByRole("menuitemradio", { name: /Default/ })).toHaveTextContent("Claude Code's setting");
  });

  it("does nothing when the current choice is picked again", () => {
    const onChoose = vi.fn();
    render(<ModelPicker running={null} chosen="opus" onChoose={onChoose} />);
    fireEvent.click(screen.getByRole("button", { name: /Opus/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Opus/ }));
    expect(onChoose).not.toHaveBeenCalled();
  });
});
