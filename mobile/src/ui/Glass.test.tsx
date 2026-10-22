import { AccessibilityInfo, StyleSheet, Text } from "react-native";
import { act, render, screen } from "@testing-library/react-native";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Glass } from "./Glass";
import { lightColors } from "./theme";

const available = isLiquidGlassAvailable as jest.Mock;
const surface = () => screen.getByTestId("surface");
const fill = () => StyleSheet.flatten(surface().props.style).backgroundColor;

afterEach(() => {
  available.mockReturnValue(false);
  jest.restoreAllMocks();
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
    jest.spyOn(AccessibilityInfo, "isReduceTransparencyEnabled").mockResolvedValue(true);
    await render(<Glass testID="surface" />);
    await act(async () => void (await Promise.resolve()));
    expect(surface().props.glassEffectStyle).toBeUndefined();
    expect(fill()).toBe(lightColors.card);
  });
});
