import { Animated } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { SwipeToAllow } from "./SwipeToAllow";

const BAR = 300;
// The bar is 300 wide, the knob 52 with 5 around it: it travels 238.
const MAX = BAR - 52 - 10;

async function bar() {
  const x = new Animated.Value(0);
  await render(<SwipeToAllow onAllow={jest.fn()} progress={x} />);
  await fireEvent(screen.getByRole("button", { name: "Swipe to allow" }), "layout", { nativeEvent: { layout: { width: BAR, height: 62, x: 0, y: 0 } } });
  return x;
}

const style = (id: string) => screen.getByTestId(id).props.style as Record<string, number | string>;
const flat = (id: string) => Object.assign({}, ...[style(id)].flat(Infinity));

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
