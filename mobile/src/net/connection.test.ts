import { connectCase, FakeMac, impostorCase, pairCase, phoneKeys, routeTransport } from "../test/fakeMac";
import { toBase64Url, type PairingOffer } from "../pairing";
import { MemoryStore } from "../test/memoryStore";
import { BACKOFF_MS, Connection, isTailnetHost, macId, savedHosts, type ConnectionState, type PairedMac } from "./connection";
import { STEP_WAIT, type Pushed } from "./session";
import { queueLink, type Transport } from "./transport";

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

  it("with nowhere to dial, says the code has no address, not that the Mac is on another Wi-Fi", async () => {
    const r = rig();
    await expect(r.conn.pair(offer(r.k, []))).rejects.toThrow("no address for your Mac");
  });

  it("keeps the addresses the Mac says it has now, Tailscale's too, in place of the code's", async () => {
    const r = rig(pairCase, { hosts: ["192.168.1.20", "100.101.102.103"] });
    await r.conn.pair(offer(r.k, ["192.168.1.20"]));
    expect(r.store.mac?.hosts).toEqual(["192.168.1.20", "100.101.102.103"]);
  });

  it("keeps the address it paired over first even when the Mac doesn't list it, as an Android emulator's 10.0.2.2 isn't", async () => {
    const r = rig(pairCase, { hosts: ["192.168.1.20", "100.101.102.103"], reachable: ["10.0.2.2"] });
    await r.conn.pair(offer(r.k, ["10.0.2.2"]));
    expect(r.store.mac?.hosts).toEqual(["10.0.2.2", "192.168.1.20", "100.101.102.103"]);
  });

  it("keeps the code's addresses when an older Mac gives none", async () => {
    const r = rig();
    await r.conn.pair(offer(r.k, ["192.168.1.20", "10.0.0.5"]));
    expect(r.store.mac?.hosts).toEqual(["192.168.1.20", "10.0.0.5"]);
  });

  it("gives a Tailscale address longer to answer than a local one, which on any other network never will", async () => {
    const r = rig(pairCase, { reachable: ["100.101.102.103"] });
    await r.conn.pair(offer(r.k, ["192.168.1.20", "100.101.102.103"]));
    expect(r.mac.opened).toEqual(["192.168.1.20:47123", "100.101.102.103:47123"]);
    expect(r.mac.openWaits[0]).toBeLessThan(r.mac.openWaits[1]!);
    expect(r.mac.openWaits).toEqual([1500, 6000]);
  });
});

describe("the addresses kept for the Mac", () => {
  it("are the one that worked, then the Mac's list, each once", () => {
    expect(savedHosts("100.1.2.3", ["192.168.1.20", "100.1.2.3"], ["10.0.0.5"])).toEqual(["100.1.2.3", "192.168.1.20"]);
    expect(savedHosts("100.1.2.3", undefined, ["192.168.1.20", "100.1.2.3"])).toEqual(["100.1.2.3", "192.168.1.20"]);
    expect(savedHosts("100.1.2.3", [], ["10.0.0.5"])).toEqual(["100.1.2.3", "10.0.0.5"]);
  });

  it("take only plain addresses and names from the Mac, and no more than eight", () => {
    const odd = ["ws://evil.example/x", "a b", "mac.local/..", "", 5, null, "192.168.1.20", "x".repeat(300)];
    expect(savedHosts("100.1.2.3", odd, [])).toEqual(["100.1.2.3", "192.168.1.20"]);
    const many = Array.from({ length: 20 }, (_, i) => `10.0.0.${i}`);
    expect(savedHosts("100.1.2.3", many, [])).toHaveLength(8);
    expect(savedHosts("100.1.2.3", many, [])[0]).toBe("100.1.2.3");
  });
});

describe("Tailscale addresses", () => {
  it("are the ones in 100.64.0.0/10 and no others", () => {
    for (const h of ["100.64.0.1", "100.101.102.103", "100.127.255.254"]) expect(isTailnetHost(h)).toBe(true);
    for (const h of ["100.63.255.255", "100.128.0.1", "10.100.64.1", "192.168.1.20", "mac.local", "100.64.0", "100.100.100.100.1"]) expect(isTailnetHost(h)).toBe(false);
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

  it("a phone paired before the Mac was on Tailscale picks the address up when it connects", async () => {
    const r = rig(connectCase, { hosts: ["192.168.1.20", "100.101.102.103"] });
    r.store.mac = paired(r.k);
    await r.conn.start();
    for (let i = 0; i < 8; i++) await flush();
    // The address that worked goes first, then the Mac's list.
    expect(r.store.mac?.hosts).toEqual(["192.168.1.20", "100.101.102.103"]);
    expect(r.store.mac?.macName).toBe("Test Mac");
  });

  it("a phone started again, with the app killed meanwhile, dials first the address that worked, so away from home it goes to Tailscale at once", async () => {
    const first = rig(connectCase, { reachable: ["100.101.102.103"], hosts: ["192.168.1.20", "100.101.102.103"] });
    first.store.mac = { ...paired(first.k), hosts: ["192.168.1.20", "100.101.102.103"] };
    await first.conn.start();
    for (let i = 0; i < 8; i++) await flush();
    expect(first.store.mac?.hosts).toEqual(["100.101.102.103", "192.168.1.20"]);
    first.conn.stop();
    // A new Connection, as after the app was killed: nothing but the saved Mac to go on.
    const mac = new FakeMac(connectCase, { reachable: ["100.101.102.103"], hosts: ["192.168.1.20", "100.101.102.103"] });
    const again = new Connection({ deviceName: "Test phone", appVersion: "1.0", onPushed: () => {}, onState: () => {}, transport: mac, store: first.store, newKey: () => first.k.device, fixedEphemeral: first.k.ephemeral });
    await again.start();
    for (let i = 0; i < 8; i++) await flush();
    expect(mac.opened).toEqual(["100.101.102.103:47123"]);
    again.stop();
  });

  it("an older Mac that gives no addresses leaves the saved ones alone", async () => {
    const r = rig(connectCase);
    r.store.mac = paired(r.k);
    await r.conn.start();
    for (let i = 0; i < 8; i++) await flush();
    expect(r.store.mac?.hosts).toEqual(["192.168.1.20"]);
  });

  it("a Mac forgotten while it was connecting isn't saved again with its new addresses", async () => {
    const r = rig(connectCase, { hosts: ["192.168.1.20", "100.101.102.103"] });
    r.store.mac = paired(r.k);
    await r.conn.start();
    await r.conn.forget();
    for (let i = 0; i < 8; i++) await flush();
    expect(r.store.mac).toBeNull();
  });

  it("after a drop it tries first the address that worked, so away from home it doesn't wait on the local ones", async () => {
    const r = rig(connectCase, { reachable: ["100.101.102.103"], hosts: ["192.168.1.20", "100.101.102.103"] });
    r.store.mac = { ...paired(r.k), hosts: ["192.168.1.20", "100.101.102.103"] };
    await r.conn.start();
    for (let i = 0; i < 8; i++) await flush();
    expect(r.mac.opened).toEqual(["192.168.1.20:47123", "100.101.102.103:47123"]);
    r.mac.dropAll();
    for (let i = 0; i < 12; i++) await flush();
    expect(r.mac.opened.slice(2)).toEqual(["100.101.102.103:47123"]);
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

  it("a Mac that refuses the code ends pairing there: the other addresses aren't dialled and the error says why", async () => {
    const k = phoneKeys(pairCase);
    const first = new FakeMac(pairCase);
    const second = new FakeMac(pairCase, { reachable: [] });
    const states: ConnectionState[] = [];
    const conn = new Connection({ ...quiet, onState: (s) => states.push(s), transport: routeTransport({ "10.0.0.9": first, "192.168.1.20": second }), store: new MemoryStore(), newKey: () => k.device, fixedEphemeral: new Uint8Array(32).fill(5) });
    // The secret is wrong, so the Mac at 10.0.0.9 closes on the first message: the code is spent, whatever 192.168.1.20 says.
    await expect(conn.pair({ ...offer(k, ["10.0.0.9", "192.168.1.20"]), secret: new Uint8Array(32) })).rejects.toThrow("didn't take this code");
    expect(first.opened).toHaveLength(1);
    expect(second.opened).toEqual([]);
    // Nothing was paired before, so it is back to waiting for a code (the reason reaches the screen as the thrown error).
    await flush();
    expect(states.at(-1)).toEqual({ kind: "unpaired" });
  });

  it("a code that fails doesn't take a paired phone off its own Mac", async () => {
    const kc = phoneKeys(connectCase);
    const kp = phoneKeys(pairCase);
    const mine = new FakeMac(connectCase);
    const store = new MemoryStore();
    store.mac = { macKey: toBase64Url(kc.macKey), deviceKey: toBase64Url(kc.device.privateKey), hosts: ["192.168.1.20"], port: 47123, macName: "My Mac" };
    const states: ConnectionState[] = [];
    const conn = new Connection({ ...quiet, onState: (s) => states.push(s), transport: routeTransport({ "192.168.1.20": mine, "10.0.0.9": new FakeMac(pairCase) }), store, newKey: () => kp.device, fixedEphemeral: kc.ephemeral });
    await conn.start();
    for (let i = 0; i < 10 && !states.some((s) => s.kind === "connected"); i++) await flush();
    expect(states.at(-1)).toMatchObject({ kind: "connected", host: "192.168.1.20" });
    // Someone's link names another Mac, and its code doesn't work.
    await expect(conn.pair({ ...offer(kp, ["10.0.0.9"]), secret: new Uint8Array(32) })).rejects.toThrow("didn't take this code");
    for (let i = 0; i < 20 && mine.opened.length < 2; i++) await flush();
    for (let i = 0; i < 10 && states.at(-1)?.kind !== "connected"; i++) await flush();
    expect(mine.opened).toHaveLength(2);
    expect(states.at(-1)).toMatchObject({ kind: "connected", host: "192.168.1.20" });
    expect(store.mac?.macName).toBe("My Mac");
  });

  it("a Mac that says nothing at one address leaves the next address to be tried", async () => {
    jest.useFakeTimers();
    try {
      const k = phoneKeys(pairCase);
      const mac = new FakeMac(pairCase);
      // Accepts the connection and never answers, like a Mac that is asleep behind an address.
      const transport: Transport = { open: (host, port, wait) => (host === "10.0.0.9" ? Promise.resolve(queueLink(() => {}, () => {}).link) : mac.open(host, port, wait)) };
      const states: ConnectionState[] = [];
      const conn = new Connection({ ...quiet, onState: (s) => states.push(s), transport, store: new MemoryStore(), newKey: () => k.device, fixedEphemeral: k.ephemeral });
      const paired = conn.pair(offer(k, ["10.0.0.9", "192.168.1.20"]));
      // In steps, so the wait exists by the time the clock gets to it.
      for (let t = 0; t <= STEP_WAIT + 1000; t += 500) await jest.advanceTimersByTimeAsync(500);
      await paired;
      expect(states.at(-1)).toMatchObject({ kind: "connected", host: "192.168.1.20" });
    } finally {
      jest.useRealTimers();
    }
  });
});
