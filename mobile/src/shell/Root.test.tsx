import "@shopify/flash-list/jestSetup";
import { BackHandler } from "react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { toBase64Url } from "../pairing";
import { attachSession } from "../test/fakeSession";
import { chat, connected, makeController, seed, waiting } from "../test/render";
import { Root, type RootProps } from "./Root";

jest.mock("expo-camera", () => ({ CameraView: () => null, useCameraPermissions: () => [{ granted: false, canAskAgain: true }, jest.fn()] }));
jest.mock("expo-clipboard", () => ({ getStringAsync: jest.fn(async () => "") }));
// These are the phone's screens; the tablet's are in Root.tablet.test.tsx. (The test window is as wide as a tablet's.)
jest.mock("./useLayout", () => ({ useLayout: () => "phone" }));

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))));

async function open(s: Parameters<typeof seed>[1], props: Partial<RootProps> = {}, answers: Parameters<typeof attachSession>[1] = {}) {
  const { controller } = makeController();
  seed(controller, s);
  const session = attachSession(controller, { list_waiting: s.waiting ?? [], ...answers });
  const view = await render(<Root controller={controller} {...props} />);
  await settle();
  return { controller, view, ...session };
}

// The system's back button: the handlers the app registered, for the test to press.
type BackHandlerFn = Parameters<typeof BackHandler.addEventListener>[1];
let backHandlers: BackHandlerFn[] = [];
beforeEach(() => {
  backHandlers = [];
  jest.spyOn(BackHandler, "addEventListener").mockImplementation((_event, cb) => {
    backHandlers.push(cb);
    return { remove: () => void (backHandlers = backHandlers.filter((h) => h !== cb)) };
  });
});

const press = (name: string | RegExp) => fireEvent.press(screen.getByRole("button", { name }));

describe("which screen is up", () => {
  it("asks to pair when no Mac is paired", async () => {
    await open({ connection: { kind: "unpaired" } });
    expect(screen.getByText("Pair with your Mac")).toBeTruthy();
  });

  it("says it is connecting, then why it can't reach the Mac when there is nothing to show yet", async () => {
    const connecting = await open({ connection: { kind: "connecting" } });
    expect(screen.getByLabelText("Connecting to your Mac")).toBeTruthy();
    await connecting.view.unmount();
    const { controller } = await open({ connection: { kind: "offline", reason: "Can't reach Aly's Mac.", retryInMs: 1000 }, chats: [] });
    expect(screen.getByText("Can't reach your Mac")).toBeTruthy();
    const resume = jest.spyOn(controller, "resume");
    await press("Try again");
    expect(resume).toHaveBeenCalled();
  });

  it("keeps showing the chats it has when the connection drops", async () => {
    await open({ connection: { kind: "offline", reason: "x", retryInMs: 1000 }, chats: [chat()] });
    expect(screen.getByText("Release 0.1.53")).toBeTruthy();
    expect(screen.queryByText("Can't reach your Mac")).toBeNull();
  });

  it("shows Home once connected, with what waits on you", async () => {
    await open({ chats: [chat()], waiting: [waiting()] });
    expect(screen.getByText("1 thing")).toBeTruthy();
  });

  it("confirms a pairing link that arrived by itself, before anything pairs", async () => {
    const link = `lantern://pair?v=1&k=${toBase64Url(new Uint8Array(32).fill(1))}&s=${toBase64Url(new Uint8Array(32).fill(2))}&h=10.0.0.4&p=47123&n=Fixture&e=${Date.now() + 60_000}`;
    const onClearLink = jest.fn();
    const { controller } = await open({ chats: [chat()] }, { pendingLink: link, onClearLink });
    const pair = jest.spyOn(controller, "pair");
    expect(screen.getByText("Pair with Fixture?")).toBeTruthy();
    expect(pair).not.toHaveBeenCalled();
    await press("Cancel");
    expect(onClearLink).toHaveBeenCalled();
  });

  it("keeps the pairing screen, and why a pasted code failed, while the connection tries and gives up", async () => {
    const link = `lantern://pair?v=1&k=${toBase64Url(new Uint8Array(32).fill(1))}&s=${toBase64Url(new Uint8Array(32).fill(2))}&h=10.0.0.4&p=47123&n=Fixture&e=${Date.now() + 60_000}`;
    // The connection is the real one (nothing in the test answers), so it goes through "connecting" and back like a phone's.
    await open({ connection: { kind: "unpaired" } });
    await press("Paste the link instead");
    await fireEvent.changeText(screen.getByLabelText("Pairing link"), link);
    await press("Pair");
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/no network in tests/)).toBeTruthy();
    expect(screen.getByLabelText("Pairing link")).toBeTruthy();
  });

  it("drops the confirmation once the link has paired, so Home can show", async () => {
    const link = `lantern://pair?v=1&k=${toBase64Url(new Uint8Array(32).fill(1))}&s=${toBase64Url(new Uint8Array(32).fill(2))}&h=10.0.0.4&p=47123&n=Fixture&e=${Date.now() + 60_000}`;
    const onClearLink = jest.fn();
    const { controller } = await open({ chats: [chat()] }, { pendingLink: link, onClearLink });
    jest.spyOn(controller, "pair").mockResolvedValue(null);
    await press("Pair");
    await waitFor(() => expect(onClearLink).toHaveBeenCalledTimes(1));
  });
});

describe("starting a chat from Home", () => {
  const answers = { projects: [{ id: "/Users/me/lantern", name: "lantern" }], new_chat: { slot: "s9" } };

  it("opens the sheet, starts the chat on the Mac, and goes into it", async () => {
    const { lastOf } = await open({ chats: [chat()] }, {}, answers);
    await press("New chat");
    await waitFor(() => expect(screen.getByRole("radio", { name: "lantern" })).toBeTruthy());
    await fireEvent.changeText(screen.getByLabelText("What to start with"), "Fix the login bug");
    await press("Start the chat");
    await waitFor(() => expect(screen.getByRole("button", { name: "Back" })).toBeTruthy());
    expect(lastOf("new_chat")).toEqual({ op: "new_chat", project: "/Users/me/lantern", text: "Fix the login bug", permissions: null, preset: null, workflow: null });
    // The sheet is gone, and it is the new chat that is open (its events are followed).
    expect(screen.queryByText("Start the chat")).toBeNull();
    expect(lastOf("subscribe")).toMatchObject({ slot: "s9" });
  });

  it("carries on a chat from a suggestion: the draft is read first, then sent to that chat, and the chat opens", async () => {
    const suggest = { generated_at: 1, items: [{ id: "s1", title: "Write the notes", why: "The release is cut.", message: "Write the release notes.", target: { kind: "continue", slot: "a" } }] };
    const { lastOf } = await open({ chats: [chat()] }, {}, { suggest });
    await waitFor(() => expect(screen.getByRole("button", { name: "Write the notes. The release is cut." })).toBeTruthy());
    await press("Write the notes. The release is cut.");
    // The sheet shows the draft, for reading and changing; nothing has been sent yet.
    expect(screen.getByLabelText("What to start with").props.value).toBe("Write the release notes.");
    expect(lastOf("send")).toBeUndefined();
    await press("Send");
    await waitFor(() => expect(screen.getByRole("button", { name: "Back" })).toBeTruthy());
    expect(lastOf("send")).toMatchObject({ slot: "a", text: "Write the release notes." });
    expect(lastOf("subscribe")).toMatchObject({ slot: "a" });
  });

  it("starts a new chat from a suggestion in the project it names", async () => {
    const suggest = { generated_at: 1, items: [{ id: "s1", title: "Check the footer", why: "Quick tidy.", message: "Fix the footer links.", target: { kind: "new_chat", project: "/Users/me/site", project_name: "site" } }] };
    const projects = [{ id: "/Users/me/lantern", name: "lantern" }, { id: "/Users/me/site", name: "site" }];
    const { lastOf } = await open({ chats: [chat()] }, {}, { suggest, projects, new_chat: { slot: "s9" } });
    await waitFor(() => screen.getByRole("button", { name: "Check the footer. Quick tidy." }));
    await press("Check the footer. Quick tidy.");
    await waitFor(() => expect(screen.getByRole("radio", { name: "site" }).props.accessibilityState).toMatchObject({ selected: true }));
    await press("Start the chat");
    await waitFor(() => expect(lastOf("new_chat")).toEqual({ op: "new_chat", project: "/Users/me/site", text: "Fix the footer links.", permissions: null, preset: null, workflow: null }));
  });

  it("closes the sheet with the system's back button before it leaves anything else", async () => {
    await open({ chats: [chat()] }, {}, answers);
    await press("New chat");
    await waitFor(() => screen.getByRole("button", { name: "Start the chat" }));
    await act(async () => void backHandlers[backHandlers.length - 1]({ nativeEvent: {} } as never));
    expect(screen.queryByRole("button", { name: "Start the chat" })).toBeNull();
    expect(screen.getByText("Nothing")).toBeTruthy();
  });
});

describe("moving around", () => {
  it("opens a chat from Home and goes back to it", async () => {
    await open({ chats: [chat()] });
    await press(/Release 0.1.53/);
    await settle();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    await press("Back");
    await settle();
    expect(screen.getByText("Nothing")).toBeTruthy();
  });

  it("reviews a prompt from the stack, and comes back to Home when it is closed", async () => {
    await open({ chats: [chat()], waiting: [waiting()] });
    await press("Review");
    expect(screen.getByLabelText("Swipe to allow")).toBeTruthy();
    await press("Deny");
    await waitFor(() => expect(screen.getByText("Denied.")).toBeTruthy());
    await press("Done");
    await settle();
    // Back on Home: its headline, which counts what waits.
    expect(screen.getByText(/^\d+ things?$/)).toBeTruthy();
  });

  it("the system's back button goes back a screen before it leaves the app", async () => {
    await open({ chats: [chat()] });
    await press(/Release 0.1.53/);
    await settle();
    expect(backHandlers.length).toBeGreaterThan(0);
    await act(async () => void backHandlers[backHandlers.length - 1]({ nativeEvent: {} } as never));
    await settle();
    expect(screen.getByText("Nothing")).toBeTruthy();
  });

  it("a tapped notification opens its chat, and says it did", async () => {
    const onOpened = jest.fn();
    await open({ chats: [chat({ slot: "release" })] }, { openSlot: "release", onOpened });
    await settle();
    expect(onOpened).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  });
});

describe("the optional tips", () => {
  it("open from the card on Home, and the system's back button closes them", async () => {
    await open({ chats: [chat()], waiting: [] });
    await press("Support development");
    expect(screen.getByRole("header", { name: "Support development" })).toBeTruthy();
    // It says it is optional (the card on Home says so too: the sheet's words are the longer ones).
    expect(screen.getByText(/If it helps you, you can leave a small thanks/)).toBeTruthy();
    await act(async () => void backHandlers[backHandlers.length - 1]({ nativeEvent: {} } as never));
    expect(screen.queryByRole("header", { name: "Support development" })).toBeNull();
  });

  it("open from the Mac's sheet too, which gives way to them", async () => {
    await open({ chats: [chat()], waiting: [] });
    await press("Aly's MacBook Pro, connected");
    // Two: the card on Home and, on top of it, the sheet's own button.
    const buttons = screen.getAllByRole("button", { name: "Support development" });
    expect(buttons).toHaveLength(2);
    await fireEvent.press(buttons[buttons.length - 1]);
    await settle();
    expect(screen.getByRole("header", { name: "Support development" })).toBeTruthy();
    expect(screen.queryByText("Connected through 192.168.1.20")).toBeNull();
  });

  it("close from Close", async () => {
    await open({ chats: [chat()], waiting: [] });
    await press("Support development");
    await press("Close");
    expect(screen.queryByRole("header", { name: "Support development" })).toBeNull();
  });
});

describe("the Mac's sheet", () => {
  it("unpairs this phone from it, and the phone goes back to asking to pair", async () => {
    const { controller } = await open({ chats: [chat()] });
    const unpair = jest.spyOn(controller, "unpair").mockImplementation(async () => controller.setConnection({ kind: "unpaired" }));
    await press("Aly's MacBook Pro, connected");
    expect(screen.getByText("Connected through 192.168.1.20")).toBeTruthy();
    await press("Unpair this phone");
    await settle();
    expect(unpair).toHaveBeenCalled();
    expect(screen.getByText("Pair with your Mac")).toBeTruthy();
    expect(connected.kind).toBe("connected");
  });
});
