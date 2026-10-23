import "@shopify/flash-list/jestSetup";
import { BackHandler } from "react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { attachSession } from "../test/fakeSession";
import { chat, makeController, seed, waiting } from "../test/render";
import { Root } from "./Root";
import type { Layout } from "../view/layout";

jest.mock("expo-camera", () => ({ CameraView: () => null, useCameraPermissions: () => [{ granted: false, canAskAgain: true }, jest.fn()] }));
jest.mock("expo-clipboard", () => ({ getStringAsync: jest.fn(async () => "") }));

// The layout is what the window's size says; a test says it directly.
let mockLayout: Layout = "split";
jest.mock("./useLayout", () => ({ useLayout: () => mockLayout }));

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))));

async function open(s: Parameters<typeof seed>[1]) {
  const { controller } = makeController();
  seed(controller, s);
  const session = attachSession(controller, { list_waiting: s.waiting ?? [] });
  const view = await render(<Root controller={controller} />);
  await settle();
  return { controller, view, ...session };
}

type BackHandlerFn = Parameters<typeof BackHandler.addEventListener>[1];
let backHandlers: BackHandlerFn[] = [];
beforeEach(() => {
  backHandlers = [];
  jest.spyOn(BackHandler, "addEventListener").mockImplementation((_event, cb) => {
    backHandlers.push(cb);
    return { remove: () => void (backHandlers = backHandlers.filter((h) => h !== cb)) };
  });
});

// The chats' column when it is slid away is hidden from the screen reader, so it is asked for as hidden.
const column = () => screen.getByTestId("chats-column", { hidden: true });
const press = (name: string | RegExp) => fireEvent.press(screen.getByRole("button", { name }));
const two = [chat({ slot: "a", title: "Release 0.1.53" }), chat({ slot: "b", title: "Fix the footer", project: "site" })];

describe("a tablet held sideways", () => {
  beforeEach(() => {
    mockLayout = "split";
  });

  it("has the chats beside the chat, and asks to pick one until one is", async () => {
    await open({ chats: two });
    expect(column()).toBeTruthy();
    expect(screen.getByTestId("pick-a-chat")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show chats" })).toBeNull();
  });

  it("shows a chat in place when it is picked, marks it, and replaces it with the next instead of stacking", async () => {
    const { lastOf } = await open({ chats: two });
    await press(/Release 0.1.53/);
    await settle();
    expect(screen.queryByTestId("pick-a-chat")).toBeNull();
    expect(lastOf("subscribe")).toMatchObject({ slot: "a" });
    // The chats are still there, and the open one says it is selected.
    expect(screen.getByRole("button", { name: /Release 0.1.53/ }).props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByRole("button", { name: /Fix the footer/ }).props.accessibilityState).toMatchObject({ selected: false });
    // Nothing leads back: the chats are not behind it.
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show chats" })).toBeNull();
    await press(/Fix the footer/);
    await settle();
    expect(lastOf("subscribe")).toMatchObject({ slot: "b" });
    expect(screen.getByRole("button", { name: /Fix the footer/ }).props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByRole("button", { name: /Release 0.1.53/ }).props.accessibilityState).toMatchObject({ selected: false });
  });

  it("reviews a prompt over its own chat, even when another chat is open, and lands in that chat when it is closed", async () => {
    await open({ chats: two, waiting: [waiting({ slot: "b", request_id: "p9" })] });
    await press(/Release 0.1.53/);
    await settle();
    await press("Review");
    expect(screen.getByTestId("decision-pane")).toBeTruthy();
    expect(screen.getByLabelText("Swipe to allow")).toBeTruthy();
    await press("Deny");
    await waitFor(() => expect(screen.getByText("Denied.")).toBeTruthy());
    await press("Done");
    await settle();
    expect(screen.queryByTestId("decision-pane")).toBeNull();
    expect(screen.getByRole("button", { name: /Fix the footer/ }).props.accessibilityState).toMatchObject({ selected: true });
  });

  it("the system's back button closes the chat, and then leaves the app", async () => {
    await open({ chats: two });
    await press(/Release 0.1.53/);
    await settle();
    await act(async () => void backHandlers[backHandlers.length - 1]({ nativeEvent: {} } as never));
    await settle();
    expect(screen.getByTestId("pick-a-chat")).toBeTruthy();
    // Nothing left to go back to: the handler lets the system have the button.
    let handled = true;
    await act(async () => void (handled = backHandlers[backHandlers.length - 1]({ nativeEvent: {} } as never) as boolean));
    expect(handled).toBe(false);
  });
});

describe("a tablet held upright", () => {
  beforeEach(() => {
    mockLayout = "overlay";
  });

  it("gives the chat the whole width, with a button for the chats", async () => {
    await open({ chats: two });
    expect(screen.getByTestId("pick-a-chat")).toBeTruthy();
    // The chats are out of the way: hidden from the screen reader, not tappable.
    expect(column().props.pointerEvents).toBe("none");
    await press("Show chats");
    expect(column().props.pointerEvents).toBe("auto");
  });

  it("slides the chats in from the chat's own button, and away again once a chat is picked", async () => {
    const { lastOf } = await open({ chats: two });
    await press("Show chats");
    await press(/Release 0.1.53/);
    await settle();
    expect(lastOf("subscribe")).toMatchObject({ slot: "a" });
    expect(column().props.pointerEvents).toBe("none");
    // The chat's header now leads with the chats' button, not a back arrow.
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    await press("Show chats");
    expect(column().props.pointerEvents).toBe("auto");
    await press("Close chats");
    expect(column().props.pointerEvents).toBe("none");
  });

  it("the system's back button puts the chats away before it goes back a screen", async () => {
    await open({ chats: two });
    await press("Show chats");
    await press(/Release 0.1.53/);
    await settle();
    await press("Show chats");
    await act(async () => void backHandlers[backHandlers.length - 1]({ nativeEvent: {} } as never));
    expect(column().props.pointerEvents).toBe("none");
    expect(screen.queryByTestId("pick-a-chat")).toBeNull();
  });
});

describe("turning the tablet", () => {
  it("keeps the chat that is open, and goes back to the phone's stack when the window gets narrow", async () => {
    mockLayout = "split";
    const { view, controller } = await open({ chats: two });
    await press(/Release 0.1.53/);
    await settle();
    mockLayout = "phone";
    await view.rerender(<Root controller={controller} />);
    await settle();
    // On the phone layout the chat is a screen with a back button, and Home is under it.
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.queryByTestId("chats-column")).toBeNull();
    await press("Back");
    await settle();
    expect(screen.getByText("Nothing")).toBeTruthy();
  });
});

describe("dragging the chats in and out on a tablet held upright", () => {
  beforeEach(() => {
    mockLayout = "overlay";
  });

  // A finger at (x, 400), at a time in ms.
  const touch = (x: number, t: number, y = 400) => ({ nativeEvent: { pageX: x, pageY: y, timestamp: t } });
  const edge = () => screen.getByTestId("chats-edge", { hidden: true });

  it("brings the chats in when the finger is pulled from the screen's edge far enough", async () => {
    await open({ chats: two });
    expect(column().props.pointerEvents).toBe("none");
    await fireEvent(edge(), "responderGrant", touch(4, 0));
    await fireEvent(edge(), "responderMove", touch(120, 400));
    await fireEvent(edge(), "responderMove", touch(260, 800));
    await fireEvent(edge(), "responderRelease", touch(260, 800));
    await settle();
    expect(column().props.pointerEvents).toBe("auto");
    // The edge has done its work: it is not in the way of the chats now.
    expect(screen.queryByTestId("chats-edge", { hidden: true })).toBeNull();
  });

  it("lets them stay away when the pull was short and slow, and brings them in on a flick however short", async () => {
    await open({ chats: two });
    await fireEvent(edge(), "responderGrant", touch(4, 0));
    await fireEvent(edge(), "responderMove", touch(70, 900));
    await fireEvent(edge(), "responderRelease", touch(70, 1000));
    await settle();
    expect(column().props.pointerEvents).toBe("none");
    await fireEvent(edge(), "responderGrant", touch(4, 2000));
    await fireEvent(edge(), "responderMove", touch(30, 2020));
    await fireEvent(edge(), "responderRelease", touch(60, 2040));
    await settle();
    expect(column().props.pointerEvents).toBe("auto");
  });

  it("sends them away when they are pulled to the left, and keeps them when the pull comes back", async () => {
    await open({ chats: two });
    await press("Show chats");
    expect(column().props.pointerEvents).toBe("auto");
    // Pulled a little, slowly, and let go: still there.
    await fireEvent(column(), "startShouldSetResponderCapture", touch(300, 0));
    await fireEvent(column(), "responderGrant", touch(300, 0));
    await fireEvent(column(), "responderMove", touch(270, 900));
    await fireEvent(column(), "responderRelease", touch(270, 1000));
    await settle();
    expect(column().props.pointerEvents).toBe("auto");
    // Pulled most of the way and let go: gone.
    await fireEvent(column(), "startShouldSetResponderCapture", touch(300, 2000));
    await fireEvent(column(), "responderGrant", touch(300, 2000));
    await fireEvent(column(), "responderMove", touch(120, 3000));
    await fireEvent(column(), "responderMove", touch(20, 4000));
    await fireEvent(column(), "responderRelease", touch(20, 4000));
    await settle();
    expect(column().props.pointerEvents).toBe("none");
  });

  it("takes a drag from the list under the finger only once it is plainly going left", async () => {
    await open({ chats: two });
    await press("Show chats");
    const steal = (x: number, y: number) => {
      column().props.onStartShouldSetResponderCapture(touch(300, 0, 300));
      return column().props.onMoveShouldSetResponderCapture(touch(x, 0, y));
    };
    expect(steal(250, 305)).toBe(true);
    // Scrolling up and down, a tap that wobbles, and a pull to the right are the list's own.
    expect(steal(298, 380)).toBe(false);
    expect(steal(296, 300)).toBe(false);
    expect(steal(340, 300)).toBe(false);
  });

  it("has no edge to pull from, or column to pull away, when the chats are beside the chat", async () => {
    mockLayout = "split";
    await open({ chats: two });
    expect(screen.queryByTestId("chats-edge", { hidden: true })).toBeNull();
    expect(column().props.onMoveShouldSetResponderCapture).toBeUndefined();
  });
});
