import vectors from "./cacophony-vectors.json";
import { CONNECT_PATTERN, Handshake, keypairFrom, PAIR_PATTERN } from "./noise";

/**
 * The published Noise test vectors (cacophony's, for the two patterns Lantern uses), played from the initiator's side:
 * every message it writes must be the vector's, every one it reads must open to the vector's payload, and the
 * handshake hash and transport messages must match.
 */
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("the published Noise test vectors", () => {
  it("cover both of Lantern's patterns", () => {
    expect(vectors.map((v) => v.protocol_name).sort()).toEqual([CONNECT_PATTERN, PAIR_PATTERN].sort());
  });

  for (const v of vectors) {
    it(`${v.protocol_name}: handshake, hash and transport messages`, () => {
      const mac = keypairFrom(bytes(v.resp_static)).publicKey;
      const psk = v.init_psks.length ? bytes(v.init_psks[0]) : null;
      const hs = Handshake.forVectors(keypairFrom(bytes(v.init_static)), mac, psk, bytes(v.init_ephemeral), bytes(v.init_prologue));
      const [m0, m1, m2, ...transport] = v.messages;
      expect(hex(hs.write(bytes(m0.payload)))).toBe(m0.ciphertext);
      expect(hex(hs.read(bytes(m1.ciphertext)))).toBe(m1.payload);
      expect(hex(hs.write(bytes(m2.payload)))).toBe(m2.ciphertext);
      expect(hex(hs.hash())).toBe(v.handshake_hash);
      const { send, receive } = hs.finish();
      // After the handshake the responder speaks first, then they take turns.
      transport.forEach((m, i) => {
        if (i % 2 === 0) expect(hex(receive.decrypt(new Uint8Array(0), bytes(m.ciphertext)))).toBe(m.payload);
        else expect(hex(send.encrypt(new Uint8Array(0), bytes(m.payload)))).toBe(m.ciphertext);
      });
    });
  }
});
