import "@shopify/flash-list/jestSetup";
import { Linking } from "react-native";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import type { Picked } from "../platformImages";
import { pickImages } from "../platformImages";
import { attachSession } from "../test/fakeSession";
import { chat, connectedWith, makeController, renderWith } from "../test/render";
import type { PickedImage } from "../view/attachments";
import { ChatScreen } from "./ChatScreen";

jest.mock("../platformImages", () => ({ pickImages: jest.fn() }));
jest.mock("../platformMarkup", () => ({ captureMarkedUp: jest.fn(async () => ({ id: "img-marked", uri: "file:///marked.jpg", data: "/9j/MARKED", mediaType: "image/jpeg", width: 100, height: 75 })) }));
const pick = pickImages as jest.Mock<Promise<Picked>, [string, number]>;

const photo = (n: number): PickedImage => ({ id: `img-${n}`, uri: `file:///photo-${n}.jpg`, data: `/9j/DATA${n}`, mediaType: "image/jpeg", width: 1568, height: 1176 });

async function chatWith(features: string[] = ["images"]) {
  const { controller } = makeController();
  const session = attachSession(controller, {}, features);
  await renderWith(<ChatScreen slot="a" onBack={jest.fn()} onReview={jest.fn()} />, { connection: connectedWith(features), chats: [chat()], events: { a: [] } }, controller);
  await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
  return session;
}

/** + → the sheet → a source: the picker is asked for once the sheet has gone. */
async function attach(source: "Photo library" | "Take a photo") {
  await fireEvent.press(screen.getByRole("button", { name: "Attach photos" }));
  await fireEvent.press(screen.getByRole("button", { name: source }));
}
const thumbs = () => screen.queryAllByLabelText(/^Photo \d$/);

beforeEach(() => {
  pick.mockReset();
  pick.mockResolvedValue({ images: [] });
});

describe("attaching photos to a message", () => {
  it("has no + on a Mac that can't take photos", async () => {
    await chatWith([]);
    expect(screen.queryByRole("button", { name: "Attach photos" })).toBeNull();
  });

  it("opens the photo library from the +, shows what was picked above the box, and sends it with the message", async () => {
    pick.mockResolvedValueOnce({ images: [photo(1), photo(2)] });
    const { lastOf } = await chatWith();
    await attach("Photo library");
    await waitFor(() => expect(thumbs()).toHaveLength(2));
    expect(pick).toHaveBeenCalledWith("library", 4);
    await fireEvent.changeText(screen.getByLabelText("Message"), "what is this?");
    await fireEvent.press(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(lastOf("send")).toMatchObject({ op: "send", slot: "a", text: "what is this?", images: [{ media_type: "image/jpeg", data: "/9j/DATA1" }, { media_type: "image/jpeg", data: "/9j/DATA2" }] }));
    // The box is empty again, and the photos are in the message, on this phone.
    expect(screen.getByLabelText("Message").props.value).toBe("");
    expect(screen.queryByLabelText("Attached photos")).toBeNull();
    expect(screen.getByLabelText("Photo 1 you sent")).toBeTruthy();
    expect(screen.getByLabelText("Photo 2 you sent")).toBeTruthy();
  });

  it("sends photos with no words at all", async () => {
    pick.mockResolvedValueOnce({ images: [photo(1)] });
    const { lastOf } = await chatWith();
    expect(screen.getByRole("button", { name: "Send" }).props.accessibilityState).toMatchObject({ disabled: true });
    await attach("Photo library");
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Send" }).props.accessibilityState).toMatchObject({ disabled: false });
    await fireEvent.press(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(lastOf("send")).toMatchObject({ op: "send", text: "", images: [{ data: "/9j/DATA1" }] }));
  });

  it("takes a photo with the camera", async () => {
    pick.mockResolvedValueOnce({ images: [photo(7)] });
    await chatWith();
    await attach("Take a photo");
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    expect(pick).toHaveBeenCalledWith("camera", 4);
  });

  it("takes a photo off again with its ×", async () => {
    pick.mockResolvedValueOnce({ images: [photo(1), photo(2)] });
    const { lastOf } = await chatWith();
    await attach("Photo library");
    await waitFor(() => expect(thumbs()).toHaveLength(2));
    await fireEvent.press(screen.getByRole("button", { name: "Remove photo 1" }));
    expect(thumbs()).toHaveLength(1);
    await fireEvent.press(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(lastOf("send")).toMatchObject({ images: [{ data: "/9j/DATA2" }] }));
  });

  it("asks for only as many as there is room for, and stops offering the + when four are on", async () => {
    pick.mockResolvedValueOnce({ images: [photo(1), photo(2)] });
    await chatWith();
    await attach("Photo library");
    await waitFor(() => expect(thumbs()).toHaveLength(2));
    pick.mockResolvedValueOnce({ images: [photo(3), photo(4), photo(5)] });
    await attach("Photo library");
    await waitFor(() => expect(thumbs()).toHaveLength(4));
    expect(pick).toHaveBeenLastCalledWith("library", 2);
    expect(screen.getByRole("button", { name: "Attach photos" }).props.accessibilityState).toMatchObject({ disabled: true });
  });

  it("backing out of the picker changes nothing", async () => {
    await chatWith();
    await attach("Photo library");
    await waitFor(() => expect(pick).toHaveBeenCalled());
    expect(thumbs()).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says how to turn the camera on when it was refused, and opens Settings", async () => {
    const open = jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined);
    pick.mockResolvedValueOnce({ problem: "denied" });
    await chatWith();
    await attach("Take a photo");
    await waitFor(() => expect(screen.getByText(/can't use the camera/)).toBeTruthy());
    await fireEvent.press(screen.getByRole("button", { name: "Open Settings" }));
    expect(open).toHaveBeenCalled();
    await fireEvent.press(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/can't use the camera/)).toBeNull();
    open.mockRestore();
  });

  it("says when a picture couldn't be used, without a way to Settings", async () => {
    pick.mockResolvedValueOnce({ problem: "failed" });
    await chatWith();
    await attach("Photo library");
    await waitFor(() => expect(screen.getByText(/couldn't be used/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
  });

  it("is not offered in the terminal", async () => {
    await chatWith(["images", "shell"]);
    await fireEvent.changeText(screen.getByLabelText("Message"), "!");
    expect(screen.queryByRole("button", { name: "Attach photos" })).toBeNull();
  });

  it("leaves a message that someone else sent with photos as how many, since they never come back", async () => {
    const { controller } = makeController();
    attachSession(controller, {}, ["images"]);
    await renderWith(
      <ChatScreen slot="a" onBack={jest.fn()} onReview={jest.fn()} />,
      { connection: connectedWith(["images"]), chats: [chat()], events: { a: [{ kind: "user_text", text: "look at these", at: 1_000_000, sent_by: "desktop", images: 3 }] } },
      controller,
    );
    await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
    expect(screen.getByText("3 photos sent")).toBeTruthy();
    expect(screen.getByLabelText("You: look at these (3 photos)")).toBeTruthy();
  });
});

describe("drawing on a photo before it is sent", () => {
  it("sends the marked-up photo in place of the one that was picked", async () => {
    pick.mockResolvedValueOnce({ images: [photo(1)] });
    const { lastOf } = await chatWith();
    await attach("Photo library");
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    await fireEvent.press(screen.getByRole("button", { name: "Mark up photo 1" }));
    const canvas = await screen.findByTestId("markup-canvas");
    const at = (x: number, y: number) => ({ nativeEvent: { locationX: x, locationY: y } });
    await act(async () => void fireEvent(canvas, "responderGrant", at(10, 10)));
    await act(async () => void fireEvent(canvas, "responderMove", at(80, 40)));
    await fireEvent.press(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByTestId("markup-canvas")).toBeNull(), { timeout: 3000 });
    expect(thumbs()).toHaveLength(1);
    await fireEvent.changeText(screen.getByLabelText("Message"), "this part");
    await fireEvent.press(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(lastOf("send")).toMatchObject({ images: [{ media_type: "image/jpeg", data: "/9j/MARKED" }] }));
  });
});
