import { Text, View } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { AnimatedStack, type StackItem } from "./AnimatedStack";
import { motion } from "./motion";

const item = (key: string, kind: StackItem["kind"] = "push"): StackItem => ({ key, kind, element: <Text>{`screen ${key}`}</Text> });

afterEach(() => {
  motion.instant = true;
});

describe("the stack of screens", () => {
  it("has its first screens there at once, with the one beneath hidden from a screen reader", async () => {
    await render(<AnimatedStack items={[item("home"), item("chat")]} />);
    expect(screen.getByText("screen chat")).toBeTruthy();
    // Beneath the top one it can't be reached by touch or read out (the queries leave hidden things out, as a reader does).
    expect(screen.queryByText("screen home")).toBeNull();
    expect(screen.getByText("screen home", { includeHiddenElements: true })).toBeTruthy();
  });

  it("shows a new screen over the one before, which stays mounted beneath it", async () => {
    const view = await render(<AnimatedStack items={[item("home")]} />);
    await view.rerender(<AnimatedStack items={[item("home"), item("chat")]} />);
    expect(screen.getByText("screen chat")).toBeTruthy();
    expect(screen.getByText("screen home", { includeHiddenElements: true })).toBeTruthy();
  });

  it("takes a screen away when it is gone, and Home is the one to touch again", async () => {
    const view = await render(<AnimatedStack items={[item("home"), item("chat")]} />);
    await view.rerender(<AnimatedStack items={[item("home")]} />);
    expect(screen.queryByText("screen chat", { includeHiddenElements: true })).toBeNull();
    expect(screen.getByText("screen home")).toBeTruthy();
  });

  it("keeps a screen that left until its exit has played, out of reach meanwhile", async () => {
    motion.instant = false;
    const view = await render(<AnimatedStack items={[item("home"), item("chat")]} />);
    await view.rerender(<AnimatedStack items={[item("home")]} />);
    // Still drawn, sliding away, but not touchable or readable.
    expect(screen.queryByText("screen chat")).toBeNull();
    expect(screen.getByText("screen chat", { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByText("screen home")).toBeTruthy();
    await view.unmount();
  });

  it("slides a decision up from the bottom and a chat in from the right", async () => {
    const view = await render(<AnimatedStack items={[item("home")]} />);
    await view.rerender(<AnimatedStack items={[item("home"), item("decide", "modal")]} />);
    expect(screen.getByText("screen decide")).toBeTruthy();
    await view.rerender(<AnimatedStack items={[item("home"), item("decide", "modal"), item("chat", "push")]} />);
    expect(screen.getByText("screen chat")).toBeTruthy();
  });
});

describe("going back by dragging the top screen away", () => {
  const touch = (x: number, t: number) => ({ nativeEvent: { pageX: x, pageY: 400, timestamp: t } });
  const edge = () => screen.getByTestId("back-edge", { includeHiddenElements: true });
  // The test window is 750 wide.
  const pull = async (to: number, ms = 600) => {
    await fireEvent(edge(), "startShouldSetResponderCapture", touch(4, 0));
    await fireEvent(edge(), "responderGrant", touch(4, 0));
    await fireEvent(edge(), "responderMove", touch(4 + to / 2, ms / 2));
    await fireEvent(edge(), "responderMove", touch(4 + to, ms));
    await fireEvent(edge(), "responderRelease", touch(4 + to, ms));
  };

  it("has a strip at the edge over a screen that can go back, and none over Home alone", async () => {
    await render(<AnimatedStack items={[item("home")]} onBack={() => {}} />);
    expect(screen.queryByTestId("back-edge", { includeHiddenElements: true })).toBeNull();
    await render(<AnimatedStack items={[item("home"), item("chat")]} onBack={() => {}} />);
    expect(screen.getByTestId("back-edge", { includeHiddenElements: true })).toBeTruthy();
  });

  it("leaves a tap or a scroll at the edge to the screen (its Back button is there), and takes only a pull to the right", async () => {
    await render(<AnimatedStack items={[item("home"), item("chat")]} onBack={() => {}} />);
    const takes = (fromX: number, x: number, y: number) => {
      edge().props.onStartShouldSetResponderCapture(touch(fromX, 0));
      return edge().props.onMoveShouldSetResponderCapture({ nativeEvent: { pageX: x, pageY: y, timestamp: 10 } });
    };
    expect(edge().props.onStartShouldSetResponderCapture(touch(4, 0))).toBe(false);
    expect(takes(4, 60, 404)).toBe(true);
    expect(takes(4, 6, 480)).toBe(false);
    expect(takes(200, 300, 400)).toBe(false);
  });

  it("takes the pull from the stack's own edge where the stack doesn't start at the window's (an iPad's chats pinned beside it)", async () => {
    const measure = jest.spyOn(View.prototype as unknown as { measureInWindow: (cb: (x: number) => void) => void }, "measureInWindow").mockImplementation((cb) => cb(340));
    await render(<AnimatedStack items={[item("home"), item("chat")]} onBack={() => {}} />);
    await fireEvent(edge(), "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 700, height: 800 } } });
    edge().props.onStartShouldSetResponderCapture(touch(345, 0));
    expect(edge().props.onMoveShouldSetResponderCapture({ nativeEvent: { pageX: 420, pageY: 404, timestamp: 10 } })).toBe(true);
    // The window's edge is the chats' there, not this stack's.
    edge().props.onStartShouldSetResponderCapture(touch(4, 0));
    expect(edge().props.onMoveShouldSetResponderCapture({ nativeEvent: { pageX: 80, pageY: 404, timestamp: 10 } })).toBe(false);
    measure.mockRestore();
  });

  it("has no strip where nothing is told to go back", async () => {
    await render(<AnimatedStack items={[item("home"), item("chat")]} />);
    expect(screen.queryByTestId("back-edge", { includeHiddenElements: true })).toBeNull();
  });

  it("goes back when a chat is pulled far enough, and stays when it is let go early", async () => {
    const onBack = jest.fn();
    await render(<AnimatedStack items={[item("home"), item("chat")]} onBack={onBack} />);
    await pull(150);
    expect(onBack).not.toHaveBeenCalled();
    await pull(450);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("goes back on a quick flick even a short way, and not on a quick flick to the left", async () => {
    const onBack = jest.fn();
    await render(<AnimatedStack items={[item("home"), item("chat")]} onBack={onBack} />);
    await pull(120, 100);
    expect(onBack).toHaveBeenCalledTimes(1);
    await fireEvent(edge(), "responderGrant", touch(200, 0));
    await fireEvent(edge(), "responderMove", touch(120, 100));
    await fireEvent(edge(), "responderRelease", touch(120, 100));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("takes a decision off the same way", async () => {
    const onBack = jest.fn();
    await render(<AnimatedStack items={[item("home"), item("chat"), item("decide", "modal")]} onBack={onBack} />);
    await pull(150);
    expect(onBack).not.toHaveBeenCalled();
    await pull(450);
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
