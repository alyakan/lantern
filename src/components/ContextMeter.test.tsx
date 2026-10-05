import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
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
