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
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 600, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 480, buttons: 1 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 420, buttons: 1 });
    expect((container.querySelector(".split-left") as HTMLElement).style.flexBasis).toBe("35%");
    expect(onRatio).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(onRatio).toHaveBeenCalledTimes(1);
    expect(onRatio).toHaveBeenCalledWith(0.35);
  });

  describe("dragging", () => {
    const setUp = (onRatio = vi.fn()) => {
      if (!("PointerEvent" in window)) (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = class extends MouseEvent {};
      const view = render(<SplitPane left={<div>chat</div>} right={<div>review</div>} ratio={0.5} collapsed={false} onRatio={onRatio} />);
      const split = view.container.querySelector(".split") as HTMLElement;
      split.getBoundingClientRect = () => ({ left: 0, width: 1200, top: 0, height: 800, right: 1200, bottom: 800, x: 0, y: 0, toJSON: () => ({}) });
      const handle = screen.getByRole("separator");
      handle.setPointerCapture = () => {};
      return { ...view, split, handle, onRatio, left: () => (view.container.querySelector(".split-left") as HTMLElement).style.flexBasis };
    };

    it("ignores a right-click, which doesn't move the panes", () => {
      const { handle, onRatio, left, split } = setUp();
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 600, button: 2 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400, buttons: 2 });
      expect(left()).toBe("50%");
      expect(split).not.toHaveClass("dragging");
      expect(onRatio).not.toHaveBeenCalled();
    });

    it("ends when the button is let go somewhere the handle didn't hear it", () => {
      const { handle, onRatio, left, split } = setUp();
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 600, button: 0 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 480, buttons: 1 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300, buttons: 0 });
      expect(split).not.toHaveClass("dragging");
      // The ratio reached is kept, as on a release, and moving on without the button doesn't carry the drag further.
      expect(onRatio).toHaveBeenCalledTimes(1);
      expect(onRatio).toHaveBeenCalledWith(0.4);
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 200, buttons: 0 });
      expect(left()).toBe("40%");
      expect(onRatio).toHaveBeenCalledTimes(1);
    });

    it("ends when the handle loses its pointer capture, and keeps the ratio it reached", () => {
      const { handle, onRatio, split } = setUp();
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 600, button: 0 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 480, buttons: 1 });
      fireEvent(handle, new Event("lostpointercapture", { bubbles: true }));
      expect(split).not.toHaveClass("dragging");
      expect(onRatio).toHaveBeenCalledWith(0.4);
    });

    it("ends, and keeps the ratio, when collapsed mid-drag, since the handle goes with it", () => {
      vi.useFakeTimers();
      const { handle, onRatio, split, rerender } = setUp();
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 600, button: 0 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 480, buttons: 1 });
      rerender(<SplitPane left={<div>chat</div>} right={<div>review</div>} ratio={0.5} collapsed onRatio={onRatio} />);
      expect(split).not.toHaveClass("dragging");
      expect(onRatio).toHaveBeenCalledWith(0.4);
      vi.useRealTimers();
    });
  });

  it("resets to an even split on double-click", () => {
    const onRatio = vi.fn();
    render(<SplitPane left={<div>chat</div>} right={<div>review</div>} ratio={0.3} collapsed={false} onRatio={onRatio} />);
    fireEvent.doubleClick(screen.getByRole("separator"));
    expect(onRatio).toHaveBeenCalledWith(0.5);
  });
});
