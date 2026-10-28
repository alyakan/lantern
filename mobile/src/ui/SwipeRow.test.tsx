import { fireEvent, render, screen } from "@testing-library/react-native";
import { Text } from "react-native";
import { SwipeRow } from "./SwipeRow";

const tray = (onPress = jest.fn()) => [
  { key: "read", label: "Unread", onPress },
  { key: "close", label: "Close", tone: "danger" as const, onPress },
];

describe("a row that can be swiped", () => {
  it("keeps its buttons out of reach while closed", async () => {
    await render(
      <SwipeRow background="#fff" open={false} onOpenChange={jest.fn()} tray={tray()}>
        <Text>Release</Text>
      </SwipeRow>,
    );
    expect(screen.getByText("Release")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.queryByTestId("swipe-close")).toBeNull();
  });

  it("offers them once open, and a button does its thing and closes the tray", async () => {
    const onPress = jest.fn();
    const onOpenChange = jest.fn();
    await render(
      <SwipeRow background="#fff" open onOpenChange={onOpenChange} tray={tray(onPress)}>
        <Text>Release</Text>
      </SwipeRow>,
    );
    await fireEvent.press(screen.getByRole("button", { name: "Close" }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("makes a tap on the row, while open, close the tray rather than open the chat", async () => {
    const onOpenChange = jest.fn();
    await render(
      <SwipeRow background="#fff" open onOpenChange={onOpenChange} tray={tray()}>
        <Text>Release</Text>
      </SwipeRow>,
    );
    await fireEvent.press(screen.getByTestId("swipe-close", { hidden: true }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("has no tray at all for a row with no buttons", async () => {
    await render(
      <SwipeRow background="#fff" open={false} onOpenChange={jest.fn()} pin={{ label: "Pin", onTrigger: jest.fn() }} tray={[]}>
        <Text>Release</Text>
      </SwipeRow>,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});
