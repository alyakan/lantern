import { StyleSheet, Text } from "react-native";
import { render, screen } from "@testing-library/react-native";
import { FadeSlideIn, motion, PopIn } from "./motion";

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
