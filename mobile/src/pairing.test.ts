import { fromBase64Url, readPairingLink, toBase64Url } from "./pairing";

const key = toBase64Url(new Uint8Array(32).fill(1));
const secret = toBase64Url(new Uint8Array(32).fill(9));
// The shape the Mac's pairing_link writes (src-tauri/src/remote/pairing.rs).
const link = (over: Record<string, string> = {}) => {
  const q = { v: "1", k: key, s: secret, h: "192.168.1.20%2C10.0.0.5", p: "47123", n: "Aly%27s%20MacBook%20Pro", e: "1000", ...over };
  return `lantern://pair?${Object.entries(q).map(([k, v]) => `${k}=${v}`).join("&")}`;
};

describe("reading a pairing code", () => {
  it("takes the Mac's key, the secret, its addresses, port and name", () => {
    const o = readPairingLink(link(), 0);
    if ("error" in o) throw new Error(o.error);
    expect(o.macKey).toEqual(new Uint8Array(32).fill(1));
    expect(o.secret).toEqual(new Uint8Array(32).fill(9));
    expect(o.hosts).toEqual(["192.168.1.20", "10.0.0.5"]);
    expect([o.port, o.macName, o.expiresAt]).toEqual([47123, "Aly's MacBook Pro", 1000]);
  });

  it("refuses another app's code, a damaged one and an expired one, saying which", () => {
    expect(readPairingLink("https://example.com/pair", 0)).toEqual({ error: "That isn't a Lantern pairing code." });
    expect(readPairingLink("not a url", 0)).toEqual({ error: "That isn't a Lantern pairing code." });
    expect(readPairingLink(link({ v: "2" }), 0)).toEqual({ error: "That code is from a newer Lantern. Update this app." });
    expect(readPairingLink(link({ k: "short" }), 0)).toEqual({ error: "That code is damaged. Show a new one on your Mac." });
    expect(readPairingLink(link({ p: "99999" }), 0)).toEqual({ error: "That code is damaged. Show a new one on your Mac." });
    expect(readPairingLink(link(), 1000)).toEqual({ error: "That code has expired. Show a new one on your Mac." });
  });

  it("dials only private addresses from a code, so a code can't send the phone elsewhere", () => {
    const o = readPairingLink(link({ h: "8.8.8.8%2C192.168.1.4%2Cevil.example%2C172.16.0.1%2C172.32.0.1%2C10.0.0.300" }), 0);
    if ("error" in o) throw new Error(o.error);
    expect(o.hosts).toEqual(["192.168.1.4", "172.16.0.1"]);
  });

  it("round-trips URL-safe base64", () => {
    const b = Uint8Array.from({ length: 33 }, (_, i) => i * 7);
    expect(fromBase64Url(toBase64Url(b))).toEqual(b);
    expect(() => fromBase64Url("not+safe")).toThrow();
  });
});
