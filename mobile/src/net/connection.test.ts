import { connectCase, FakeMac, impostorCase, pairCase, phoneKeys, routeTransport } from "../test/fakeMac";
import { toBase64Url, type PairingOffer } from "../pairing";
import { MemoryStore } from "../test/memoryStore";
import { BACKOFF_MS, Connection, macId, type ConnectionState, type PairedMac } from "./connection";
import type { Pushed } from "./session";

const flush = () => new Promise((r) => setTimeout(r, 0));

function rig(c = pairCase, o: ConstructorParameters<typeof FakeMac>[1] = {}) {
  const mac = new FakeMac(c, o);
  const store = new MemoryStore();
  const states: ConnectionState[] = [];
  const pushed: Pushed[] = [];
  const waits: number[] = [];
  const k = phoneKeys(c);
  const conn = new Connection({
    transport: mac,
    store,
    deviceName: "Test phone",
    appVersion: "1.0",
    onPushed: (m) => pushed.push(m),
    onState: (s) => states.push(s),
    newKey: () => k.device,
    fixedEphemeral: k.ephemeral,
    wait: async (ms) => {
      waits.push(ms);
      await flush();
    },
  });
  return { mac, store, states, pushed, waits, conn, k };
}

const offer = (k: ReturnType<typeof phoneKeys>, hosts = ["192.168.1.20"]): PairingOffer => ({ macKey: k.macKey, secret: k.secret!, hosts, port: 47123, macName: "Code's Mac", expiresAt: Infinity });

describe("pairing", () => {
  it("pairs with the Mac a code names, says hello with this phone's name, and keeps the Mac", async () => {
    const r = rig();
    await r.conn.pair(offer(r.k));
    expect(r.mac.hellos[0]).toMatchObject({ protocol: 1, device_name: "Test phone" });
    expect(r.store.mac).toEqual({ macKey: toBase64Url(r.k.macKey), deviceKey: toBase64Url(r.k.device.privateKey), hosts: ["192.168.1.20"], port: 47123, macName: "Test Mac" });
    expect(r.states.at(-1)).toMatchObject({ kind: "connected", host: "192.168.1.20" });
  });

  it("asks and hears answers, and errors come back as errors", async () => {
    const r = rig(pairCase, {
      answer: (req) => {
        if (req.op === "list_chats") return [{ slot: "a" }];
        throw new Error("That chat isn't open on your Mac.");
      },
    });
    await r.conn.pair(offer(r.k));
    await expect(r.conn.current()!.ask({ op: "list_chats" })).resolves.toEqual([{ slot: "a" }]);
    await expect(r.conn.current()!.ask({ op: "wake", slot: "x" })).rejects.toThrow("isn't open");
  });

  it("hears what the Mac pushes", async () => {
    const r = rig();
    await r.conn.pair(offer(r.k));
    r.mac.push({ type: "chats", chats: [] });
    await flush();
    await flush();
    expect(r.pushed).toEqual([{ type: "chats", chats: [] }]);
  });

  it("tries the next address when one doesn't answer", async () => {
    const r = rig(pairCase, { reachable: ["10.0.0.5"] });
    await r.conn.pair(offer(r.k, ["192.168.1.20", "10.0.0.5"]));
    expect(r.mac.opened).toEqual(["192.168.1.20:47123", "10.0.0.5:47123"]);
  });

  it("says which side to update when the Mac speaks another protocol, and keeps nothing", async () => {
    const r = rig(pairCase, { protocol: 2 });
    await expect(r.conn.pair(offer(r.k))).rejects.toThrow("Update the app");
    expect(r.store.mac).toBeNull();
  });

  it("with nowhere to dial, says the Mac isn't on this Wi-Fi", async () => {
    const r = rig();
    await expect(r.conn.pair(offer(r.k, []))).rejects.toThrow("isn't on this Wi-Fi");
  });
});

describe("staying connected", () => {
  const paired = (k: ReturnType<typeof phoneKeys>): PairedMac => ({ macKey: toBase64Url(k.macKey), deviceKey: toBase64Url(k.device.privateKey), hosts: ["192.168.1.20"], port: 47123, macName: "Test Mac" });

  it("with no Mac paired it says so", async () => {
    const r = rig(connectCase);
    await r.conn.start();
    expect(r.states).toEqual([{ kind: "unpaired" }]);
  });

  it("connects to the paired Mac, and comes back after the link drops", async () => {
    const r = rig(connectCase);
    r.store.mac = paired(r.k);
    const sessions: unknown[] = [];
    (r.conn as unknown as { d: { onSession: (s: unknown) => void } }).d.onSession = (s) => sessions.push(s);
    await r.conn.start();
    for (let i = 0; i < 5; i++) await flush();
    expect(r.states.at(-1)).toMatchObject({ kind: "connected" });
    r.mac.dropAll();
    for (let i = 0; i < 10; i++) await flush();
    expect(r.states.at(-1)).toMatchObject({ kind: "connected" });
    expect(sessions).toHaveLength(2);
  });

  it("waits longer each time the Mac can't be reached, up to 30 seconds", async () => {
    const r = rig(connectCase, { reachable: [] });
    r.store.mac = paired(r.k);
    await r.conn.start();
    for (let i = 0; i < 40 && r.waits.length < 8; i++) await flush();
    r.conn.stop();
    expect(r.waits.slice(0, 8)).toEqual([...BACKOFF_MS, 30000, 30000]);
    expect(r.states.find((s) => s.kind === "offline")).toMatchObject({ reason: expect.stringContaining("Can't reach Test Mac") });
  });

  it("prefers where Bonjour found its own Mac, and ignores other Macs", async () => {
    const r = rig(connectCase);
    r.store.mac = paired(r.k);
    (r.conn as unknown as { d: { discovery: unknown } }).d.discovery = {
      find: async () => [
        { host: "192.168.1.99", port: 47123, id: "someoneelse" },
        { host: "192.168.1.50", port: 47123, id: macId(toBase64Url(r.k.macKey)) },
      ],
    };
    await r.conn.start();
    for (let i = 0; i < 5; i++) await flush();
    expect(r.mac.opened[0]).toBe("192.168.1.50:47123");
    expect(r.mac.opened).not.toContain("192.168.1.99:47123");
  });

  it("forgetting the Mac stops and says it is unpaired", async () => {
    const r = rig();
    await r.conn.pair(offer(r.k));
    await r.conn.forget();
    expect(r.store.mac).toBeNull();
    expect(r.states.at(-1)).toEqual({ kind: "unpaired" });
  });
});

describe("what goes wrong around a connection", () => {
  const quiet = { deviceName: "Test phone", appVersion: "1.0", onPushed: () => {}, onState: () => {} };

  it("an impostor at one address doesn't stop pairing at the next", async () => {
    const k = phoneKeys(pairCase);
    const store = new MemoryStore();
    const states: ConnectionState[] = [];
    const conn = new Connection({ ...quiet, onState: (s) => states.push(s), transport: routeTransport({ "10.0.0.9": new FakeMac(impostorCase), "192.168.1.20": new FakeMac(pairCase) }), store, newKey: () => k.device, fixedEphemeral: k.ephemeral });
    await conn.pair(offer(k, ["10.0.0.9", "192.168.1.20"]));
    expect(states.at(-1)).toMatchObject({ kind: "connected", host: "192.168.1.20" });
    expect(store.mac?.macKey).toBe(toBase64Url(k.macKey));
  });

  it("an impostor alone is refused, and nothing is kept", async () => {
    const k = phoneKeys(pairCase);
    const store = new MemoryStore();
    const conn = new Connection({ ...quiet, transport: routeTransport({ "10.0.0.9": new FakeMac(impostorCase) }), store, newKey: () => k.device, fixedEphemeral: k.ephemeral });
    await expect(conn.pair(offer(k, ["10.0.0.9"]))).rejects.toThrow("isn't the Mac you paired with");
    expect(store.mac).toBeNull();
  });

  it("starting twice runs one loop and opens one connection", async () => {
    const r = rig(connectCase);
    r.store.mac = { macKey: toBase64Url(r.k.macKey), deviceKey: toBase64Url(r.k.device.privateKey), hosts: ["192.168.1.20"], port: 47123, macName: "Test Mac" };
    await Promise.all([r.conn.start(), r.conn.start()]);
    for (let i = 0; i < 10; i++) await flush();
    await r.conn.start();
    expect(r.mac.opened).toHaveLength(1);
  });

  it("coming back to the foreground tries again at once instead of finishing the pause", async () => {
    const mac = new FakeMac(connectCase, { reachable: [] });
    const k = phoneKeys(connectCase);
    const store = new MemoryStore();
    store.mac = { macKey: toBase64Url(k.macKey), deviceKey: toBase64Url(k.device.privateKey), hosts: ["192.168.1.20"], port: 47123, macName: "Test Mac" };
    const states: ConnectionState[] = [];
    // A pause that never ends by itself.
    const conn = new Connection({ ...quiet, onState: (s) => states.push(s), transport: mac, store, fixedEphemeral: k.ephemeral, wait: () => new Promise(() => {}) });
    await conn.start();
    for (let i = 0; i < 10 && !states.some((s) => s.kind === "offline"); i++) await flush();
    expect(mac.opened).toHaveLength(1);
    conn.resume();
    for (let i = 0; i < 10 && mac.opened.length < 2; i++) await flush();
    expect(mac.opened).toHaveLength(2);
    conn.stop();
  });

  it("a Mac that goes quiet during the handshake is said so, and the link is let go", async () => {
    const k = phoneKeys(pairCase);
    const mac = new FakeMac(pairCase, { reachable: ["192.168.1.20"] });
    const closed: string[] = [];
    const transport = { open: async (h: string, p: number, w: number) => { const l = await mac.open(h, p, w); const close = l.close; l.close = () => { closed.push(h); close(); }; return l; } };
    // The offer's secret is wrong, so the Mac closes on the first message.
    const store = new MemoryStore();
    const conn = new Connection({ ...quiet, transport, store, newKey: () => k.device, fixedEphemeral: new Uint8Array(32).fill(5) });
    await expect(conn.pair({ ...offer(k), secret: new Uint8Array(32) })).rejects.toThrow("didn't take this code");
    expect(closed).toEqual(["192.168.1.20"]);
    expect(store.mac).toBeNull();
  });
});
