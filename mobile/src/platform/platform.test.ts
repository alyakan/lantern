import vectors from "../protocol/generated/noise-vectors.json";
import { Channel } from "../noise/channel";
import { Handshake, keypairFrom } from "../noise/noise";
import { readPairingLink } from "../pairing";
import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from "./utf8";
import { randomBytes } from "./random";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));

describe("UTF-8 and base64url without the engine's help", () => {
  const samples = ["", "plain", "héllo", "日本語", "emoji 🚀 and 👩‍💻", "line\nbreak\ttab", "\u0000nul", "a".repeat(10_000)];

  it("encodes and decodes like TextEncoder and TextDecoder", () => {
    for (const s of samples) {
      expect(hex(utf8Encode(s))).toBe(hex(new TextEncoder().encode(s)));
      expect(utf8Decode(new TextEncoder().encode(s))).toBe(s);
    }
  });

  it("turns a lone surrogate into U+FFFD going out, and invalid bytes into U+FFFD coming in", () => {
    expect(utf8Decode(utf8Encode("a\ud800b"))).toBe("a�b");
    for (const bad of [[0xff], [0xc0, 0x80], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xf5, 0x80, 0x80, 0x80], [0xe2, 0x82]]) {
      expect(utf8Decode(Uint8Array.from(bad))).toBe(new TextDecoder().decode(Uint8Array.from(bad)));
    }
  });

  it("round-trips base64url of every length like Buffer does, and refuses what isn't base64url", () => {
    for (let n = 0; n < 40; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
      expect(toBase64Url(b)).toBe(btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
      expect(fromBase64Url(toBase64Url(b))).toEqual(b);
    }
    for (const bad of ["a", "ab=", "a+b/", "a b c", "abcde"]) expect(() => fromBase64Url(bad)).toThrow();
  });

  it("won't make a key without secure random numbers", () => {
    const real = (globalThis as { crypto?: unknown }).crypto;
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    try {
      expect(() => randomBytes(32)).toThrow("no secure random");
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: real, configurable: true });
    }
    expect(randomBytes(32)).toHaveLength(32);
  });
});

describe("the phone's core with the globals Hermes may lack taken away", () => {
  const gone = ["TextEncoder", "TextDecoder", "atob", "btoa", "URL", "URLSearchParams"] as const;
  const saved: Record<string, unknown> = {};

  beforeAll(() => {
    // Every original is read before any is removed: Expo loads some of them lazily, and those need the others.
    for (const name of gone) saved[name] = (globalThis as Record<string, unknown>)[name];
    for (const name of gone) Object.defineProperty(globalThis, name, { value: undefined, configurable: true, writable: true });
  });
  afterAll(() => {
    for (const name of gone) Object.defineProperty(globalThis, name, { value: saved[name], configurable: true, writable: true });
  });

  it("reads a pairing code", () => {
    const key = toBase64Url(new Uint8Array(32).fill(1));
    const secret = toBase64Url(new Uint8Array(32).fill(2));
    const offer = readPairingLink(`lantern://pair?v=1&k=${key}&s=${secret}&h=192.168.1.4%2C10.0.0.2&p=47123&n=Aly%27s%20Mac&e=99`, 0);
    expect(offer).toMatchObject({ hosts: ["192.168.1.4", "10.0.0.2"], port: 47123, macName: "Aly's Mac" });
  });

  it("runs the recorded handshakes and a channel to the same bytes", () => {
    for (const c of vectors.filter((v) => !v.impostor)) {
      const phone = keypairFrom(bytes(c.phone_static));
      const mac = keypairFrom(bytes(c.mac_static)).publicKey;
      const hs = c.psk ? Handshake.pair(phone, mac, bytes(c.psk), bytes(c.phone_ephemeral)) : Handshake.connect(phone, mac, bytes(c.phone_ephemeral));
      expect(hex(hs.write())).toBe(c.messages[0]);
      hs.read(bytes(c.messages[1]));
      expect(hex(hs.write())).toBe(c.messages[2]);
      const { send, receive } = hs.finish();
      const channel = new Channel(send, receive);
      expect(channel.seal(utf8Encode(c.phone_to_mac.plain)).map(hex)).toEqual(c.phone_to_mac.frames);
      const frames = c.mac_to_phone.frames.map((f) => channel.open(bytes(f)));
      expect(utf8Decode(frames[frames.length - 1]!)).toBe(c.mac_to_phone.plain);
    }
  });

  it("counts messages past 2^32 in the nonce's two halves", () => {
    const c = vectors.find((v) => !v.psk && !v.impostor)!;
    const phone = keypairFrom(bytes(c.phone_static));
    const hs = Handshake.connect(phone, keypairFrom(bytes(c.mac_static)).publicKey, bytes(c.phone_ephemeral));
    hs.write();
    hs.read(bytes(c.messages[1]));
    hs.write();
    const { send } = hs.finish();
    // Set the counter near the 32-bit boundary: two messages either side of it must differ, and not throw.
    (send as unknown as { n: number }).n = 0xffffffff;
    const a = send.encrypt(new Uint8Array(0), Uint8Array.of(1));
    const b = send.encrypt(new Uint8Array(0), Uint8Array.of(1));
    expect(hex(a)).not.toBe(hex(b));
    expect((send as unknown as { n: number }).n).toBe(0x100000001);
  });
});
