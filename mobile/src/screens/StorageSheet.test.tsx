import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { AppLock, type AuthResult, type LockPlatform, type Strength } from "../lock";
import type { RemoteStorage } from "../protocol/generated/RemoteStorage";
import { LockContext } from "../shell/lockContext";
import { attachSession } from "../test/fakeSession";
import { connected, connectedWith, makeController, renderWith } from "../test/render";
import { lightColors } from "../ui/theme";
import { MacSheet } from "./OfflineScreen";
import { StorageSheet } from "./StorageSheet";

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))));

const items = [
  { id: "aa000001", kind: "build_output", name: "lantern/target", bytes: 9_400_000_000, to_trash: false, note: "Rust build output; cargo makes it again." },
  { id: "aa000002", kind: "cache", name: "Xcode DerivedData", bytes: 3_100_000_000, to_trash: false, note: "Xcode rebuilds it." },
];
const view = (over: Partial<RemoteStorage> = {}): RemoteStorage => ({ free_bytes: 62_000_000_000, total_bytes: 494_000_000_000, scanned_at: Date.now() - 5 * 60_000, scanning: false, progress: "", deleting: false, items, more: 0, report: null, ...over });

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

async function open(over: { answers?: Parameters<typeof attachSession>[1]; strength?: Strength; results?: AuthResult[] } = {}) {
  const { controller } = makeController();
  const session = attachSession(controller, over.answers ?? { storage: view() }, ["storage"]);
  const { lock, asked, options } = await holder(over.strength ?? "biometric", over.results);
  const onClose = jest.fn();
  await renderWith(
    <LockContext.Provider value={lock}>
      <StorageSheet onClose={onClose} />
    </LockContext.Provider>,
    { connection: connectedWith(["storage"]) },
    controller,
  );
  await settle();
  return { ...session, asked, options, onClose, controller };
}

describe("the Mac's storage", () => {
  it("shows how much room the disk has, how fresh the scan is, and what is safe to clear with its sizes", async () => {
    await open();
    expect(screen.getByText("62 GB free of 494 GB")).toBeTruthy();
    expect(screen.getByText("Scanned 5 min ago")).toBeTruthy();
    expect(screen.getByText("Safe to clear: 12.5 GB")).toBeTruthy();
    expect(screen.getByText("lantern/target")).toBeTruthy();
    expect(screen.getByText("9.4 GB")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Clear safe items \(12\.5 GB\)/ })).toBeTruthy();
  });

  it("keeps the disk bar calm while it is 87% full, and yellow only from 90%, red from 95%", async () => {
    const fill = () => StyleSheet.flatten(screen.getByTestId("disk-fill").props.style).backgroundColor;
    await open({ answers: { storage: view({ free_bytes: 13, total_bytes: 100 }) } });
    expect(fill()).toBe(lightColors.go);
  });

  it("goes yellow at 90% full and red at 95%", async () => {
    const fill = () => StyleSheet.flatten(screen.getByTestId("disk-fill").props.style).backgroundColor;
    await open({ answers: { storage: view({ free_bytes: 9, total_bytes: 100 }) } });
    expect(fill()).toBe(lightColors.hi);
  });

  it("goes red at 95% full", async () => {
    await open({ answers: { storage: view({ free_bytes: 4, total_bytes: 100 }) } });
    expect(StyleSheet.flatten(screen.getByTestId("disk-fill").props.style).backgroundColor).toBe(lightColors.stop);
  });

  it("asks Face ID first, never the passcode, then says what it will clear before it clears anything", async () => {
    const t = await open();
    await fireEvent.press(screen.getByRole("button", { name: /Clear safe items/ }));
    await settle();
    expect(t.asked).toEqual(["Clear safe items on your Mac"]);
    expect(t.options).toEqual([{ biometricOnly: true }]);
    expect(screen.getByText(/Clear 2 items on your Mac, about 12\.5 GB\?/)).toBeTruthy();
    expect(t.asked.length).toBe(1);
    expect(t.lastOf("storage_clear")).toBeUndefined();
  });

  it("sends the ids it showed when it is confirmed, and says how it went", async () => {
    const t = await open({ answers: { storage: view(), storage_clear: { started: 2, bytes: 12_500_000_000 } } });
    await fireEvent.press(screen.getByRole("button", { name: /Clear safe items/ }));
    await settle();
    await fireEvent.press(screen.getByRole("button", { name: "Clear 12.5 GB" }));
    await settle();
    expect(t.lastOf("storage_clear")).toEqual({ op: "storage_clear", ids: ["aa000001", "aa000002"] });
  });

  it("clears nothing if Face ID is cancelled or fails, and says so when it fails", async () => {
    const t = await open({ results: ["cancelled", "failed"] });
    await fireEvent.press(screen.getByRole("button", { name: /Clear safe items/ }));
    await settle();
    expect(screen.queryByText(/Clear 2 items/)).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: /Clear safe items/ }));
    await settle();
    expect(screen.getByText(/nothing was cleared/)).toBeTruthy();
    expect(t.lastOf("storage_clear")).toBeUndefined();
  });

  it("can't clear on a phone with no Face ID set up, and says what to do", async () => {
    const t = await open({ strength: "none" });
    await fireEvent.press(screen.getByRole("button", { name: /Clear safe items/ }));
    await settle();
    expect(screen.getByText(/needs Face ID \(or Touch ID\) set up/)).toBeTruthy();
    expect(t.lastOf("storage_clear")).toBeUndefined();
  });

  it("says how much of what it clears only goes to the Trash", async () => {
    const trashed = [{ ...items[0], to_trash: true }, items[1]];
    await open({ answers: { storage: view({ items: trashed }) } });
    await fireEvent.press(screen.getByRole("button", { name: /Clear safe items/ }));
    await settle();
    expect(screen.getByText(/9\.4 GB of it goes to the Trash/)).toBeTruthy();
  });

  it("has no clear button for an old scan, nothing safe, or while the Mac works; and asks for a new scan", async () => {
    await open({ answers: { storage: view({ scanned_at: Date.now() - 2 * 60 * 60 * 1000 }) } });
    expect(screen.queryByRole("button", { name: /Clear safe items/ })).toBeNull();
    expect(screen.getByText(/more than an hour old/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Scan again" })).toBeTruthy();
  });

  it("says nothing is safe when nothing is", async () => {
    await open({ answers: { storage: view({ items: [] }) } });
    expect(screen.getByText("Nothing is safe to clear right now.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Clear safe items/ })).toBeNull();
  });

  it("starts a scan from the button, and shows a scan that is running instead of the clear button", async () => {
    const t = await open({ answers: { storage: view({ scanned_at: null, items: [] }), storage_scan: true } });
    expect(screen.getByText("Not scanned yet")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Scan" }));
    await settle();
    expect(t.lastOf("storage_scan")).toEqual({ op: "storage_scan" });
  });

  it("shows a running scan and a running clear, with no button that would start another", async () => {
    await open({ answers: { storage: view({ scanning: true, progress: "Caches" }) } });
    expect(screen.getByText("Scanning: Caches")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Clear safe items/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Scan/ })).toBeNull();
  });

  it("tells how the last clear went, with what couldn't be cleared", async () => {
    await open({ answers: { storage: view({ items: [], report: { ok: 3, failed: 1, freed: 4_200_000_000, at: Date.now() - 60_000 } }) } });
    expect(screen.getByText(/Cleared 3 items, about 4\.2 GB\./)).toBeTruthy();
    expect(screen.getByText(/1 couldn't be cleared/)).toBeTruthy();
  });

  it("says what the Mac says when it can't show its storage", async () => {
    await open({ answers: { storage: new Error("This Mac can't show its storage.") } });
    expect(screen.getByText("This Mac can't show its storage.")).toBeTruthy();
  });

  it("says how many more there are on the Mac than are listed", async () => {
    await open({ answers: { storage: view({ more: 12 }) } });
    expect(screen.getByText(/and 12 more on your Mac/)).toBeTruthy();
  });
});

describe("the way in, from the Mac's sheet", () => {
  it("is offered to a Mac that lists storage, and to no other", async () => {
    const onStorage = jest.fn();
    const base = { onClose: jest.fn(), onUnpair: jest.fn(), onStorage };
    await renderWith(<MacSheet state={connectedWith(["storage"])} {...base} />, {});
    await fireEvent.press(screen.getByRole("button", { name: "Mac storage" }));
    expect(onStorage).toHaveBeenCalledTimes(1);
  });

  it("is not offered to an older Mac, which would end the connection at a request it doesn't know", async () => {
    await renderWith(<MacSheet state={connected} onClose={jest.fn()} onUnpair={jest.fn()} onStorage={jest.fn()} />, {});
    expect(screen.queryByRole("button", { name: "Mac storage" })).toBeNull();
  });
});
