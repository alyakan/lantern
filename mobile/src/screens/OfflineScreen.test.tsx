import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ConnectionState } from "../net/connection";
import { connected } from "../test/render";
import { MacSheet, OfflineScreen } from "./OfflineScreen";

describe("the Offline screen", () => {
  it("says it is connecting, with a lantern being lit rather than a spinner", async () => {
    await render(<OfflineScreen state={{ kind: "connecting" }} onRetry={jest.fn()} onUnpair={jest.fn()} />);
    expect(screen.getByLabelText("Connecting to your Mac")).toBeTruthy();
    expect(screen.getByText("Connecting to your Mac")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("says what is wrong and what to check, and tries again or unpairs", async () => {
    const onRetry = jest.fn();
    const onUnpair = jest.fn();
    const state: ConnectionState = { kind: "offline", reason: "Can't reach Aly's Mac. Check that it's awake.", retryInMs: 2000 };
    await render(<OfflineScreen state={state} onRetry={onRetry} onUnpair={onUnpair} />);
    expect(screen.getByText("Can't reach your Mac")).toBeTruthy();
    expect(screen.getByText("Can't reach Aly's Mac. Check that it's awake.")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    await fireEvent.press(screen.getByRole("button", { name: "Unpair this phone" }));
    expect(onRetry).toHaveBeenCalled();
    expect(onUnpair).toHaveBeenCalled();
  });

  it("takes the Mac's address typed in, and says why one is refused", async () => {
    const onAddress = jest.fn(async (text: string) => (text === "nope" ? "That isn't an address." : null));
    const state: ConnectionState = { kind: "offline", reason: "Can't reach Aly's Mac.", retryInMs: 2000 };
    await render(<OfflineScreen state={state} onRetry={jest.fn()} onUnpair={jest.fn()} onAddress={onAddress} />);
    expect(screen.queryByLabelText("Your Mac's address")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Enter your Mac's address" }));
    await fireEvent.changeText(screen.getByLabelText("Your Mac's address"), "nope");
    await fireEvent.press(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("That isn't an address.")).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("Your Mac's address"), "100.90.157.106");
    await fireEvent.press(screen.getByRole("button", { name: "Connect" }));
    expect(onAddress).toHaveBeenLastCalledWith("100.90.157.106");
    expect(screen.queryByText("That isn't an address.")).toBeNull();
  });
});

describe("the Mac's sheet", () => {
  it("names the Mac, where it is connected through, and its version", async () => {
    await render(<MacSheet state={connected} onClose={jest.fn()} onUnpair={jest.fn()} />);
    expect(screen.getByText("Aly's MacBook Pro")).toBeTruthy();
    expect(screen.getByText("Connected through 192.168.1.20")).toBeTruthy();
    expect(screen.getByText("Lantern 0.1.53")).toBeTruthy();
  });

  it("offers the optional tips when it is given a way to open them, and not otherwise", async () => {
    const onSupport = jest.fn();
    const view = await render(<MacSheet state={connected} onClose={jest.fn()} onUnpair={jest.fn()} onSupport={onSupport} />);
    await fireEvent.press(screen.getByRole("button", { name: "Support development" }));
    expect(onSupport).toHaveBeenCalledTimes(1);
    await view.unmount();
    await render(<MacSheet state={connected} onClose={jest.fn()} onUnpair={jest.fn()} />);
    expect(screen.queryByRole("button", { name: "Support development" })).toBeNull();
  });

  it("says that unpairing only forgets the Mac here, and unpairs or closes", async () => {
    const onClose = jest.fn();
    const onUnpair = jest.fn();
    await render(<MacSheet state={{ kind: "offline", reason: "x", retryInMs: 1 }} onClose={onClose} onUnpair={onUnpair} />);
    expect(screen.getByText("Not connected")).toBeTruthy();
    expect(screen.getByText(/also remove this phone in Lantern's Settings/)).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Unpair this phone" }));
    await fireEvent.press(screen.getByRole("button", { name: "Close" }));
    expect(onUnpair).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
