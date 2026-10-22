import { AccessibilityInfo, StyleSheet, Text } from "react-native";
import { act, render, screen } from "@testing-library/react-native";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { lightColors } from "./theme";

// The module asks the phone about reduced transparency as it loads, and listens for the setting changing: watch for that.
const subscribe = jest.spyOn(AccessibilityInfo, "addEventListener");
const { Glass } = require("./Glass") as typeof import("./Glass");
const reduce = (on: boolean) => act(async () => void (subscribe.mock.calls.find((c) => c[0] === "reduceTransparencyChanged")![1] as (on: boolean) => void)(on));

const available = isLiquidGlassAvailable as jest.Mock;
const surface = () => screen.getByTestId("surface");
const fill = () => StyleSheet.flatten(surface().props.style).backgroundColor;

afterEach(async () => {
  available.mockReturnValue(false);
  await reduce(false);
});

describe("a glass surface", () => {
  it("is Liquid Glass where the phone has it, with no colour of its own", async () => {
    available.mockReturnValue(true);
    await render(
      <Glass testID="surface" style={{ borderRadius: 20 }}>
        <Text>inside</Text>
      </Glass>,
    );
    expect(surface().props.glassEffectStyle).toBe("regular");
    expect(fill()).toBeUndefined();
    expect(screen.getByText("inside")).toBeTruthy();
  });

  it("is today's solid card, with its shadow, where it doesn't", async () => {
    await render(
      <Glass testID="surface" lift={0.16} style={{ borderRadius: 20 }}>
        <Text>inside</Text>
      </Glass>,
    );
    expect(surface().props.glassEffectStyle).toBeUndefined();
    expect(fill()).toBe(lightColors.card);
    expect(StyleSheet.flatten(surface().props.style).shadowOpacity).toBe(0.16);
    expect(StyleSheet.flatten(surface().props.style).borderRadius).toBe(20);
  });

  it("is solid for someone who asked for less transparency, even on iOS 26", async () => {
    available.mockReturnValue(true);
    await render(<Glass testID="surface" />);
    expect(surface().props.glassEffectStyle).toBe("regular");
    await reduce(true);
    expect(surface().props.glassEffectStyle).toBeUndefined();
    expect(fill()).toBe(lightColors.card);
  });

  it("stays the solid card where asked to, even on iOS 26: for words that must read over what is behind", async () => {
    available.mockReturnValue(true);
    await render(<Glass solid testID="surface" />);
    expect(surface().props.glassEffectStyle).toBeUndefined();
    expect(fill()).toBe(lightColors.card);
  });
});
