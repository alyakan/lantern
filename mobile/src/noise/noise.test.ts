import vectors from "../protocol/generated/noise-vectors.json";
import { Channel } from "./channel";
import { CONNECT_PATTERN, Handshake, keypairFrom, PAIR_PATTERN } from "./noise";

const bytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const text = (s: string) => new TextEncoder().encode(s);

type Case = (typeof vectors)[number];

/** Plays the phone's side of a case's handshake with its fixed keys; the Mac's message is the one snow recorded. */
function replay(c: Case) {
  const phone = keypairFrom(bytes(c.phone_static));
  const mac = keypairFrom(bytes(c.mac_static)).publicKey;
  const hs = c.psk ? Handshake.pair(phone, mac, bytes(c.psk), bytes(c.phone_ephemeral)) : Handshake.connect(phone, mac, bytes(c.phone_ephemeral));
  const first = hs.write();
  hs.read(bytes(c.messages[1]));
  const third = hs.write();
  const { send, receive } = hs.finish();
  return { first, third, channel: new Channel(send, receive) };
}

describe("the phone's Noise against the Mac's (snow), byte for byte", () => {
  it("has both handshakes recorded", () => {
    expect(vectors.filter((c) => !c.impostor).map((c) => c.pattern).sort()).toEqual([CONNECT_PATTERN, PAIR_PATTERN].sort());
    expect(vectors.filter((c) => c.impostor)).toHaveLength(1);
  });

  for (const c of vectors) {
    describe(c.pattern, () => {
      it("writes the same handshake messages", () => {
        const { first, third } = replay(c);
        expect(hex(first)).toBe(c.messages[0]);
        expect(hex(third)).toBe(c.messages[2]);
      });

      it("seals a message the way the Mac reads it, and reads the Mac's", () => {
        const { channel } = replay(c);
        expect(channel.seal(text(c.phone_to_mac.plain)).map(hex)).toEqual(c.phone_to_mac.frames);
        const got = c.mac_to_phone.frames.map((f) => channel.open(bytes(f)));
        expect(new TextDecoder().decode(got[got.length - 1]!)).toBe(c.mac_to_phone.plain);
      });
    });
  }
});

describe("the phone only talks to the Mac it paired with", () => {
  for (const c of vectors) {
    it(`${c.pattern}: a Mac with another key is refused before the phone's key is sent`, () => {
      const phone = keypairFrom(bytes(c.phone_static));
      const someoneElse = keypairFrom(new Uint8Array(32).fill(42)).publicKey;
      const hs = c.psk ? Handshake.pair(phone, someoneElse, bytes(c.psk), bytes(c.phone_ephemeral)) : Handshake.connect(phone, someoneElse, bytes(c.phone_ephemeral));
      hs.write();
      expect(() => hs.read(bytes(c.messages[1]))).toThrow("isn't the Mac you paired with");
      expect(() => hs.write()).toThrow();
    });
  }

  it("with the wrong secret the phone's last message isn't the one the Mac would accept", () => {
    // XXpsk3 mixes the secret in at message 3, so it is the Mac that refuses it there (the gateway's tests show it).
    const c = vectors.find((v) => v.psk)!;
    const phone = keypairFrom(bytes(c.phone_static));
    const mac = keypairFrom(bytes(c.mac_static)).publicKey;
    const wrong = bytes(c.psk);
    wrong[0] ^= 1;
    const hs = Handshake.pair(phone, mac, wrong, bytes(c.phone_ephemeral));
    expect(hex(hs.write())).toBe(c.messages[0]);
    hs.read(bytes(c.messages[1]));
    expect(hex(hs.write())).not.toBe(c.messages[2]);
  });

  it("turns are kept: no reading before writing, no finishing early", () => {
    const c = vectors[0];
    const hs = Handshake.connect(keypairFrom(bytes(c.phone_static)), new Uint8Array(32));
    expect(() => hs.read(new Uint8Array(96))).toThrow("isn't the Mac's turn");
    expect(() => hs.finish()).toThrow("isn't finished");
  });
});

describe("the channel", () => {
  const pairOfChannels = () => {
    const c = vectors.find((v) => !v.psk)!;
    // The phone's two ciphers, and a mirror built from the same handshake for the Mac's side.
    const a = replay(c);
    const b = replay(c);
    return { phone: a.channel, mirror: b.channel };
  };

  it("splits a big message into frames and refuses one past the limit", () => {
    const { phone } = pairOfChannels();
    expect(phone.seal(new Uint8Array(200_000)).length).toBe(4);
    expect(phone.seal(new Uint8Array(0)).length).toBe(1);
    expect(() => phone.seal(new Uint8Array((8 << 20) + 1))).toThrow("too big");
  });

  it("closes after a tampered frame, refusing even good ones", () => {
    const c = vectors.find((v) => !v.psk)!;
    const { channel } = replay(c);
    const good = bytes(c.mac_to_phone.frames[0]);
    const bad = good.slice();
    bad[0] ^= 1;
    expect(() => channel.open(bad)).toThrow();
    expect(() => channel.open(good)).toThrow("closed");
    expect(() => channel.seal(text("x"))).toThrow("closed");
  });

  it("refuses a frame replayed or bigger than a Noise message", () => {
    const c = vectors.find((v) => !v.psk)!;
    const { channel } = replay(c);
    const frame = bytes(c.mac_to_phone.frames[0]);
    expect(channel.open(frame)).not.toBeNull();
    expect(() => channel.open(frame)).toThrow();
    const { channel: fresh } = replay(c);
    expect(() => fresh.open(new Uint8Array(65536))).toThrow("bigger");
  });
});
