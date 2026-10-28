import { render, screen } from "@testing-library/react-native";
import { MAX_TEXT_SCALE, Txt } from "./components";

describe("Txt", () => {
  it("follows the phone's text size, up to a limit", async () => {
    await render(<Txt>Hello</Txt>);
    expect(screen.getByText("Hello").props.maxFontSizeMultiplier).toBe(MAX_TEXT_SCALE);
  });

  it("lets a caller ask for a different limit", async () => {
    await render(<Txt maxFontSizeMultiplier={1.2}>Hi</Txt>);
    expect(screen.getByText("Hi").props.maxFontSizeMultiplier).toBe(1.2);
  });
});
