import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProviderDefaults } from "./ProviderModels";

const MODELS = [
  { value: "gpt-5", display_name: "GPT-5", description: "", resolved_model: "gpt-5", effort_levels: [] },
  { value: "gpt-5-mini", display_name: "GPT-5 mini", description: "", resolved_model: "gpt-5-mini", effort_levels: [] },
];

describe("the other providers' defaults in Settings → Models", () => {
  it("offers a provider's models, and names whose default it is", () => {
    const onChoose = vi.fn();
    render(<ProviderDefaults providers={[{ id: "codex", agent: "Codex", options: MODELS, chosen: null, onChoose }]} />);
    expect(screen.getByRole("heading", { name: "Codex" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Codex's default" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Codex model" }), { target: { value: "gpt-5" } });
    expect(onChoose).toHaveBeenCalledWith("gpt-5");
  });

  it("offers thinking effort when the provider takes one", () => {
    const onEffort = vi.fn();
    render(<ProviderDefaults providers={[{ id: "codex", agent: "Codex", options: MODELS, chosen: "gpt-5", onChoose: () => {}, effort: { chosen: "high", levels: ["low", "medium", "high"], onChoose: onEffort } }]} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Codex thinking effort" }), { target: { value: "low" } });
    expect(onEffort).toHaveBeenCalledWith("low");
  });

  it("draws every installed provider, one section each", () => {
    render(
      <ProviderDefaults
        providers={[
          { id: "codex", agent: "Codex", options: MODELS, chosen: null, onChoose: () => {} },
          { id: "gateway:ollama", agent: "Ollama", options: MODELS, chosen: null, onChoose: () => {} },
        ]}
      />,
    );
    expect(screen.getByRole("heading", { name: "Codex" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ollama" })).toBeInTheDocument();
  });
});
