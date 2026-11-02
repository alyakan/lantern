import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { attachSession } from "../test/fakeSession";
import { makeController, renderWith } from "../test/render";
import { NewChatSheet } from "./NewChatSheet";

// A sheet that goes only when this test says it has: what it was asked (close) and what it says once gone (onClose) are kept.
const mockSheet: { close: jest.Mock; gone: (() => void) | null } = { close: jest.fn(), gone: null };
jest.mock("../ui/Sheet", () => ({
  Sheet: ({ onClose, children }: { onClose: () => void; children: (close: () => void, scroll: unknown) => unknown }) => {
    mockSheet.gone = onClose;
    return children(mockSheet.close, { current: null });
  },
}));

const projects = [{ id: "/Users/me/lantern", name: "lantern" }];

it("puts the sheet away first, and opens the chat only once it has gone (iOS's sheet stays up if it is only taken away)", async () => {
  const { controller } = makeController();
  attachSession(controller, { projects, new_chat: { slot: "s9" } });
  const onClose = jest.fn();
  const onStarted = jest.fn();
  await renderWith(<NewChatSheet onClose={onClose} onStarted={onStarted} />, {}, controller);
  await waitFor(() => expect(screen.getByRole("radio", { name: "lantern" })).toBeTruthy());
  await fireEvent.changeText(screen.getByLabelText("What to start with"), "Fix it");
  await fireEvent.press(screen.getByRole("button", { name: "Start the chat" }));
  await waitFor(() => expect(mockSheet.close).toHaveBeenCalled());
  expect(onStarted).not.toHaveBeenCalled();
  await act(async () => mockSheet.gone?.());
  expect(onStarted).toHaveBeenCalledWith("s9");
  expect(onClose).not.toHaveBeenCalled();
});
