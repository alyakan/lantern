import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProviderModels } from "./ProviderModels";

const MODELS = [
  { value: "gpt-5", display_name: "GPT-5", description: "", resolved_model: "gpt-5", effort_levels: [] },
  { value: "gpt-5-mini", display_name: "GPT-5 mini", description: "", resolved_model: "gpt-5-mini", effort_levels: [] },
];

describe("Models for a provider that isn't Claude Code", () => {
  it("offers its own models, and names whose default it is", () => {
    const onChoose = vi.fn();
    render(<ProviderModels agent="Codex" options={MODELS} chosen={null} onChoose={onChoose} />);
    expect(screen.getByRole("heading", { name: "Models" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Codex's default" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "gpt-5" } });
    expect(onChoose).toHaveBeenCalledWith("gpt-5");
  });

  it("offers thinking effort when the provider takes one", () => {
    const onEffort = vi.fn();
    render(<ProviderModels agent="Codex" options={MODELS} chosen="gpt-5" onChoose={() => {}} effort={{ chosen: "high", levels: ["low", "medium", "high"], onChoose: onEffort }} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Thinking effort" }), { target: { value: "low" } });
    expect(onEffort).toHaveBeenCalledWith("low");
  });

  it("is read-only with no chat open", () => {
    render(<ProviderModels agent="Codex" options={MODELS} chosen={null} onChoose={() => {}} disabled />);
    expect(screen.getByRole("combobox", { name: "Model" })).toBeDisabled();
    expect(screen.getByText("Open a chat to change its model.")).toBeInTheDocument();
  });
});
