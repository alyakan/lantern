import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ModelsPicker } from "./ModelsPicker";
import { MessageInput } from "./MessageInput";
import { BUILT_IN, customOf } from "../lib/harness";

const customize = () => fireEvent.click(screen.getByRole("menuitem", { name: /Customize/ }));
const titles = () => screen.getAllByRole("menuitemradio").map((r) => r.querySelector(".menu-row-title")?.textContent);

describe("ModelsPicker (the model and effort choices)", () => {
  it("shows the running model and picks another", () => {
    const onChoose = vi.fn();
    render(<ModelsPicker running="claude-opus-5-5" chosen={null} onChoose={onChoose} />);
    fireEvent.click(screen.getByRole("button", { name: /Opus 5\.5/ }));
    expect(screen.getByRole("menuitemradio", { name: /Default/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Sonnet/ }));
    expect(onChoose).toHaveBeenCalledWith("sonnet");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("moves between the models with the arrow keys, and gives focus back to its chip when it closes", () => {
    render(<ModelsPicker running="claude-opus-5-5" chosen={null} onChoose={() => {}} />);
    const chip = screen.getByRole("button", { name: /Opus 5\.5/ });
    fireEvent.click(chip);
    const rows = screen.getAllByRole("menuitemradio");
    expect(rows[0]).toHaveFocus();
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(rows[1]).toHaveFocus();
    fireEvent.keyDown(rows[1], { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(chip).toHaveFocus();
  });

  it("shows the choice until the running model confirms it", () => {
    const { rerender } = render(<ModelsPicker running="claude-opus-5-5" chosen="haiku" onChoose={() => {}} />);
    expect(screen.getByRole("button", { name: /^Haiku 4\.5$/ })).toBeInTheDocument();
    rerender(<ModelsPicker running="claude-haiku-4-5-20251001" chosen="haiku" onChoose={() => {}} />);
    expect(screen.getByRole("button", { name: /Haiku 4\.5/ })).toBeInTheDocument();
  });

  it("names the model Default stands for", () => {
    // Nothing chosen: the running model is the default.
    const { unmount } = render(<ModelsPicker running="claude-opus-5-5" chosen={null} onChoose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Opus 5\.5/ }));
    expect(screen.getByRole("menuitemradio", { name: /Default/ })).toHaveTextContent("Default (Opus 5.5)Claude Code's setting");
    unmount();

    // Another model chosen: the default remembered from earlier.
    render(<ModelsPicker running="claude-haiku-4-5-20251001" chosen="haiku" defaultModel="claude-opus-5-5" onChoose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Haiku/ }));
    expect(screen.getByRole("menuitemradio", { name: /Default/ })).toHaveTextContent("Default (Opus 5.5)Claude Code's setting");
  });

  it("shows versions on the chip and every row, before claude has reported anything", () => {
    render(<ModelsPicker running={null} chosen={null} defaultModel="claude-opus-5-5" ids={{ sonnet: "claude-sonnet-6" }} onChoose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Opus 5\.5/ }));
    // Sonnet uses the id claude reported last time; the others fall back to the known ids.
    expect(titles()).toEqual(["Default (Opus 5.5)", "Opus 5.5", "Sonnet 6", "Haiku 4.5"]);
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
    const { rerender } = render(<ModelsPicker running={null} chosen={null} options={options} onChoose={onChoose} />);
    fireEvent.click(screen.getByRole("button", { name: /Opus 5\.5/ }));
    // Older versions start folded away.
    expect(titles()).toEqual(["Default (Opus 5.5)", "Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 4.5"]);
    const older = screen.getByRole("menuitem", { name: "Older models" });
    expect(older).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(older);
    expect(titles()).toEqual(["Default (Opus 5.5)", "Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 4.5", "Opus 4.8"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Fable 5\.1/ }));
    expect(onChoose).toHaveBeenCalledWith("claude-fable-5-1");
    // Its full id is the choice, and the chip names it.
    rerender(<ModelsPicker running="claude-opus-5-5" chosen="claude-fable-5-1" options={options} onChoose={onChoose} />);
    expect(screen.getByRole("button", { name: /^Fable 5\.1$/ })).toBeInTheDocument();
  });

  it("opens the older models when the one in use is among them", () => {
    const options = [
      { value: "default", resolved_model: "claude-opus-5-5", display_name: "Default (recommended)", description: "", effort_levels: [] },
      ...["opus", "claude-fable-5-1", "sonnet", "haiku"].map((value) => ({ value, resolved_model: value, display_name: value, description: "", effort_levels: [] })),
      { value: "claude-opus-4-8", resolved_model: "claude-opus-4-8", display_name: "Opus 4.8", description: "", effort_levels: [] },
    ];
    render(<ModelsPicker running={null} chosen="claude-opus-4-8" options={options} onChoose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Opus 4\.8/ }));
    expect(screen.getByRole("menuitem", { name: "Older models" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitemradio", { name: /Opus 4\.8/ })).toHaveAttribute("aria-checked", "true");
  });

  it("falls back to a hint when the default has never been seen", () => {
    render(<ModelsPicker running={null} chosen="sonnet" onChoose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Sonnet/ }));
    expect(screen.getByRole("menuitemradio", { name: /Default/ })).toHaveTextContent("Claude Code's setting");
  });

  it("does nothing when the current choice is picked again", () => {
    const onChoose = vi.fn();
    render(<ModelsPicker running={null} chosen="opus" onChoose={onChoose} />);
    fireEvent.click(screen.getByRole("button", { name: /Opus/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Opus/ }));
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("offers Default plus the levels the model supports, lowest first, and picks one", () => {
    const onChoose = vi.fn();
    render(<ModelsPicker running={null} chosen="opus" onChoose={() => {}} effort={{ chosen: null, levels: ["max", "low", "high"], onChoose }} />);
    fireEvent.click(screen.getByRole("button", { name: /Opus/ }));
    const menu = screen.getByRole("menu");
    const effortRows = within(menu).getAllByRole("menuitemradio").filter((r) => r.classList.contains("effort-row"));
    expect(effortRows.map((r) => r.querySelector(".menu-row-title")?.textContent)).toEqual(["Default", "Low", "High", "Max"]);
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Max/ }));
    expect(onChoose).toHaveBeenCalledWith("max");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("fills the effort bars to match the level", () => {
    render(<ModelsPicker running={null} chosen="opus" onChoose={() => {}} effort={{ chosen: "xhigh", levels: ["low", "medium", "high", "xhigh", "max"], onChoose: () => {} }} />);
    fireEvent.click(screen.getByRole("button", { name: /Opus/ }));
    const row = screen.getByRole("menuitemradio", { name: /Extra high/ });
    expect([...row.querySelectorAll("rect")].map((r) => r.getAttribute("opacity"))).toEqual(["1", "1", "1", "1", "0.28"]);
  });
});

describe("ModelsPicker (presets)", () => {
  const base = { running: "claude-sonnet-5-5", onChoose: vi.fn(), presets: BUILT_IN, onPreset: vi.fn() };

  it("shows the preset and the main model on one chip", () => {
    render(<ModelsPicker {...base} chosen="sonnet" preset="balanced" />);
    expect(screen.getByRole("button", { name: "Balanced · Sonnet 5.5" })).toBeInTheDocument();
  });

  it("lists the presets, switches one, and keeps Customize… and Edit presets… in the menu", () => {
    const onPreset = vi.fn();
    const onEdit = vi.fn();
    render(<ModelsPicker {...base} chosen={null} preset="default" onPreset={onPreset} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("button", { name: /Standard · Sonnet 5\.5/ }));
    const menu = screen.getByRole("menu", { name: "Models" });
    expect(within(menu).getByText("Sonnet · Opus advisor · Haiku subagents")).toBeInTheDocument();
    expect(titles()).toEqual(["Standard", "Balanced", "Thrifty", "Max"]);
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Balanced/ }));
    expect(onPreset).toHaveBeenCalledWith("balanced");
    fireEvent.click(screen.getByRole("button", { name: /Standard/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit presets…" }));
    expect(onEdit).toHaveBeenCalled();
  });

  it("Customize… opens the model and effort choices, with a way back to the presets", () => {
    const onChoose = vi.fn();
    render(<ModelsPicker {...base} chosen="sonnet" preset="balanced" onChoose={onChoose} effort={{ chosen: "high", levels: ["low", "high"], onChoose: () => {} }} />);
    fireEvent.click(screen.getByRole("button", { name: /Balanced/ }));
    customize();
    const menu = screen.getByRole("menu", { name: "Customize models" });
    expect(within(menu).getByText(/Balanced becomes Custom/)).toBeInTheDocument();
    expect(within(menu).getByText("Thinking effort")).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Presets" }));
    expect(screen.getByRole("menu", { name: "Models" })).toBeInTheDocument();
    customize();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Opus/ }));
    expect(onChoose).toHaveBeenCalledWith("opus");
  });

  it("says Custom, and what it was made from, when a model or effort was changed on a preset", () => {
    const custom = customOf(BUILT_IN[1], { model: "opus" });
    expect(custom).toMatchObject({ id: "custom", name: "Custom", from: "Balanced", model: "opus", advisor: "opus" });
    // Customizing a Custom one keeps what it began as.
    expect(customOf(custom, { effort: "low" }).from).toBe("Balanced");
    render(<ModelsPicker {...base} running="claude-opus-5-5" chosen="opus" presets={[...BUILT_IN, custom]} preset="custom" />);
    const chip = screen.getByRole("button", { name: "Custom · Opus 5.5" });
    expect(chip).toHaveAttribute("title", expect.stringContaining("Custom (Balanced, changed)"));
    fireEvent.click(chip);
    expect(screen.getByRole("menuitemradio", { name: /Custom/ })).toHaveTextContent("Balanced, changed");
    customize();
    expect(screen.getByText(/Custom \(Balanced, changed\):/)).toBeInTheDocument();
  });

  it("without presets (no folder yet) the menu is just the model and effort choices", () => {
    render(<ModelsPicker running={null} chosen="opus" onChoose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Opus/ }));
    expect(screen.queryByRole("menuitem", { name: /Customize/ })).toBeNull();
    expect(screen.getByRole("menu", { name: "Customize models" })).toBeInTheDocument();
  });
});

describe("MessageInput models chip", () => {
  const option = (value: string, effort_levels: string[]) => ({ value, resolved_model: value, display_name: value, description: "", effort_levels });
  const options = [option("default", ["low", "high"]), option("haiku", [])];

  it("replaces the model, effort and harness chips with one", () => {
    const models = { chosen: null as string | null, onChoose: () => {}, options };
    const effort = { chosen: null, onChoose: () => {} };
    const harness = { presets: BUILT_IN, chosen: "balanced", onChoose: () => {} };
    render(<MessageInput status="idle" model="claude-sonnet-5-5" onSend={() => {}} onStop={() => {}} models={models} effort={effort} harness={harness} />);
    expect(screen.getAllByRole("button", { name: /Balanced/ })).toHaveLength(1);
    expect(screen.queryByTitle(/Thinking effort/)).toBeNull();
    expect(screen.queryByTitle(/^Harness/)).toBeNull();
  });

  it("shows the chosen model's levels under Customize…, and none for a model with no effort setting", () => {
    const models = { chosen: null as string | null, onChoose: () => {}, options };
    const effort = { chosen: null, onChoose: () => {} };
    const { rerender } = render(<MessageInput status="idle" onSend={() => {}} onStop={() => {}} models={models} effort={effort} />);
    fireEvent.click(screen.getByRole("button", { name: /Models|default/ }));
    const menu = screen.getByRole("menu", { name: "Customize models" });
    expect(within(menu).getAllByRole("menuitemradio").filter((r) => r.classList.contains("effort-row")).map((r) => r.querySelector(".menu-row-title")?.textContent)).toEqual(["Default", "Low", "High"]);
    rerender(<MessageInput status="idle" onSend={() => {}} onStop={() => {}} models={{ ...models, chosen: "haiku" }} effort={effort} />);
    expect(screen.queryByText("Thinking effort")).toBeNull();
  });
});
