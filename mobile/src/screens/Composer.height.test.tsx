import { StyleSheet } from "react-native";
import { screen } from "@testing-library/react-native";
import { renderWith } from "../test/render";
import { resetLayout } from "../shell/useLayout";
import { Composer } from "./ChatParts";

beforeEach(() => resetLayout());

// The window: a 13-inch iPad by default, at the usual text size.
let mockWindow = { width: 1024, height: 1366, scale: 2, fontScale: 1 };
jest.mock("react-native/Libraries/Utilities/useWindowDimensions", () => ({ __esModule: true, default: () => mockWindow }));

const cap = async () => {
  await renderWith(<Composer onSend={jest.fn()} />, {});
  return StyleSheet.flatten(screen.getByLabelText("Message").props.style).maxHeight as number;
};

describe("how tall the message box grows before it scrolls", () => {
  it("is eight lines on a tall screen, not a fixed 120 points", async () => {
    mockWindow = { width: 1024, height: 1366, scale: 2, fontScale: 1 };
    expect(await cap()).toBeGreaterThan(120);
  });

  it("stays 120 points on a phone, which shares the screen with the keyboard, however tall the phone", async () => {
    mockWindow = { width: 402, height: 874, scale: 3, fontScale: 1 };
    expect(await cap()).toBe(120);
  });

  it("grows with the system's text size, so a large one still shows five lines", async () => {
    mockWindow = { width: 402, height: 874, scale: 3, fontScale: 1.6 };
    expect(await cap()).toBeGreaterThan(160);
  });
});
