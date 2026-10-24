import "@shopify/flash-list/jestSetup";
import { BackHandler } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { toBase64Url } from "../pairing";
import { loadNotesSeen, saveNotesSeen } from "../prefs";
import { attachSession } from "../test/fakeSession";
import { chat, connected, makeController, seed, waiting } from "../test/render";
import { Root, type RootProps } from "./Root";

jest.mock("expo-camera", () => ({ CameraView: () => null, useCameraPermissions: () => [{ granted: false, canAskAgain: true }, jest.fn()] }));
jest.mock("expo-clipboard", () => ({ getStringAsync: jest.fn(async () => "") }));
jest.mock("./useLayout", () => ({ useLayout: () => "phone" }));
// This build's notes, as a release build carries them.
jest.mock("../releaseNotes.json", () => ({ version: "0.1.0", build: 15, notes: ["A paired phone can show a pairing code for another device.", "The chat list holds still while chats work."] }));
jest.mock("../prefs", () => ({ ...jest.requireActual("../prefs"), loadNotesSeen: jest.fn(), saveNotesSeen: jest.fn(async () => {}) }));

const seen = loadNotesSeen as jest.Mock;
const saved = saveNotesSeen as jest.Mock;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))));
const press = (name: string | RegExp) => fireEvent.press(screen.getByRole("button", { name }));
const heading = () => screen.queryByRole("header", { name: "What's new" });

type BackHandlerFn = Parameters<typeof BackHandler.addEventListener>[1];
let backHandlers: BackHandlerFn[] = [];
beforeEach(() => {
  seen.mockReset();
  saved.mockClear();
  backHandlers = [];
  jest.spyOn(BackHandler, "addEventListener").mockImplementation((_event, cb) => {
    backHandlers.push(cb);
    return { remove: () => void (backHandlers = backHandlers.filter((h) => h !== cb)) };
  });
});

async function open(connection: Parameters<typeof seed>[1]["connection"] = connected, props: Partial<RootProps> = {}) {
  const { controller } = makeController();
  seed(controller, { connection, chats: [chat()], waiting: [waiting()] });
  attachSession(controller, { list_waiting: [waiting()] });
  await render(<Root controller={controller} {...props} />);
  await settle();
  return controller;
}

describe("what's new, after an update", () => {
  it("opens once, with Home, when this build isn't the last whose notes were shown, and remembers it", async () => {
    seen.mockResolvedValue("0.1.0-14");
    await open();
    expect(heading()).toBeTruthy();
    expect(screen.getByText("Build 15")).toBeTruthy();
    expect(screen.getByText("A paired phone can show a pairing code for another device.")).toBeTruthy();
    expect(screen.getByText("The chat list holds still while chats work.")).toBeTruthy();
    expect(saved).toHaveBeenCalledWith("0.1.0-15");
    await press("Close");
    expect(heading()).toBeNull();
  });

  it("opens for a phone updating from a build that kept nothing", async () => {
    seen.mockResolvedValue(null);
    await open();
    expect(heading()).toBeTruthy();
    expect(saved).toHaveBeenCalledWith("0.1.0-15");
  });

  it("opens for a new version's first build, though a higher build number of the old version was the last shown", async () => {
    seen.mockResolvedValue("0.0.9-40");
    await open();
    expect(heading()).toBeTruthy();
  });

  it("does not open again for a build whose notes were shown", async () => {
    seen.mockResolvedValue("0.1.0-15");
    await open();
    expect(heading()).toBeNull();
    expect(saved).not.toHaveBeenCalled();
  });

  it("opens for a phone that is already paired when it starts: the real start-up, with a saved pairing, never passes through unpaired", async () => {
    seen.mockResolvedValue(null);
    const { controller, store } = makeController();
    const bytes = (n: number) => toBase64Url(new Uint8Array(32).fill(n));
    store.mac = { macKey: bytes(1), deviceKey: bytes(2), hosts: ["10.0.0.4"], port: 47123, macName: "Aly's MacBook Pro" };
    // The Mac can't be reached (nothing in the test answers), and the chats it had are kept: that is Home, offline.
    controller.sync.apply({ type: "pushed", msg: { type: "chats", chats: [chat()] } });
    const states: string[] = [];
    controller.subscribeConnection(() => states.push(controller.getConnection().kind));
    await render(<Root controller={controller} />);
    await act(async () => void (await controller.start()));
    await settle();
    expect(states).not.toContain("unpaired");
    expect(heading()).toBeTruthy();
    expect(saved).toHaveBeenCalledWith("0.1.0-15");
    // The connection keeps trying for a Mac that isn't there: wake it from its pause and stop it (in that order: a stopped one
    // that is resumed starts afresh), so the test run can end.
    controller.resume();
    controller.connection.stop();
  });

  it("stays on the pairing screen, with nothing shown or marked, when a phone with nothing saved starts: the real start-up says unpaired", async () => {
    seen.mockResolvedValue(null);
    const { controller } = makeController();
    await render(<Root controller={controller} />);
    await act(async () => void (await controller.start()));
    await settle();
    expect(controller.getConnection().kind).toBe("unpaired");
    expect(heading()).toBeNull();
    expect(saved).not.toHaveBeenCalled();
  });

  it("does not open on a new install, where nothing is new: pairing first, then Home, only marks the notes as shown", async () => {
    seen.mockResolvedValue(null);
    const controller = await open({ kind: "unpaired" });
    expect(heading()).toBeNull();
    await act(async () => controller.setConnection(connected));
    await settle();
    expect(heading()).toBeNull();
    expect(saved).toHaveBeenCalledWith("0.1.0-15");
  });

  it("stays away from the pairing screen and doesn't count it as shown", async () => {
    seen.mockResolvedValue("0.1.0-14");
    await open({ kind: "unpaired" });
    expect(heading()).toBeNull();
    expect(seen).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
  });

  it("waits while another sheet is open, and comes up when it is closed", async () => {
    let answer: (id: string) => void = () => {};
    seen.mockReturnValue(new Promise<string>((r) => (answer = r)));
    await open();
    await press("Aly's MacBook Pro, connected");
    await act(async () => answer("0.1.0-14"));
    await settle();
    expect(heading()).toBeNull();
    expect(saved).not.toHaveBeenCalled();
    await press("Close");
    await settle();
    expect(heading()).toBeTruthy();
    expect(saved).toHaveBeenCalledWith("0.1.0-15");
  });

  it("stays off a chat that a tapped notification opened at launch, and comes up when the phone goes back to Home", async () => {
    seen.mockResolvedValue("0.1.0-14");
    await open(connected, { openSlot: "a" });
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(heading()).toBeNull();
    expect(saved).not.toHaveBeenCalled();
    await press("Back");
    await settle();
    expect(heading()).toBeTruthy();
    expect(saved).toHaveBeenCalledWith("0.1.0-15");
  });

  it("is closed by the system's back button before anything else goes back", async () => {
    seen.mockResolvedValue("0.1.0-14");
    await open();
    expect(heading()).toBeTruthy();
    let handled: unknown;
    await act(async () => void (handled = backHandlers[backHandlers.length - 1]({ nativeEvent: {} } as never)));
    expect(handled).toBe(true);
    expect(heading()).toBeNull();
  });
});

describe("what's new, from the Mac sheet", () => {
  it("is always there to open again, even when it was shown", async () => {
    seen.mockResolvedValue("0.1.0-15");
    await open();
    expect(heading()).toBeNull();
    await press("Aly's MacBook Pro, connected");
    await press("What's new");
    expect(heading()).toBeTruthy();
    expect(screen.getByText("The chat list holds still while chats work.")).toBeTruthy();
    // The Mac sheet is gone: the notes took its place.
    expect(screen.queryByText("Unpair this phone")).toBeNull();
  });
});
