import "@shopify/flash-list/jestSetup";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { attachSession } from "../test/fakeSession";
import { chat, makeController, seed } from "../test/render";
import type { RemoteChat } from "../protocol/generated/RemoteChat";
import type { Layout } from "../view/layout";
import { TOAST_MS } from "../ui/ChatToast";
import { Root } from "./Root";

jest.mock("expo-camera", () => ({ CameraView: () => null, useCameraPermissions: () => [{ granted: false, canAskAgain: true }, jest.fn()] }));
jest.mock("expo-clipboard", () => ({ getStringAsync: jest.fn(async () => "") }));

let mockLayout: Layout = "phone";
// Whether a tablet keeps the chats pinned beside the chat.
let mockPinned = false;
jest.mock("./useLayout", () => ({ useLayout: () => mockLayout }));
jest.mock("../prefs", () => ({ ...jest.requireActual("../prefs"), loadSidebarPinned: jest.fn(async () => mockPinned), saveSidebarPinned: jest.fn(async () => {}) }));

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))));

const working = [chat({ slot: "a", title: "Release 0.1.53", status: "idle" }), chat({ slot: "b", title: "Fix the footer", project: "site", status: "working" })];

async function open() {
  const { controller } = makeController();
  seed(controller, { chats: working });
  attachSession(controller, { list_waiting: [] });
  const view = await render(<Root controller={controller} />);
  await settle();
  // The chat list changes as the Mac says it does.
  const mac = (chats: RemoteChat[]) => act(async () => void controller.sync.apply({ type: "pushed", msg: { type: "chats", chats } }));
  return { view, mac };
}

const finished = [working[0], { ...working[1], status: "idle" as const }];
const toast = () => screen.queryByRole("alert", { name: /Fix the footer/ });

describe("a chat that finishes or needs you", () => {
  it("shows a toast on a phone that is in another chat, and opens the chat when it is pressed", async () => {
    mockLayout = "phone";
    const { mac } = await open();
    await fireEvent.press(screen.getByRole("button", { name: /Release 0.1.53/ }));
    await settle();
    await mac(finished);
    expect(toast()).toBeTruthy();
    expect(screen.getByText("Finished · site")).toBeTruthy();
    await fireEvent.press(toast()!);
    await settle();
    expect(toast()).toBeNull();
  });

  it("says nothing on a phone at Home, where the row says it", async () => {
    mockLayout = "phone";
    const { mac } = await open();
    await mac(finished);
    expect(toast()).toBeNull();
  });

  it("goes by itself", async () => {
    mockLayout = "phone";
    const { mac } = await open();
    await fireEvent.press(screen.getByRole("button", { name: /Release 0.1.53/ }));
    await settle();
    jest.useFakeTimers();
    await mac([working[0], { ...working[1], status: "needs_you" as const }]);
    expect(screen.getByText("Needs you · site")).toBeTruthy();
    await act(() => jest.advanceTimersByTime(TOAST_MS.needs + 10));
    expect(toast()).toBeNull();
    jest.useRealTimers();
  });

  it("shows on a tablet while the chats are slid away, and not while they are beside the chat (pinned)", async () => {
    mockLayout = "split";
    mockPinned = false;
    const away = await open();
    // In a chat, with the chats slid away.
    await fireEvent.press(screen.getByRole("button", { name: /Release 0.1.53/ }));
    await settle();
    await away.mac(finished);
    expect(toast()).toBeTruthy();
    await away.view.unmount();
    mockPinned = true;
    const beside = await open();
    await fireEvent.press(screen.getByRole("button", { name: /Release 0.1.53/ }));
    await settle();
    await beside.mac(finished);
    expect(toast()).toBeNull();
  });

  it("says nothing on a tablet while the chats are slid in over the chat: the list says it", async () => {
    mockLayout = "overlay";
    mockPinned = false;
    // Opens on no chat, so the chats slide in by themselves.
    const { mac } = await open();
    await mac(finished);
    expect(toast()).toBeNull();
  });
});
