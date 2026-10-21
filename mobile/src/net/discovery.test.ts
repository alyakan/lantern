import { zeroconfDiscovery, type ZeroconfFactory } from "./discovery";

type Handlers = { resolved?: (s: unknown) => void; error?: (e: unknown) => void };

function fake(onScan?: (h: Handlers) => void) {
  const handlers: Handlers = {};
  const calls: string[] = [];
  const zc = {
    on: (event: "resolved" | "error", cb: (x: never) => void) => {
      (handlers as Record<string, unknown>)[event] = cb;
      return zc;
    },
    scan: (o: unknown) => {
      calls.push(`scan ${JSON.stringify(o)}`);
      onScan?.(handlers);
    },
    stop: () => calls.push("stop"),
    removeDeviceListeners: () => calls.push("remove"),
  };
  return { make: (() => zc) as unknown as ZeroconfFactory, calls };
}

describe("finding the Mac by Bonjour", () => {
  it("scans for Lantern, and gives back each Mac that answers with its address, port and id", async () => {
    const f = fake((h) => {
      h.resolved?.({ port: 47123, ipv4: ["192.168.1.20"], addresses: ["192.168.1.20", "fe80::1"], txt: { v: "1", id: "nN2SU8UHhA" } });
      h.resolved?.({ port: 47123, ipv4: ["192.168.1.20"], txt: { id: "nN2SU8UHhA" } });
      h.resolved?.({ port: 9, addresses: ["fe80::2", "10.0.0.4"], txt: { id: "other" } });
      h.resolved?.({ port: 9, ipv4: ["10.0.0.5"], txt: {} });
    });
    const found = await zeroconfDiscovery(f.make).find(5);
    expect(found).toEqual([
      { host: "192.168.1.20", port: 47123, id: "nN2SU8UHhA" },
      { host: "10.0.0.4", port: 9, id: "other" },
    ]);
    expect(f.calls[0]).toBe('scan {"type":"lantern","protocol":"tcp","domain":"local."}');
    expect(f.calls.slice(1)).toEqual(["stop", "remove"]);
  });

  it("finds nothing when the native module isn't there, or scanning fails", async () => {
    expect(await zeroconfDiscovery(() => null).find(5)).toEqual([]);
    const broken = fake(() => {
      throw new Error("local network refused");
    });
    expect(await zeroconfDiscovery(broken.make).find(5)).toEqual([]);
  });

  it("ignores errors the scan reports, and stops at the end of its wait", async () => {
    const f = fake((h) => h.error?.(new Error("TIMEOUT")));
    expect(await zeroconfDiscovery(f.make).find(5)).toEqual([]);
    expect(f.calls).toContain("stop");
  });
});
