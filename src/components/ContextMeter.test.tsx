import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ContextMeter, formatDuration } from "./ContextMeter";

afterEach(() => vi.useRealTimers());

describe("formatDuration", () => {
  it("reads naturally", () => {
    expect(formatDuration(4_230)).toBe("4.2s");
    expect(formatDuration(38_400)).toBe("38s");
    expect(formatDuration(125_000)).toBe("2m 05s");
  });
});

describe("ContextMeter", () => {
  it("shows only the percentage, with token counts and timing on hover", () => {
    render(<ContextMeter used={61_480} window={200_000} running={false} lastTurnMs={8_200} />);
    const meter = screen.getByLabelText("31% of context used");
    expect(meter.closest(".context-meter")).toHaveTextContent(/^31%$/);
    expect(meter.closest(".context-meter")).toHaveAttribute("title", "61,480 of 200,000 tokens of context used\nLast turn took 8.2s");
  });

  it("adds the session's cost and tokens so far to the tooltip, when there are any", () => {
    render(<ContextMeter used={61_480} window={200_000} running={false} lastTurnMs={null} session={{ cost: 0.9, tokens: 400_000 }} />);
    expect(screen.getByLabelText("31% of context used").closest(".context-meter")).toHaveAttribute("title", "61,480 of 200,000 tokens of context used\nThis chat so far: $0.90 · 400k tokens");
  });

  it("gives the session in tokens alone when no cost is billed", () => {
    render(<ContextMeter used={61_480} window={200_000} running={false} lastTurnMs={null} session={{ cost: null, tokens: 400_000 }} />);
    expect(screen.getByLabelText("31% of context used").closest(".context-meter")).toHaveAttribute("title", "61,480 of 200,000 tokens of context used\nThis chat so far: 400k tokens");
  });

  it("with no known window shows the tokens used, not a percent against a guess", () => {
    render(<ContextMeter used={312_000} window={null} running={false} lastTurnMs={null} />);
    const meter = screen.getByLabelText("312,000 tokens of context used, window not known yet");
    expect(meter.closest(".context-meter")).toHaveTextContent(/^312k$/);
    expect(meter.closest(".context-meter")).toHaveAttribute("title", "312,000 tokens of context used (the window isn't known until a turn ends)");
    expect(meter.closest(".context-meter")).not.toHaveClass("warn");
    expect(meter.closest(".context-meter")).not.toHaveClass("full");
  });

  it("shows nothing before any reply", () => {
    const { container } = render(<ContextMeter used={null} window={200_000} running={false} lastTurnMs={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("counts up while a turn runs", () => {
    vi.useFakeTimers();
    const { rerender } = render(<ContextMeter used={null} window={200_000} running lastTurnMs={null} />);
    expect(screen.getByText("0.0s")).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(12_000));
    expect(screen.getByText("12s")).toBeInTheDocument();
    rerender(<ContextMeter used={null} window={200_000} running={false} lastTurnMs={12_000} />);
    expect(screen.queryByText("12s")).toBeNull();
  });
});

describe("ContextMeter's warning", () => {
  const actions = { onCompact: vi.fn(), onClear: vi.fn() };
  const meter = (used: number, running = false) => <ContextMeter used={used} window={200_000} running={running} lastTurnMs={null} actions={actions} />;
  const at = (percent: number) => (percent / 100) * 200_000;

  it("turns amber at 75% and red at 90%, saying so in words", () => {
    const { container, rerender } = render(meter(at(74)));
    expect(container.querySelector(".context-meter")).not.toHaveClass("warn");
    expect(screen.queryByText(/Getting full|Nearly full/)).toBeNull();
    rerender(meter(at(75)));
    expect(container.querySelector(".context-meter")).toHaveClass("warn");
    expect(screen.getByRole("button", { name: "75% of context used, getting full" })).toBeInTheDocument();
    rerender(meter(at(90)));
    expect(container.querySelector(".context-meter")).toHaveClass("full");
    expect(screen.getByText("Nearly full")).toBeInTheDocument();
  });

  it("offers Compact and Clear once it warns, and sends each", () => {
    actions.onCompact.mockReset();
    actions.onClear.mockReset();
    render(meter(at(80)));
    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(actions.onCompact).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(actions.onClear).toHaveBeenCalledTimes(1);
  });

  it("offers them on a click of the meter below the warning, and folds them back", () => {
    render(meter(at(31)));
    expect(screen.queryByRole("button", { name: "Compact" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "31% of context used" }));
    expect(screen.getByRole("button", { name: "31% of context used" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Compact" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "31% of context used" }));
    expect(screen.queryByRole("button", { name: "Compact" })).toBeNull();
  });

  it("doesn't offer them while Claude works", () => {
    render(meter(at(95), true));
    expect(screen.queryByRole("button", { name: "Compact" })).toBeNull();
  });

  it("is plain text, with nothing to press, when no actions are given", () => {
    render(<ContextMeter used={at(95)} window={200_000} running={false} lastTurnMs={null} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Nearly full")).toBeInTheDocument();
  });
});
