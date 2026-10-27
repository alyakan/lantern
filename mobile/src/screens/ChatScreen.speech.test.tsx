import "@shopify/flash-list/jestSetup";
import * as Speech from "expo-speech";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { attachSession } from "../test/fakeSession";
import { chat, makeController, renderWith } from "../test/render";
import { ChatScreen } from "./ChatScreen";

async function open() {
  const { controller } = makeController();
  attachSession(controller);
  await renderWith(<ChatScreen slot="a" onBack={jest.fn()} onReview={jest.fn()} />, { chats: [chat()], events: { a: [{ kind: "user_text", text: "Read this: **hello**", at: 1_000_000, sent_by: "desktop" }] } }, controller);
  await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
}

describe("reading a message aloud", () => {
  beforeEach(() => jest.clearAllMocks());

  it("is offered on a held message, and speaks its words without the marks", async () => {
    await open();
    await fireEvent(screen.getByLabelText("You: Read this: **hello**"), "longPress");
    await fireEvent.press(await screen.findByRole("button", { name: "Read aloud" }));
    await waitFor(() => expect(Speech.speak).toHaveBeenCalledTimes(1));
    expect((Speech.speak as jest.Mock).mock.calls[0][0]).toBe("Read this: hello");
  });

  it("stops speaking when the chat is left", async () => {
    await open();
    await act(async () => screen.unmount());
    expect(Speech.stop).toHaveBeenCalled();
  });
});
