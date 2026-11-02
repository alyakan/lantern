import { ScrollView, Text } from "react-native";
import { act, render, screen, waitFor } from "@testing-library/react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Sheet, SHEET_INSET } from "./Sheet";

const native = () => screen.getByTestId("true-sheet").props as Record<string, unknown>;

describe("Sheet", () => {
  it("is iOS's own sheet, shown at once, sized to what is in it up to most of the screen, with its grabber", async () => {
    await render(<Sheet onClose={jest.fn()}>{() => <Text>Inside</Text>}</Sheet>);
    expect(screen.getByText("Inside")).toBeTruthy();
    expect(native()).toMatchObject({ detents: ["auto"], initialDetentIndex: 0, grabber: true });
    expect(typeof native().maxContentHeight).toBe("number");
    expect(typeof native().maxContentWidth).toBe("number");
  });

  it("closes from inside, and says so once however it goes (its close, then a swipe)", async () => {
    const onClose = jest.fn();
    let close: () => void = () => {};
    await render(
      <Sheet onClose={onClose}>
        {(c) => {
          close = c;
          return <Text>Inside</Text>;
        }}
      </Sheet>,
    );
    await act(async () => close());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await act(async () => (native().onDidDismiss as () => void)());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("gives what is in it only a little room at the bottom: the sheet already clears the home indicator", async () => {
    const Bottom = () => <Text>{`bottom ${useSafeAreaInsets().bottom}`}</Text>;
    await render(<Sheet onClose={jest.fn()}>{() => <Bottom />}</Sheet>);
    expect(screen.getByText(`bottom ${SHEET_INSET}`)).toBeTruthy();
  });

  it("is given the list in it that scrolls, so dragging the sheet and scrolling the list work together", async () => {
    await render(<Sheet onClose={jest.fn()}>{(_close, scroll) => <ScrollView ref={scroll} testID="list" />}</Sheet>);
    expect((native().scrollableRef as { current: unknown }).current).toBeTruthy();
  });
});
