import { StyleSheet, View } from "react-native";
import { render, screen } from "@testing-library/react-native";
import { Button, Tag, Txt } from "./components";
import { darkColors, lightColors, MIN_TARGET, paletteFor, radius } from "./theme";

/** A colour as the style gives it, for a node found by its label or text. */
const style = (node: { props: { style?: unknown } }) => StyleSheet.flatten(node.props.style as never) as { color?: string; backgroundColor?: string };

// The phone's appearance, which a test sets (the native module that says it is not there).
let mockScheme: "light" | "dark" = "light";
jest.mock("react-native/Libraries/Utilities/useColorScheme", () => ({ __esModule: true, default: () => mockScheme }));
afterEach(() => {
  mockScheme = "light";
});

/** WCAG's contrast ratio between two #rrggbb colours. */
function contrast(a: string, b: string) {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("the palettes", () => {
  it("follow the phone's appearance, Daylight unless it says dark", () => {
    expect(paletteFor("dark")).toBe(darkColors);
    expect(paletteFor("light")).toBe(lightColors);
    expect(paletteFor(null)).toBe(lightColors);
  });

  it("keep their words readable on their grounds", () => {
    for (const p of [lightColors, darkColors]) {
      for (const ground of [p.paper, p.card]) {
        expect(contrast(p.ink, ground)).toBeGreaterThanOrEqual(7);
        expect(contrast(p.ink2, ground)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(p.cobalt, ground)).toBeGreaterThanOrEqual(4.5);
      }
      // What is written on a filled ink pill, and on the highlighter.
      expect(contrast(p.onInk, p.ink)).toBeGreaterThanOrEqual(7);
      expect(contrast(p.onHi, p.hi)).toBeGreaterThanOrEqual(7);
    }
  });

  it("lift a card off the page on Night, where a shadow can't", () => {
    expect(darkColors.card).not.toBe(darkColors.paper);
    expect(contrast(darkColors.card, darkColors.paper)).toBeGreaterThan(1.1);
  });
});

describe("a screen in Night", () => {
  it("turns ink over: the main button is light with dark words, the highlighter's words stay dark", async () => {
    mockScheme = "dark";
    await render(
      <View>
        <Button label="Start" onPress={() => {}} />
        <Tag>Needs you</Tag>
        <Txt>Plain</Txt>
      </View>,
    );
    const button = screen.getByRole("button", { name: "Start" });
    expect(style(button).backgroundColor).toBe(darkColors.ink);
    expect(style(screen.getByText("Start")).color).toBe(darkColors.onInk);
    expect(style(screen.getByText("Start")).color).not.toBe(style(button).backgroundColor);
    expect(style(screen.getByText("Needs you")).color).toBe(darkColors.onHi);
    expect(style(screen.getByText("Plain")).color).toBe(darkColors.ink);
  });

  it("is Daylight otherwise, as before", async () => {
    await render(<Button label="Start" onPress={() => {}} />);
    expect(style(screen.getByRole("button", { name: "Start" })).backgroundColor).toBe(lightColors.ink);
    expect(style(screen.getByText("Start")).color).toBe(lightColors.onInk);
  });
});

describe("a button", () => {
  const shape = (node: { props: { style?: unknown } }) => StyleSheet.flatten(node.props.style as never) as { borderRadius?: number; minHeight?: number; textDecorationLine?: string; color?: string; backgroundColor?: string };

  it("is a pill", async () => {
    await render(<Button label="Send answer" kind="hi" onPress={() => {}} />);
    expect(shape(screen.getByRole("button", { name: "Send answer" })).borderRadius).toBe(radius.pill);
  });

  it("second of two is underlined words in its kind's colour, still a whole touch target", async () => {
    await render(
      <View>
        <Button label="Deny" kind="night-stop" link onPress={() => {}} />
        <Button label="Cancel" kind="ghost" link onPress={() => {}} />
      </View>,
    );
    const deny = screen.getByRole("button", { name: "Deny" });
    expect(shape(deny).backgroundColor).toBe("transparent");
    expect(shape(deny).minHeight).toBe(MIN_TARGET);
    expect(shape(screen.getByText("Deny"))).toMatchObject({ textDecorationLine: "underline", color: lightColors.nightStop });
    expect(shape(screen.getByRole("button", { name: "Cancel" })).backgroundColor).toBe("transparent");
    expect(shape(screen.getByText("Cancel"))).toMatchObject({ textDecorationLine: "underline", color: lightColors.ink });
  });
});
