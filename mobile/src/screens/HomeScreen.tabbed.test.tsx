import { StyleSheet } from "react-native";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { Button } from "../ui/components";
import { lightColors } from "../ui/theme";
import { attachSession } from "../test/fakeSession";
import { chat, connectedWith, makeController, renderWith } from "../test/render";
import { HomeScreen } from "./HomeScreen";

jest.mock("../prefs", () => ({
  ...jest.requireActual("../prefs"),
  loadGrouping: jest.fn(async () => "recent"),
  saveGrouping: jest.fn(async () => {}),
  loadFolded: jest.fn(async () => []),
  saveFolded: jest.fn(async () => {}),
  loadSeen: jest.fn(async () => ({})),
  saveSeen: jest.fn(async () => {}),
}));

const chats = [chat({ slot: "a", title: "Approval cards" }), chat({ slot: "b", title: "Settings sidebar" }), chat({ slot: "c", title: "Games timer", project: "rayak" })];

describe("search on a phone's Chats tab", () => {
  it("is a circle beside the Mac's bar that grows into the field, narrows the list, and goes back", async () => {
    const { controller } = makeController();
    attachSession(controller, {}, []);
    await renderWith(<HomeScreen onOpenChat={jest.fn()} onReview={jest.fn()} onOpenMac={jest.fn()} onCompose={jest.fn()} onNewChat={jest.fn()} onSupport={jest.fn()} tabbed />, { connection: connectedWith([]), chats, waiting: [] }, controller);
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    expect(screen.queryByLabelText("Search")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Search chats" }));
    // The field grows once the keyboard starts coming, or after a moment without one.
    await act(async () => void (await new Promise((r) => setTimeout(r, 500))));
    await fireEvent.changeText(screen.getByLabelText("Search"), "rayak");
    expect(screen.getByText("1 chat")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Older match" })).toBeNull();
    expect(screen.getByText("Games timer")).toBeTruthy();
    expect(screen.queryByText("Settings sidebar")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Cancel search" }));
    expect(screen.getByText("Settings sidebar")).toBeTruthy();
  });
});

describe("a button that can't be pressed yet", () => {
  it("is solid grey, not faded: faded it vanished over what scrolls under a floating one", async () => {
    await renderWith(<Button label="Send answer" kind="hi" disabled onPress={jest.fn()} />);
    const button = screen.getByRole("button", { name: "Send answer" });
    expect(button).toBeDisabled();
    const style = StyleSheet.flatten(button.props.style);
    expect(style.backgroundColor).toBe(lightColors.shapeStrong);
    expect(style.opacity ?? 1).toBe(1);
  });
});
