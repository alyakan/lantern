import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SplitPane } from "./SplitPane";

describe("SplitPane", () => {
  it("hides the right pane and handle when collapsed", () => {
    render(<SplitPane left={<div>chat</div>} right={<div>review</div>} ratio={0.5} collapsed onRatio={() => {}} />);
    expect(screen.getByText("chat")).toBeInTheDocument();
    expect(screen.queryByText("review")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("keeps the pane mounted while it slides out, then removes it", () => {
    vi.useFakeTimers();
    const props = { left: <div>chat</div>, right: <div>review</div>, ratio: 0.5, onRatio: () => {} };
    const { rerender } = render(<SplitPane {...props} collapsed={false} />);
    rerender(<SplitPane {...props} collapsed />);
    expect(screen.getByText("review")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(400));
    expect(screen.queryByText("review")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
    rerender(<SplitPane {...props} collapsed={false} />);
    expect(screen.getByText("review")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("moves the panes while dragging and tells the app the ratio once, on release", () => {
    // jsdom has no PointerEvent, so pointer events would arrive without clientX.
    if (!("PointerEvent" in window)) (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = class extends MouseEvent {};
    const onRatio = vi.fn();
    const { container } = render(<SplitPane left={<div>chat</div>} right={<div>review</div>} ratio={0.5} collapsed={false} onRatio={onRatio} />);
    const split = container.querySelector(".split") as HTMLElement;
    split.getBoundingClientRect = () => ({ left: 0, width: 1200, top: 0, height: 800, right: 1200, bottom: 800, x: 0, y: 0, toJSON: () => ({}) });
    const handle = screen.getByRole("separator");
    handle.setPointerCapture = () => {};
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 600 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 480 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 420 });
    expect((container.querySelector(".split-left") as HTMLElement).style.flexBasis).toBe("35%");
    expect(onRatio).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(onRatio).toHaveBeenCalledTimes(1);
    expect(onRatio).toHaveBeenCalledWith(0.35);
  });

  it("resets to an even split on double-click", () => {
    const onRatio = vi.fn();
    render(<SplitPane left={<div>chat</div>} right={<div>review</div>} ratio={0.3} collapsed={false} onRatio={onRatio} />);
    fireEvent.doubleClick(screen.getByRole("separator"));
    expect(onRatio).toHaveBeenCalledWith(0.5);
  });
});
