import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { resetVoiceChoice } from "../prefs";
import { SettingsSheet } from "./SettingsSheet";

beforeEach(() => resetVoiceChoice());

describe("Settings", () => {
  it("has the phone's speech model ticked until something else is chosen", async () => {
    await render(<SettingsSheet onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "iOS 26 speech model" }).props.accessibilityState).toMatchObject({ checked: true }));
    expect(screen.getByRole("radio", { name: "Apple's speech service" }).props.accessibilityState).toMatchObject({ checked: false });
  });

  it("remembers Apple's speech service once it is picked", async () => {
    const save = jest.spyOn(SecureStore, "setItemAsync");
    await render(<SettingsSheet onClose={jest.fn()} />);
    await fireEvent.press(await screen.findByRole("radio", { name: "Apple's speech service" }));
    expect(screen.getByRole("radio", { name: "Apple's speech service" }).props.accessibilityState).toMatchObject({ checked: true });
    expect(save).toHaveBeenCalledWith("lantern.voice-engine", "server", expect.anything());
    // Opened again, it still says so.
    await render(<SettingsSheet onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getAllByRole("radio", { name: "Apple's speech service" }).at(-1)!.props.accessibilityState).toMatchObject({ checked: true }));
  });
});
