import { StyleSheet } from "react-native";
import { act, render, screen } from "@testing-library/react-native";
import { AccentFromPledge, TipsContext } from "../shell/tipsContext";
import { noMemory, noPlatform, TipJar } from "../tips";
import { AccentContext, EMBER, EMBER_NIGHT } from "./accent";
import { Button, Txt } from "./components";
import { Markdown } from "./Markdown";
import { darkColors, lightColors as colors } from "./theme";

// The phone's appearance, which a test sets (the native module that says it is not there).
let mockScheme: "light" | "dark" = "light";
jest.mock("react-native/Libraries/Utilities/useColorScheme", () => ({ __esModule: true, default: () => mockScheme }));
afterEach(() => {
  mockScheme = "light";
});

const color = (text: string) => StyleSheet.flatten(screen.getByText(text).props.style).color;

describe("the accent on Night", () => {
  it("is the lighter cobalt, and a lighter Ember for a regular, whose buttons stay Ember with white words", async () => {
    mockScheme = "dark";
    await render(<Txt tone="cobalt">accent</Txt>);
    expect(color("accent")).toBe(darkColors.cobalt);
    await render(
      <AccentContext.Provider value={EMBER}>
        <Txt tone="cobalt">warm</Txt>
        <Button label="Warm" onPress={() => {}} />
      </AccentContext.Provider>,
    );
    expect(color("warm")).toBe(EMBER_NIGHT);
    expect(StyleSheet.flatten(screen.getByRole("button", { name: "Warm" }).props.style).backgroundColor).toBe(EMBER);
    expect(color("Warm")).toBe("#ffffff");
  });
});

describe("the accent", () => {
  it("is cobalt, and Ember is a warm orange that is not", () => {
    expect(EMBER).not.toBe(colors.cobalt);
    expect(EMBER).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("colours the text that asks for the accent, and nothing else", async () => {
    await render(
      <>
        <Txt tone="cobalt">accent</Txt>
        <Txt tone="ink2">plain</Txt>
      </>,
    );
    expect(color("accent")).toBe(colors.cobalt);
    await render(
      <AccentContext.Provider value={EMBER}>
        <Txt tone="cobalt">warm</Txt>
        <Txt tone="ink2">still plain</Txt>
      </AccentContext.Provider>,
    );
    expect(color("warm")).toBe(EMBER);
    expect(color("still plain")).toBe(colors.ink2);
  });

  it("makes a regular's main buttons Ember and leaves everyone else's ink, and the other kinds alone", async () => {
    const bg = (label: string) => StyleSheet.flatten(screen.getByRole("button", { name: label }).props.style).backgroundColor;
    await render(<Button label="Plain" onPress={() => {}} />);
    expect(bg("Plain")).toBe(colors.ink);
    await render(
      <AccentContext.Provider value={EMBER}>
        <Button label="Warm" onPress={() => {}} />
        <Button label="Quiet" kind="ghost" onPress={() => {}} />
      </AccentContext.Provider>,
    );
    expect(bg("Warm")).toBe(EMBER);
    expect(bg("Quiet")).toBe(colors.wash);
  });

  it("colours the links in Claude's text", async () => {
    await render(
      <AccentContext.Provider value={EMBER}>
        <Markdown text="see [the docs](https://example.com/docs)" />
      </AccentContext.Provider>,
    );
    expect(color("the docs")).toBe(EMBER);
  });

  it("is Ember for a regular and cobalt for anyone else", async () => {
    const jar = (pledger: boolean) => new TipJar({ ...noPlatform, isPledger: async () => pledger }, { ...noMemory, loadPledger: async () => pledger });
    const regular = jar(true);
    await render(
      <TipsContext.Provider value={regular}>
        <AccentFromPledge>
          <Txt tone="cobalt">hello</Txt>
        </AccentFromPledge>
      </TipsContext.Provider>,
    );
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    expect(color("hello")).toBe(EMBER);
  });

  it("is cobalt for someone who is not, and changes when they become a regular", async () => {
    let running = false;
    const jar = new TipJar({ ...noPlatform, isPledger: async () => running, subscribe: async () => "thanked", pledges: async () => [{ id: "p", name: "Monthly", price: "$1.99/mo", per: "month" }], products: async () => [] }, noMemory, Date.now, async () => {});
    await render(
      <TipsContext.Provider value={jar}>
        <AccentFromPledge>
          <Txt tone="cobalt">hello</Txt>
        </AccentFromPledge>
      </TipsContext.Provider>,
    );
    expect(color("hello")).toBe(colors.cobalt);
    running = true;
    await act(async () => {
      await jar.load();
      await jar.pledge("p");
    });
    expect(color("hello")).toBe(EMBER);
  });
});
