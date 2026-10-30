import { Animated } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { SwipeToAllow } from "./SwipeToAllow";
import { lightColors as colors } from "./theme";

const BAR = 300;
// The bar is 300 wide, the knob 52 with 5 around it: it travels 238.
const MAX = BAR - 52 - 10;

async function bar() {
  const x = new Animated.Value(0);
  await render(<SwipeToAllow onAllow={jest.fn()} progress={x} />);
  // The measuring view is the bar's parent: the bar inside it is what shrinks.
  await fireEvent(screen.getByRole("button", { name: "Swipe to allow" }).parent!, "layout", { nativeEvent: { layout: { width: BAR, height: 62, x: 0, y: 0 } } });
  return x;
}

const style = (id: string) => screen.getByTestId(id).props.style as Record<string, number | string>;
const flat = (id: string) => Object.assign({}, ...[style(id)].flat(Infinity));

const activate = () => fireEvent(screen.getByRole("button", { name: "Swipe to allow" }), "accessibilityAction", { nativeEvent: { actionName: "activate" } });

describe("swipe to allow once allowed", () => {
  it("closes in to a circle (the bar's height across) at the right edge, holding the knob", async () => {
    await render(<SwipeToAllow onAllow={jest.fn()} onDone={jest.fn()} />);
    await fireEvent(screen.getByRole("button", { name: "Swipe to allow" }).parent!, "layout", { nativeEvent: { layout: { width: BAR, height: 62, x: 0, y: 0 } } });
    const before = flat("swipe-knob");
    await act(async () => activate());
    const circle = screen.getByRole("button", { name: "Allowed" }).parent!;
    const s = Object.assign({}, ...[circle.props.style].flat(Infinity));
    expect(s).toMatchObject({ alignSelf: "flex-end", width: 62, height: 62, borderRadius: 999 });
    // The knob ran to the end of the bar and stays there: the bar closes in around it.
    expect(flat("swipe-knob").transform[0].translateX).toBe(MAX);
    expect(before.transform[0].translateX).toBe(0);
  });

  it("is a dark bar of its own in a card (on a light page the screen's faint tint would not show), and the faint tint on the dark screen", async () => {
    const bg = async (compact: boolean) => {
      const view = await render(<SwipeToAllow onAllow={jest.fn()} compact={compact} />);
      const style = Object.assign({}, ...[screen.getByRole("button", { name: "Swipe to allow" }).props.style].flat(Infinity));
      await view.unmount();
      return style.backgroundColor as string;
    };
    expect(await bg(true)).toBe(colors.ink);
    expect(await bg(false)).toBe(colors.nightRaised);
  });

  it("can be smaller, to sit in a card: the circle is then the smaller bar's height across", async () => {
    await render(<SwipeToAllow onAllow={jest.fn()} compact />);
    await act(async () => activate());
    // With nothing to do on a press, the bar itself is what says Allowed.
    const circle = screen.getByRole("button", { name: "Allowed" });
    const s = Object.assign({}, ...[circle.props.style].flat(Infinity));
    // A 38 knob with 4 around it.
    expect(s).toMatchObject({ width: 46, height: 46 });
  });

  it("is a button to press once it is a circle, when it is given something to do", async () => {
    const onDone = jest.fn();
    const onAllow = jest.fn();
    await render(<SwipeToAllow onAllow={onAllow} onDone={onDone} />);
    await act(async () => activate());
    expect(onAllow).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole("button", { name: "Allowed" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("is only a sign that it was allowed, without something to do", async () => {
    await render(<SwipeToAllow onAllow={jest.fn()} />);
    await act(async () => activate());
    expect(screen.getByLabelText("Allowed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allowed" }).props.accessibilityState).toMatchObject({ disabled: true });
  });

  it("is not a button to press before it was allowed, even with something to do", async () => {
    const onDone = jest.fn();
    await render(<SwipeToAllow onAllow={jest.fn()} onDone={onDone} />);
    await fireEvent.press(screen.getByRole("button", { name: "Swipe to allow" }));
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("swipe to allow taking the touch", () => {
  it("takes it the moment the knob is touched, so what it sits in is held still before it can scroll, and not once it is allowed", async () => {
    await render(<SwipeToAllow onAllow={jest.fn()} />);
    const knob = () => screen.getByTestId("swipe-knob");
    expect(knob().props.onStartShouldSetResponder({})).toBe(true);
    await act(async () => activate());
    expect(knob().props.onStartShouldSetResponder({})).toBe(false);
  });
});

describe("swipe to allow while it is dragged", () => {
  it("shows no green until the knob moves, then fills the bar behind it", async () => {
    const x = await bar();
    expect(flat("swipe-fill").opacity).toBe(0);
    await act(async () => x.setValue(60));
    expect(flat("swipe-fill").opacity).toBe(1);
    expect(flat("swipe-fill").width).toBeCloseTo(62 + (60 / MAX) * (BAR - 62), 0);
  });

  it("has the whole bar green when the knob is at the end", async () => {
    const x = await bar();
    await act(async () => x.setValue(MAX));
    expect(flat("swipe-fill").width).toBe(BAR);
  });

  it("goes back to nothing when the knob is let go before the end", async () => {
    const x = await bar();
    await act(async () => x.setValue(120));
    await act(async () => x.setValue(0));
    expect(flat("swipe-fill").opacity).toBe(0);
  });

  it("turns the knob white once it is on the green", async () => {
    const x = await bar();
    expect(flat("swipe-knob").backgroundColor).not.toBe("rgba(255, 255, 255, 1)");
    await act(async () => x.setValue(MAX * 0.6));
    expect(String(flat("swipe-knob").backgroundColor)).toMatch(/255, 255, 255|#fff/i);
  });
});
