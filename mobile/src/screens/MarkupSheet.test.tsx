import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { captureRef } from "react-native-view-shot";
import type { PickedImage } from "../view/attachments";
import { MarkupSheet } from "./MarkupSheet";

const photo: PickedImage = { id: "img-1", uri: "file:///photo.jpg", data: "/9j/4AAQ", mediaType: "image/jpeg", width: 800, height: 600 };

const touch = (x: number, y: number) => ({ nativeEvent: { locationX: x, locationY: y } });
async function draw(points: [number, number][]) {
  const canvas = screen.getByTestId("markup-canvas");
  await act(async () => void fireEvent(canvas, "responderGrant", touch(...points[0])));
  for (const p of points.slice(1)) await act(async () => void fireEvent(canvas, "responderMove", touch(...p)));
  await act(async () => void fireEvent(canvas, "responderRelease", touch(...points[points.length - 1])));
}

describe("marking up a photo", () => {
  beforeEach(() => jest.clearAllMocks());

  it("takes a picture of the photo with the strokes, and hands it back as the photo to send", async () => {
    const onDone = jest.fn();
    await render(<MarkupSheet image={photo} onDone={onDone} onClose={jest.fn()} />);
    await draw([[10, 10], [60, 10], [60, 60]]);
    await fireEvent.press(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(captureRef).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][0]).toMatchObject({ mediaType: "image/jpeg" });
  });

  it("undoes the last stroke and clears them all, and Done with nothing drawn takes no picture", async () => {
    const onDone = jest.fn();
    await render(<MarkupSheet image={photo} onDone={onDone} onClose={jest.fn()} />);
    expect(screen.getByRole("button", { name: "Undo" }).props.accessibilityState.disabled).toBe(true);
    await draw([[10, 10], [50, 50]]);
    await draw([[100, 10], [150, 50]]);
    expect(screen.getByRole("button", { name: "Undo" }).props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(screen.getByRole("button", { name: "Undo" }));
    await fireEvent.press(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByRole("button", { name: "Clear" }).props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByRole("button", { name: "Done" }));
    expect(captureRef).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("says so when the picture can't be taken, and keeps the strokes", async () => {
    (captureRef as jest.Mock).mockRejectedValueOnce(new Error("no"));
    const onDone = jest.fn();
    await render(<MarkupSheet image={photo} onDone={onDone} onClose={jest.fn()} />);
    await draw([[10, 10], [60, 60]]);
    await fireEvent.press(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText(/couldn't be saved/)).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Undo" }).props.accessibilityState.disabled).toBe(false);
  });
});
