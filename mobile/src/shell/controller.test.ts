import { connectCase, FakeMac, pairCase, phoneKeys } from "../test/fakeMac";
import { MemoryStore } from "../test/memoryStore";
import { toBase64Url } from "../pairing";
import { Controller } from "./controller";

const flush = () => new Promise((r) => setTimeout(r, 0));

function rig(c = pairCase) {
  const mac = new FakeMac(c, { answer: (r) => (r.op === "list_waiting" ? [] : null) });
  const store = new MemoryStore();
  const k = phoneKeys(c);
  const controller = new Controller({
    transport: mac,
    store,
    deviceName: "Test phone",
    appVersion: "1.0",
    now: () => 0,
    sync: { schedule: (fn) => queueMicrotask(fn) },
  });
  // The recorded handshake replays this phone's keys.
  (controller.connection as unknown as { d: Record<string, unknown> }).d.newKey = () => k.device;
  (controller.connection as unknown as { d: Record<string, unknown> }).d.fixedEphemeral = k.ephemeral;
  return { controller, mac, store, k };
}

const link = (k: ReturnType<typeof phoneKeys>, over: Record<string, string> = {}) => {
  const q = { v: "1", k: toBase64Url(k.macKey), s: toBase64Url(k.secret!), h: "192.168.1.20", p: "47123", n: "Aly%27s%20Mac", e: "1000", ...over };
  return `lantern://pair?${Object.entries(q).map(([a, b]) => `${a}=${b}`).join("&")}`;
};

describe("the app's controller", () => {
  it("previews what a link would pair with before it does anything, and says why a link can't be used", () => {
    const { controller, k } = rig();
    expect(controller.preview(link(k))).toMatchObject({ macName: "Aly's Mac", host: "192.168.1.20" });
    expect(controller.preview("https://example.com")).toEqual({ error: "That isn't a Lantern pairing code." });
    expect(controller.preview(link(k, { e: "0" }))).toEqual({ error: "That code has expired. Show a new one on your Mac." });
    expect(controller.preview(link(k, { h: "8.8.8.8" }))).toMatchObject({ host: null });
  });

  it("pairs from a link, reports being connected, and hands the Mac's chat list to the sync", async () => {
    const { controller, mac, store, k } = rig();
    expect(controller.getConnection()).toEqual({ kind: "connecting" });
    expect(await controller.pair(link(k))).toBeNull();
    expect(controller.getConnection()).toMatchObject({ kind: "connected" });
    expect(store.mac?.macKey).toBe(toBase64Url(k.macKey));
    mac.push({ type: "chats", chats: [{ slot: "a", title: "Release", project: "lantern", status: "idle", last_seq: 1, active_at: 1, permissions: null, preset: null }] });
    await flush();
    await flush();
    controller.sync.flush();
    expect(controller.sync.getState().chats[0]).toMatchObject({ slot: "a", title: "Release" });
  });

  it("says why pairing didn't work, in words, and stays unpaired", async () => {
    const { controller, store, k } = rig();
    expect(await controller.pair(link(k, { v: "2" }))).toBe("That code is from a newer Lantern. Update this app.");
    expect(await controller.pair("nonsense")).toBe("That isn't a Lantern pairing code.");
    expect(store.mac).toBeNull();
  });

  it("with no Mac paired says so; unpairing forgets the Mac and everything it said", async () => {
    const { controller, store, k } = rig();
    await controller.start();
    expect(controller.getConnection()).toEqual({ kind: "unpaired" });
    await controller.pair(link(k));
    (controller.sync as unknown as { onPushed: (m: unknown) => void }).onPushed({ type: "chats", chats: [{ slot: "a", title: "x", project: null, status: "idle", last_seq: 0, active_at: 0 }] });
    controller.sync.flush();
    await controller.unpair();
    expect(store.mac).toBeNull();
    expect(controller.getConnection()).toEqual({ kind: "unpaired" });
    expect(controller.sync.getState().chats).toEqual([]);
  });

  it("knows its own id on the Mac's list, named from its key as the Mac names it", async () => {
    const { controller, k } = rig();
    expect(controller.getDeviceId()).toBeNull();
    await controller.pair(link(k));
    await flush();
    expect(controller.getDeviceId()).toBe(`phone-${toBase64Url(k.device.publicKey).slice(0, 12)}`);
  });

  it("tells whoever is listening when the connection's state changes", async () => {
    const { controller, k } = rig(connectCase);
    const seen: string[] = [];
    controller.subscribeConnection(() => seen.push(controller.getConnection().kind));
    await controller.start();
    expect(seen).toEqual(["unpaired"]);
    expect(k.secret).toBeNull();
  });
});
