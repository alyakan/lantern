import { AccessibilityInfo, StyleSheet, Text } from "react-native";
import { act, render, screen } from "@testing-library/react-native";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { lightColors } from "./theme";

// The phone's appearance, which a test sets.
let mockScheme: "light" | "dark" = "light";
jest.mock("react-native/Libraries/Utilities/useColorScheme", () => ({ __esModule: true, default: () => mockScheme }));

// The module asks the phone about reduced transparency as it loads, and listens for the setting changing: watch for that.
const subscribe = jest.spyOn(AccessibilityInfo, "addEventListener");
const { Glass, GLASS_FILL, COMPOSER_FILL } = require("./Glass") as typeof import("./Glass");
const reduce = (on: boolean) => act(async () => void (subscribe.mock.calls.find((c) => c[0] === "reduceTransparencyChanged")![1] as (on: boolean) => void)(on));

const available = isLiquidGlassAvailable as jest.Mock;
const surface = () => screen.getByTestId("surface");
// The glass layer, when the surface has one: its first child.
const layerOf = () => {
  const first = surface().children[0];
  return typeof first === "object" && first.props.glassEffectStyle === "regular" ? first : null;
};
const fill = () => StyleSheet.flatten(surface().props.style).backgroundColor;

afterEach(async () => {
  mockScheme = "light";
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
    // The glass is the layer behind the children, held in the surface's corners. The surface has a faint fill and a hairline of
    // its own, so it still has an edge if the glass draws nothing.
    expect(StyleSheet.flatten(layerOf()!.props.style).borderRadius).toBe(20);
    expect(fill()).toBe(`${lightColors.card}${GLASS_FILL}`);
    expect(StyleSheet.flatten(surface().props.style).borderColor).toBe(lightColors.rule);
    expect(screen.getByText("inside")).toBeTruthy();
  });

  it("keeps only a tint of the card under its glass, so the glass has the page behind it to blur and not a flat card", () => {
    // What the glass blurs includes the surface's own fill: past about a quarter opaque, the box reads as a solid card.
    expect(parseInt(GLASS_FILL, 16) / 255).toBeLessThanOrEqual(0.25);
    expect(parseInt(GLASS_FILL, 16)).toBeGreaterThan(0);
  });

  it("keeps more of the card under it where words are typed, and still not a flat one", async () => {
    available.mockReturnValue(true);
    await render(<Glass testID="surface" fill={COMPOSER_FILL} style={{ borderRadius: 20 }} />);
    expect(fill()).toBe(`${lightColors.card}${COMPOSER_FILL}`);
    // Enough to read the words over a chat running under the box, and short of opaque so the glass over it still blurs the page.
    const opacity = parseInt(COMPOSER_FILL, 16) / 255;
    expect(opacity).toBeGreaterThanOrEqual(0.6);
    expect(opacity).toBeLessThan(0.85);
    expect(parseInt(COMPOSER_FILL, 16)).toBeGreaterThan(parseInt(GLASS_FILL, 16));
  });

  it("is told the app's look, and is made again when it changes, rather than left to follow the system by itself", async () => {
    available.mockReturnValue(true);
    await render(<Glass testID="surface" />);
    expect(layerOf()!.props.colorScheme).toBe("light");
    const before = layerOf();
    mockScheme = "dark";
    await screen.rerender(<Glass testID="surface" />);
    expect(layerOf()!.props.colorScheme).toBe("dark");
    expect(layerOf()).not.toBe(before);
  });

  it("is today's solid card, with its shadow, where it doesn't", async () => {
    await render(
      <Glass testID="surface" lift={0.16} style={{ borderRadius: 20 }}>
        <Text>inside</Text>
      </Glass>,
    );
    expect(layerOf()).toBeNull();
    expect(fill()).toBe(lightColors.card);
    expect(StyleSheet.flatten(surface().props.style).shadowOpacity).toBe(0.16);
    expect(StyleSheet.flatten(surface().props.style).borderRadius).toBe(20);
  });

  it("is solid for someone who asked for less transparency, even on iOS 26", async () => {
    available.mockReturnValue(true);
    await render(<Glass testID="surface" />);
    expect(layerOf()).not.toBeNull();
    await reduce(true);
    expect(layerOf()).toBeNull();
    expect(fill()).toBe(lightColors.card);
  });

  it("stays the solid card where asked to, even on iOS 26: for words that must read over what is behind", async () => {
    available.mockReturnValue(true);
    await render(<Glass solid testID="surface" />);
    expect(layerOf()).toBeNull();
    expect(fill()).toBe(lightColors.card);
  });
});
