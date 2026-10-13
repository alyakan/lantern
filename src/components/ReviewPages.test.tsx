import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ReviewSummaryTable, type ReviewedFinding } from "./ReviewPages";

const rows: ReviewedFinding[] = [{ path: "src/a.ts", finding: { index: 0, line: 3, lineEnd: null, severity: "nit", text: "Rename it" }, verdict: "agree" }];

describe("ReviewSummaryTable", () => {
  it("sends the actions as messages", () => {
    const onAction = vi.fn();
    render(<ReviewSummaryTable rows={rows} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Fix them" }));
    expect(onAction).toHaveBeenLastCalledWith(expect.stringMatching(/^Fix them:/));
    fireEvent.click(screen.getByRole("button", { name: "Write it up" }));
    expect(onAction).toHaveBeenLastCalledWith(expect.stringMatching(/^Write it up:/));
  });

  it("doesn't send them while Claude works, which would skip the queue", () => {
    const onAction = vi.fn();
    render(<ReviewSummaryTable rows={rows} onAction={onAction} busy />);
    expect(screen.getByRole("button", { name: "Fix them" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Write it up" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Fix them" }));
    expect(onAction).not.toHaveBeenCalled();
  });
});
