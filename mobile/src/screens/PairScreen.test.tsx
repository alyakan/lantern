import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { toBase64Url } from "../pairing";
import { makeController, renderWith } from "../test/render";
import { ConfirmLink, PairScreen } from "./PairScreen";

// The camera, as a component that hands the test its props, and a permission the test sets.
let mockCamera: { onBarcodeScanned?: (e: { data: string }) => void } = {};
let mockPermission: { granted: boolean; canAskAgain: boolean } | null = { granted: true, canAskAgain: true };
const mockRequest = jest.fn();
jest.mock("expo-camera", () => ({
  CameraView: (props: typeof mockCamera) => {
    mockCamera = props;
    return null;
  },
  useCameraPermissions: () => [mockPermission, mockRequest],
}));
jest.mock("expo-clipboard", () => ({ getStringAsync: jest.fn(async () => "lantern://pair?v=1&pasted") }));

const link = `lantern://pair?v=1&k=${toBase64Url(new Uint8Array(32).fill(1))}&s=${toBase64Url(new Uint8Array(32).fill(2))}&h=192.168.1.20&p=47123&n=Aly%27s%20Mac&e=${Date.now() + 60_000}`;

function rig() {
  const { controller } = makeController();
  const pair = jest.spyOn(controller, "pair").mockResolvedValue(null);
  return { controller, pair };
}

beforeEach(() => {
  mockCamera = {};
  mockPermission = { granted: true, canAskAgain: true };
  mockRequest.mockClear();
});

describe("pairing with the camera", () => {
  it("pairs with the code the camera reads, once", async () => {
    const { controller, pair } = rig();
    await renderWith(<PairScreen />, { connection: { kind: "unpaired" } }, controller);
    expect(screen.getByText("Pair with your Mac")).toBeTruthy();
    expect(mockCamera.onBarcodeScanned).toBeDefined();
    await act(async () => {
      mockCamera.onBarcodeScanned!({ data: link });
      mockCamera.onBarcodeScanned!({ data: link });
    });
    await waitFor(() => expect(pair).toHaveBeenCalledTimes(1));
    expect(pair).toHaveBeenCalledWith(link);
  });

  it("says why a code didn't work, and doesn't try the same bad code thirty times a second", async () => {
    const { controller, pair } = rig();
    pair.mockResolvedValue("That isn't a Lantern pairing code.");
    await renderWith(<PairScreen />, { connection: { kind: "unpaired" } }, controller);
    await act(async () => mockCamera.onBarcodeScanned!({ data: "https://example.com" }));
    await waitFor(() => expect(screen.getByText("That isn't a Lantern pairing code.")).toBeTruthy());
    await act(async () => mockCamera.onBarcodeScanned!({ data: "https://example.com" }));
    expect(pair).toHaveBeenCalledTimes(1);
    // A different code is tried.
    await act(async () => mockCamera.onBarcodeScanned!({ data: "another" }));
    await waitFor(() => expect(pair).toHaveBeenCalledTimes(2));
  });

  it("asks for the camera when it hasn't been asked, and says what to do when it was refused for good", async () => {
    mockPermission = { granted: false, canAskAgain: true };
    const first = await renderWith(<PairScreen />, { connection: { kind: "unpaired" } });
    await fireEvent.press(screen.getByRole("button", { name: "Allow the camera" }));
    expect(mockRequest).toHaveBeenCalled();
    await first.unmount();
    mockPermission = { granted: false, canAskAgain: false };
    await renderWith(<PairScreen />, { connection: { kind: "unpaired" } });
    expect(screen.getByText(/camera is off for Lantern/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow the camera" })).toBeNull();
  });
});

describe("pairing by pasting the link", () => {
  it("pairs with the pasted link, and can paste from the clipboard", async () => {
    const { controller, pair } = rig();
    await renderWith(<PairScreen />, { connection: { kind: "unpaired" } }, controller);
    await fireEvent.press(screen.getByRole("button", { name: "Paste the link instead" }));
    expect(screen.getByRole("button", { name: "Pair" }).props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(screen.getByRole("button", { name: "Paste" }));
    await waitFor(() => expect(screen.getByLabelText("Pairing link").props.value).toBe("lantern://pair?v=1&pasted"));
    await fireEvent.changeText(screen.getByLabelText("Pairing link"), link);
    await fireEvent.press(screen.getByRole("button", { name: "Pair" }));
    await waitFor(() => expect(pair).toHaveBeenCalledWith(link));
  });

  it("goes back to the camera", async () => {
    await renderWith(<PairScreen initialPaste />, { connection: { kind: "unpaired" } });
    await fireEvent.press(screen.getByRole("button", { name: "Use the camera" }));
    expect(screen.getByText(/point your camera at the code/)).toBeTruthy();
  });
});

describe("a pairing link that arrived by itself", () => {
  it("names the Mac and where it points, and pairs only when confirmed", async () => {
    const { controller, pair } = rig();
    const onCancel = jest.fn();
    await renderWith(<ConfirmLink link={link} onCancel={onCancel} />, {}, controller);
    expect(screen.getByText("Pair with Aly's Mac?")).toBeTruthy();
    expect(screen.getByText(/points to 192\.168\.1\.20/)).toBeTruthy();
    expect(pair).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole("button", { name: "Pair" }));
    await waitFor(() => expect(pair).toHaveBeenCalledWith(link));
    await fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("says why a link can't be used, and why pairing failed", async () => {
    const { controller, pair } = rig();
    const bad = await renderWith(<ConfirmLink link="https://example.com" onCancel={jest.fn()} />, {}, controller);
    expect(screen.getByText("That isn't a Lantern pairing code.")).toBeTruthy();
    await bad.unmount();
    pair.mockResolvedValue("Your Mac didn't take this code. Show a new one on your Mac and try again.");
    await renderWith(<ConfirmLink link={link} onCancel={jest.fn()} />, {}, controller);
    await fireEvent.press(screen.getByRole("button", { name: "Pair" }));
    await waitFor(() => expect(screen.getByText(/didn't take this code/)).toBeTruthy());
  });
});
