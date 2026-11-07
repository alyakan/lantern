import { Appearance, StyleSheet, View } from "react-native";
import { act, render, renderHook, screen } from "@testing-library/react-native";
import { Button, Tag, Txt } from "./components";
import { darkColors, getThemeChoice, isThemeChoice, lightColors, MIN_TARGET, paletteFor, radius, setThemeChoice, THEME_CHOICES, useColors } from "./theme";

/** A colour as the style gives it, for a node found by its label or text. */
const style = (node: { props: { style?: unknown } }) => StyleSheet.flatten(node.props.style as never) as { color?: string; backgroundColor?: string };

// The phone's appearance, which a test sets (the native module that says it is not there).
let mockScheme: "light" | "dark" = "light";
jest.mock("react-native/Libraries/Utilities/useColorScheme", () => ({ __esModule: true, default: () => mockScheme }));
afterEach(() => {
  mockScheme = "light";
});

// The window the app is in, which a test sets: a phone's size unless it says otherwise.
let mockWindow = { width: 390, height: 844 };
jest.mock("react-native/Libraries/Utilities/useWindowDimensions", () => ({ __esModule: true, default: () => ({ ...mockWindow, scale: 3, fontScale: 1 }) }));
beforeEach(() => {
  mockWindow = { width: 390, height: 844 };
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

describe("the themes", () => {
  const presets = THEME_CHOICES.filter((t) => t.palette).map((t) => t.palette!);

  it("are Follow system, Daylight, Night and the Mac's five new ones, each known by id", () => {
    expect(THEME_CHOICES.map((t) => t.id)).toEqual(["system", "light", "dark", "gruvbox", "mocha", "tokyo", "rose", "latte"]);
    expect(THEME_CHOICES.map((t) => t.label)).toEqual(["Follow system", "Daylight", "Night", "Gruvbox Dark", "Catppuccin Mocha", "Tokyo Night", "Rosé Pine", "Catppuccin Latte"]);
    expect(isThemeChoice("tokyo")).toBe(true);
    expect(isThemeChoice("fallout")).toBe(false);
    expect(isThemeChoice(null)).toBe(false);
  });

  it("each have a palette of their own, dark or light as they say", () => {
    expect(new Set(presets).size).toBe(presets.length);
    expect(THEME_CHOICES.filter((t) => t.palette && t.palette.isDark !== (t.scheme === "dark")).map((t) => t.id)).toEqual([]);
  });

  // Every pair that falls short, by name (an empty list is a pass), so a failure says which colour of which theme.
  it("keep their words readable on their grounds, like Daylight and Night", () => {
    const short: string[] = [];
    const need = (name: string, a: string, b: string, min: number) => {
      if (contrast(a, b) < min) short.push(`${name} ${a} on ${b}: ${contrast(a, b).toFixed(2)} < ${min}`);
    };
    for (const t of THEME_CHOICES.filter((c) => c.palette)) {
      const p = t.palette!;
      for (const ground of [p.paper, p.card]) {
        need(`${t.id} ink`, p.ink, ground, 7);
        need(`${t.id} ink2`, p.ink2, ground, 4.5);
        need(`${t.id} cobalt`, p.cobalt, ground, 4.5);
        need(`${t.id} go`, p.go, ground, 3);
        need(`${t.id} stop`, p.stop, ground, 3);
        need(`${t.id} working`, p.working, ground, 3);
      }
      need(`${t.id} on ink`, p.onInk, p.ink, 7);
      need(`${t.id} on the highlighter`, p.onHi, p.hi, 7);
      // (Daylight's and Night's white on their green is as it was, 3.5 and 2.6: only the new themes are held to this.)
      if (t.id !== "light" && t.id !== "dark") need(`${t.id} on go`, p.onGo, p.go, 4.5);
      need(`${t.id} ink on the highlighter's wash`, p.ink, p.hiSoft, 7);
      need(`${t.id} night text`, p.nightText, p.night, 7);
      need(`${t.id} night stop`, p.nightStop, p.night, 4.5);
    }
    expect(short).toEqual([]);
  });

  it("lift a card off the page on a dark one, and keep the highlighter apart from Claude's working orange", () => {
    const flat = THEME_CHOICES.filter((t) => t.palette?.isDark && contrast(t.palette.card, t.palette.paper) <= 1.1).map((t) => t.id);
    const same = THEME_CHOICES.filter((t) => t.palette && t.palette.hi === t.palette.working).map((t) => t.id);
    expect(flat).toEqual([]);
    expect(same).toEqual([]);
  });

  it("follow the iPhone only when told to, and otherwise ignore its appearance", () => {
    expect(paletteFor("dark", "system")).toBe(darkColors);
    expect(paletteFor("light")).toBe(lightColors);
    expect(paletteFor("light", "tokyo")).toBe(THEME_CHOICES.find((t) => t.id === "tokyo")!.palette);
    expect(paletteFor("dark", "latte")).toBe(THEME_CHOICES.find((t) => t.id === "latte")!.palette);
    expect(paletteFor("dark", "light")).toBe(lightColors);
    expect(paletteFor("light", "dark")).toBe(darkColors);
  });
});

describe("choosing a theme", () => {
  afterEach(async () => {
    jest.restoreAllMocks();
    await act(async () => setThemeChoice("system"));
  });

  it("redraws what reads the colours, and tells iOS whether it is light or dark", async () => {
    const set = jest.spyOn(Appearance, "setColorScheme").mockImplementation(() => {});
    const { result } = await renderHook(() => useColors());
    expect(result.current).toBe(lightColors);
    await act(async () => setThemeChoice("mocha"));
    expect(getThemeChoice()).toBe("mocha");
    expect(result.current).toBe(THEME_CHOICES.find((t) => t.id === "mocha")!.palette);
    expect(set).toHaveBeenLastCalledWith("dark");
    await act(async () => setThemeChoice("latte"));
    expect(set).toHaveBeenLastCalledWith("light");
    await act(async () => setThemeChoice("system"));
    expect(set).toHaveBeenLastCalledWith("unspecified");
    expect(result.current).toBe(lightColors);
  });

  it("still takes effect where iOS can't be told", async () => {
    jest.spyOn(Appearance, "setColorScheme").mockImplementation(() => {
      throw new Error("no native module");
    });
    const { result } = await renderHook(() => useColors());
    await act(async () => setThemeChoice("rose"));
    expect(result.current).toBe(THEME_CHOICES.find((t) => t.id === "rose")!.palette);
  });
});

describe("a green button in a theme with a pale green", () => {
  it("is written on in the theme's dark, and in white where the green is deep", async () => {
    await act(async () => setThemeChoice("mocha"));
    const mocha = THEME_CHOICES.find((t) => t.id === "mocha")!.palette!;
    const { unmount } = await render(<Button label="Allow" kind="go" onPress={() => {}} />);
    expect(style(screen.getByRole("button", { name: "Allow" })).backgroundColor).toBe(mocha.go);
    expect(style(screen.getByText("Allow")).color).toBe(mocha.onGo);
    expect(style(screen.getByText("Allow")).color).not.toBe("#ffffff");
    await unmount();
    await act(async () => setThemeChoice("system"));
    await render(<Button label="Allow" kind="go" onPress={() => {}} />);
    expect(style(screen.getByText("Allow")).color).toBe(lightColors.white);
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

describe("the body text", () => {
  const body = () => StyleSheet.flatten(screen.getByText("Words").props.style as never) as { fontSize?: number; lineHeight?: number };

  it("is 16 points on a phone", async () => {
    await render(<Txt>Words</Txt>);
    expect(body()).toMatchObject({ fontSize: 16, lineHeight: 21 });
  });

  it("is 17 on a tablet, upright or sideways", async () => {
    mockWindow = { width: 820, height: 1180 };
    await render(<Txt>Words</Txt>);
    expect(body()).toMatchObject({ fontSize: 17, lineHeight: 22 });
  });

  // The page's margins and the body's size ask the same question: a window wide enough for a tablet's layout is one, however short.
  it("is the tablet's in a wide window that is short, as the layout is", async () => {
    mockWindow = { width: 800, height: 600 };
    await render(<Txt>Words</Txt>);
    expect(body().fontSize).toBe(17);
  });

  it("is the phone's in a narrow Split View pane, which is laid out as a phone", async () => {
    mockWindow = { width: 400, height: 1000 };
    await render(<Txt>Words</Txt>);
    expect(body().fontSize).toBe(16);
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
