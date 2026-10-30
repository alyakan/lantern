import { Animated, StyleSheet, Text } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { motion } from "../ui/motion";
import { ChangesDock, type ChangesDockProps, type DockMode } from "./ChangesDock";

const played = () => act(async () => void jest.advanceTimersByTime(1000));

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  motion.instant = true;
  jest.useRealTimers();
});

const room = { width: 1366, height: 1000, top: 24, bottom: 20 };
function props(mode: DockMode, over: Partial<ChangesDockProps> = {}): ChangesDockProps {
  return { mode, width: 683, room, onScrim: jest.fn(), onResizeStart: jest.fn(), onResize: jest.fn(), onResizeEnd: jest.fn(), onStep: jest.fn(), share: "50%", children: <Text>changes</Text>, ...over };
}
const frame = () => StyleSheet.flatten(screen.getByTestId("changes-dock", { includeHiddenElements: true }).props.style);

describe("the Changes beside a tablet's chat", () => {
  it("sit at the right edge, as wide as asked, the whole height", async () => {
    await render(<ChangesDock {...props("dock")} />);
    expect(frame()).toMatchObject({ left: 683, top: 0, width: 683, height: 1000 });
  });

  it("stay while they slide away, out of reach, and are gone once they have", async () => {
    motion.instant = false;
    const view = await render(<ChangesDock {...props("dock")} />);
    await view.rerender(<ChangesDock {...props("hidden")} />);
    expect(screen.queryByText("changes")).toBeNull();
    expect(screen.getByText("changes", { includeHiddenElements: true })).toBeTruthy();
    await played();
    expect(screen.queryByText("changes", { includeHiddenElements: true })).toBeNull();
    await view.unmount();
  });

  it("keep what they showed as they go, even when that is gone first", async () => {
    motion.instant = false;
    const view = await render(<ChangesDock {...props("dock", { children: <Text>chat a's changes</Text> })} />);
    await view.rerender(<ChangesDock {...props("hidden", { children: null })} />);
    expect(screen.getByText("chat a's changes", { includeHiddenElements: true })).toBeTruthy();
    await view.unmount();
  });

  it("are not there when never shown", async () => {
    await render(<ChangesDock {...props("hidden")} />);
    expect(screen.queryByText("changes", { includeHiddenElements: true })).toBeNull();
  });

  it("are dragged wider by their divider: the finger going left by as much as it moves", async () => {
    const p = props("dock");
    await render(<ChangesDock {...p} />);
    const divider = screen.getByTestId("changes-divider");
    await fireEvent(divider, "responderGrant", { nativeEvent: { pageX: 683 } });
    expect(p.onResizeStart).toHaveBeenCalled();
    await fireEvent(divider, "responderMove", { nativeEvent: { pageX: 600 } });
    expect(p.onResize).toHaveBeenLastCalledWith(766);
    await fireEvent(divider, "responderMove", { nativeEvent: { pageX: 800 } });
    expect(p.onResize).toHaveBeenLastCalledWith(566);
    await fireEvent(divider, "responderRelease", { nativeEvent: { pageX: 800 } });
    expect(p.onResizeEnd).toHaveBeenCalled();
  });

  it("are made wider or narrower by the screen reader's swipes on the divider, which says how wide they are", async () => {
    const p = props("dock");
    await render(<ChangesDock {...p} />);
    const divider = screen.getByLabelText("Width of the changes");
    expect(divider.props.accessibilityValue).toEqual({ text: "50%" });
    await fireEvent(divider, "accessibilityAction", { nativeEvent: { actionName: "increment" } });
    await fireEvent(divider, "accessibilityAction", { nativeEvent: { actionName: "decrement" } });
    expect(p.onStep).toHaveBeenNthCalledWith(1, 1);
    expect(p.onStep).toHaveBeenNthCalledWith(2, -1);
  });
});

describe("the Changes floated over a tablet's chat", () => {
  it("grow from beside the chat into a big card in the middle, with no divider, and shrink back", async () => {
    const view = await render(<ChangesDock {...props("dock")} />);
    await view.rerender(<ChangesDock {...props("float")} />);
    expect(frame()).toMatchObject({ left: 137, top: 91, width: 1093, height: 822 });
    expect(screen.queryByTestId("changes-divider")).toBeNull();
    await view.rerender(<ChangesDock {...props("dock")} />);
    expect(frame()).toMatchObject({ left: 683, top: 0, width: 683, height: 1000 });
  });

  it("move there on the native driver, laid out once where they land and carried from where they were, never resized as they go", async () => {
    motion.instant = false;
    const timing = jest.spyOn(Animated, "timing");
    const view = await render(<ChangesDock {...props("dock")} />);
    await view.rerender(<ChangesDock {...props("float")} />);
    expect(timing).toHaveBeenCalled();
    expect(timing.mock.calls.every(([, c]) => c.useNativeDriver)).toBe(true);
    // At the start it is the card's frame drawn where the pane was: half as wide, the whole height, at the right.
    const style = frame();
    expect(style).toMatchObject({ left: 137, top: 91, width: 1093, height: 822 });
    const scaleX = style.transform.find((t: object) => "scaleX" in t).scaleX;
    expect(scaleX).toBeCloseTo(683 / 1093);
    await played();
    expect(frame().transform.find((t: object) => "scaleX" in t).scaleX).toBe(1);
    timing.mockRestore();
    await view.unmount();
  });

  it("dim the chat around them, and a tap on it puts them away (the screen reader stays in the card, which has its own Hide)", async () => {
    const p = props("float");
    await render(<ChangesDock {...p} />);
    await fireEvent.press(screen.getByTestId("changes-scrim", { includeHiddenElements: true }));
    expect(p.onScrim).toHaveBeenCalled();
  });

  it("leave the chat alone while they are beside it", async () => {
    await render(<ChangesDock {...props("dock")} />);
    expect(screen.queryByRole("button", { name: "Close changes" })).toBeNull();
  });
});
