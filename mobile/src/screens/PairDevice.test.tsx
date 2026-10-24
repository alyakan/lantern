import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { AppState } from "react-native";
import * as Clipboard from "expo-clipboard";
import { AppLock, type AuthResult, type LockPlatform, type Strength } from "../lock";
import type { PairOffer } from "../protocol/generated/PairOffer";
import { LockContext } from "../shell/lockContext";
import { attachSession } from "../test/fakeSession";
import { connected, connectedWith, makeController, renderWith } from "../test/render";
import { MacSheet } from "./OfflineScreen";
import { PairDeviceSheet } from "./PairDevice";

// A clipboard that holds what was put on it.
let mockClipboard = "";
jest.mock("expo-clipboard", () => ({
  getStringAsync: jest.fn(async () => mockClipboard),
  setStringAsync: jest.fn(async (s: string) => {
    mockClipboard = s;
  }),
}));

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))));

/** The squares of a code that is plausible: 21 across, with the corner pattern every code has. */
const grid = () => Array.from({ length: 21 }, (_, y) => (y < 7 ? "1111111" : "0000000").padEnd(21, "0101010101010101010101").slice(0, 21));
const offer = (over: Partial<PairOffer> = {}): PairOffer => ({ link: "lantern://pair?v=1&k=KEY&s=SECRET&h=192.168.1.20&p=47123&n=Mac&e=1", expires_at: Date.now() + 5 * 60_000, modules: grid(), ...over });

/** A phone that can check who holds it as `strength` says, and answers each check from `results` (then "ok"). */
async function holder(strength: Strength, results: AuthResult[] = []) {
  const asked: string[] = [];
  const options: ({ biometricOnly?: boolean } | undefined)[] = [];
  const platform: LockPlatform = {
    strength: async () => strength,
    method: async () => "Face ID",
    authenticate: async (reason, o) => {
      asked.push(reason);
      options.push(o);
      return results.shift() ?? "ok";
    },
  };
  const lock = new AppLock(platform, { load: async () => false, save: async () => {} });
  await lock.start();
  return { lock, asked, options };
}

// The app's own state changes, for the test to send.
let appStates: ((s: string) => void)[] = [];
beforeEach(() => {
  mockClipboard = "";
  appStates = [];
  jest.spyOn(AppState, "addEventListener").mockImplementation((_event, cb) => {
    appStates.push(cb as (s: string) => void);
    return { remove: () => void (appStates = appStates.filter((h) => h !== cb)) };
  });
});

async function open(over: { strength?: Strength; results?: AuthResult[]; answer?: unknown; onClose?: () => void } = {}) {
  const { controller } = makeController();
  const session = attachSession(controller, { pair_offer: over.answer === undefined ? offer() : over.answer }, ["pair"]);
  const { lock, asked, options } = await holder(over.strength ?? "biometric", over.results);
  const onClose = over.onClose ?? jest.fn();
  await renderWith(
    <LockContext.Provider value={lock}>
      <PairDeviceSheet onClose={onClose} />
    </LockContext.Provider>,
    { connection: connectedWith(["pair"]) },
    controller,
  );
  await settle();
  return { ...session, asked, options, onClose };
}

describe("showing a pairing code for another device", () => {
  it("asks Face ID first, never the passcode, then asks the Mac and shows the code with how long it works", async () => {
    const t = await open();
    expect(t.asked).toEqual(["Pair another device with your Mac"]);
    expect(t.options[0]).toEqual({ biometricOnly: true });
    expect(t.lastOf("pair_offer")).toEqual({ op: "pair_offer" });
    expect(screen.getByTestId("pair-qr")).toBeTruthy();
    expect(screen.getByText(/Works once, for 5:00 more|Works once, for 4:5\d more/)).toBeTruthy();
    // It says who it would let in, and that the Mac's own code stops working.
    expect(screen.getByText(/Whoever scans it before then can see and control your Mac's chats/)).toBeTruthy();
    expect(screen.getByText(/A code Lantern is showing on the Mac stops working/)).toBeTruthy();
  });

  it("asks nothing of the Mac, and shows nothing, until Face ID has passed; cancelling it closes the sheet", async () => {
    const t = await open({ results: ["cancelled"] });
    expect(t.lastOf("pair_offer")).toBeUndefined();
    expect(screen.queryByTestId("pair-qr")).toBeNull();
    expect(t.onClose).toHaveBeenCalled();
  });

  it("says so when the phone has no Face ID or Touch ID set up, and doesn't fall back to the passcode", async () => {
    const t = await open({ strength: "none" });
    expect(t.lastOf("pair_offer")).toBeUndefined();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/needs Face ID \(or Touch ID\) set up on this phone/)).toBeTruthy();
    expect(screen.queryByTestId("pair-qr")).toBeNull();
  });

  it("makes no code when the check failed, and tries again from the button", async () => {
    const t = await open({ results: ["failed"] });
    expect(screen.getByText(/no code was made/)).toBeTruthy();
    expect(t.lastOf("pair_offer")).toBeUndefined();
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(t.asked).toHaveLength(2);
    expect(screen.getByTestId("pair-qr")).toBeTruthy();
  });

  it("says what the Mac said when it refuses, and shows no code", async () => {
    await open({ answer: new Error("Turn on Remote control first.") });
    expect(screen.getByText("Turn on Remote control first.")).toBeTruthy();
    expect(screen.queryByTestId("pair-qr")).toBeNull();
  });

  it("doesn't draw an answer that isn't a code", async () => {
    await open({ answer: offer({ modules: ["1010", "0101"] }) });
    expect(screen.queryByTestId("pair-qr")).toBeNull();
    expect(screen.getByRole("alert")).toBeTruthy();
    await screen.unmount();
    await open({ answer: offer({ link: "https://example.com/pair" }) });
    expect(screen.queryByTestId("pair-qr")).toBeNull();
  });

  it("lets go of the code the moment the app is left, and asks Face ID again for a new one", async () => {
    const t = await open();
    expect(screen.getByTestId("pair-qr")).toBeTruthy();
    // Inactive is enough: it is what the app switcher's picture is taken in.
    await act(async () => appStates.forEach((h) => h("inactive")));
    expect(screen.queryByTestId("pair-qr")).toBeNull();
    expect(screen.getByText(/hidden when you left the app/)).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Make a new code" }));
    await settle();
    expect(t.asked).toHaveLength(2);
    expect(screen.getByTestId("pair-qr")).toBeTruthy();
  });

  it("drops the code when its time is up", async () => {
    await open({ answer: offer({ expires_at: Date.now() + 1500 }) });
    expect(screen.getByTestId("pair-qr")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("pair-qr")).toBeNull(), { timeout: 4000 });
    expect(screen.getByText(/The code expired/)).toBeTruthy();
  });

  it("copies the link for pasting on the other device, and takes it off the clipboard when the code goes", async () => {
    const o = offer();
    await open({ answer: o });
    await fireEvent.press(screen.getByRole("button", { name: "Copy the link" }));
    await settle();
    expect(mockClipboard).toBe(o.link);
    expect(screen.getByRole("button", { name: "Link copied" })).toBeTruthy();
    await act(async () => appStates.forEach((h) => h("background")));
    await settle();
    expect(mockClipboard).toBe("");
    expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith("");
  });

  it("leaves the clipboard alone when something else is on it by the time the code goes", async () => {
    const o = offer();
    await open({ answer: o });
    await fireEvent.press(screen.getByRole("button", { name: "Copy the link" }));
    await settle();
    mockClipboard = "something the person copied since";
    await act(async () => appStates.forEach((h) => h("background")));
    await settle();
    expect(mockClipboard).toBe("something the person copied since");
  });
});

describe("the Mac's sheet", () => {
  const sheet = async (state: typeof connected, onPairDevice?: () => void) => renderWith(<MacSheet state={state} onClose={jest.fn()} onUnpair={jest.fn()} onPairDevice={onPairDevice} />, { connection: state });

  it("offers to pair another device only when the Mac can make a code", async () => {
    const press = jest.fn();
    await sheet(connectedWith(["pair"]), press);
    await fireEvent.press(screen.getByRole("button", { name: "Pair another device" }));
    expect(press).toHaveBeenCalled();
  });

  it("doesn't offer it on an older Mac, which would end the connection at a request it doesn't know", async () => {
    await sheet(connectedWith(["controls", "shell"]), jest.fn());
    expect(screen.queryByRole("button", { name: "Pair another device" })).toBeNull();
  });

  it("doesn't offer it while the Mac is out of reach", async () => {
    await sheet({ kind: "offline", reason: "x", retryInMs: 1000 } as never, jest.fn());
    expect(screen.queryByRole("button", { name: "Pair another device" })).toBeNull();
  });
});
