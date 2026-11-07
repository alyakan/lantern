import { StyleSheet, Text } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { FadeSlideIn, motion, PopIn, PressScale, widen } from "./motion";

// What a view starts at, before any animation has moved it: tests skip animations, so motion is turned on to see the start.
const opacityAt = (text: string) => {
  let node = screen.getByText(text).parent;
  let opacity = 1;
  while (node) {
    const o = StyleSheet.flatten(node.props.style)?.opacity;
    if (typeof o === "number") opacity *= o;
    node = node.parent;
  }
  return opacity;
};

describe("arrivals over Liquid Glass", () => {
  const was = motion.instant;
  beforeEach(() => void (motion.instant = false));
  afterEach(() => void (motion.instant = was));

  it("fade in from nothing, except what holds glass, which only moves in (glass under a fade from nothing stays clear)", async () => {
    await render(
      <>
        <FadeSlideIn>
          <Text>plain</Text>
        </FadeSlideIn>
        <FadeSlideIn glass>
          <Text>glass</Text>
        </FadeSlideIn>
      </>,
    );
    expect(opacityAt("plain")).toBe(0);
    expect(opacityAt("glass")).toBe(1);
  });

  it("pop in from nothing, except what holds glass, which only grows", async () => {
    await render(
      <>
        <PopIn>
          <Text>plain</Text>
        </PopIn>
        <PopIn glass>
          <Text>glass</Text>
        </PopIn>
      </>,
    );
    expect(opacityAt("plain")).toBe(0);
    expect(opacityAt("glass")).toBe(1);
  });
});

describe("a pressable smaller than a finger", () => {
  it("reaches as far around itself as it lacks of 44 points, and keeps what it was given when that is more", async () => {
    await render(
      <PressScale accessibilityRole="button" accessibilityLabel="Copy" onPress={() => {}}>
        <Text>Copy</Text>
      </PressScale>,
    );
    const button = screen.getByRole("button", { name: "Copy" });
    await fireEvent(button, "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 60, height: 24 } } });
    expect(screen.getByRole("button", { name: "Copy" }).props.hitSlop).toEqual({ top: 10, bottom: 10, left: 0, right: 0 });
  });

  it("widens a reach given too small, side by side", async () => {
    expect(widen(4, { top: 10, bottom: 10, left: 0, right: 0 })).toEqual({ top: 10, bottom: 10, left: 4, right: 4 });
    expect(widen({ top: 20 }, { top: 10, bottom: 10, left: 0, right: 0 })).toEqual({ top: 20, bottom: 10, left: 0, right: 0 });
    expect(widen(8, undefined)).toBe(8);
  });
});
