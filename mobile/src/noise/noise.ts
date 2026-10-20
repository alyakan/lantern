/**
 * The phone's half of Lantern's Noise handshakes (see the Mac's src-tauri/src/remote/secure.rs), on audited primitives
 * (@noble). Pairing is Noise_XXpsk3_25519_ChaChaPoly_SHA256 with the QR code's one-time secret; connecting again is
 * Noise_XX_25519_ChaChaPoly_SHA256. The phone always starts (it is the initiator), and it checks the Mac's key against
 * the one it pinned from the QR code before it sends its own: a Mac with another key never learns this phone's.
 *
 * Checked against transcripts the Mac's own Noise (snow) records with fixed keys, byte for byte, and against the
 * published Noise test vectors.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";

export const PAIR_PATTERN = "Noise_XXpsk3_25519_ChaChaPoly_SHA256";
export const CONNECT_PATTERN = "Noise_XX_25519_ChaChaPoly_SHA256";
/** Bound into every handshake: one for anything else (another protocol, another version) fails. */
export const PROLOGUE = new TextEncoder().encode("lantern-remote/1");
/** What the phone sends before its handshake (secure.rs's PAIR and CONNECT). */
export const PAIR = 0x50;
export const CONNECT = 0x43;

const DH_LEN = 32;
const TAG_LEN = 16;
const EMPTY = new Uint8Array(0);

export interface Keypair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export function keypairFrom(privateKey: Uint8Array): Keypair {
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

export function generateKeypair(): Keypair {
  return keypairFrom(x25519.utils.randomSecretKey());
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** HKDF as Noise defines it, with HMAC-SHA256: two or three 32-byte outputs. */
function hkdf(ck: Uint8Array, ikm: Uint8Array, n: 2 | 3): Uint8Array[] {
  const temp = hmac(sha256, ck, ikm);
  const o1 = hmac(sha256, temp, Uint8Array.of(1));
  const o2 = hmac(sha256, temp, concat(o1, Uint8Array.of(2)));
  if (n === 2) return [o1, o2];
  return [o1, o2, hmac(sha256, temp, concat(o2, Uint8Array.of(3)))];
}

/** ChaCha20-Poly1305 with Noise's nonce: 4 zero bytes, then the counter, little-endian. */
export class CipherState {
  private n = 0n;
  constructor(private k: Uint8Array | null = null) {}

  hasKey() {
    return this.k !== null;
  }

  private nonce() {
    const out = new Uint8Array(12);
    new DataView(out.buffer).setBigUint64(4, this.n, true);
    return out;
  }

  encrypt(ad: Uint8Array, plain: Uint8Array): Uint8Array {
    if (!this.k) return plain;
    const out = chacha20poly1305(this.k, this.nonce(), ad).encrypt(plain);
    this.n += 1n;
    return out;
  }

  /** Throws on a message that doesn't authenticate; the counter doesn't move then. */
  decrypt(ad: Uint8Array, cipher: Uint8Array): Uint8Array {
    if (!this.k) return cipher;
    const out = chacha20poly1305(this.k, this.nonce(), ad).decrypt(cipher);
    this.n += 1n;
    return out;
  }
}

type Token = "e" | "s" | "ee" | "es" | "se" | "psk";
const XX: Token[][] = [["e"], ["e", "ee", "s", "es"], ["s", "se"]];
const XX_PSK3: Token[][] = [["e"], ["e", "ee", "s", "es"], ["s", "se", "psk"]];

/**
 * The phone's side of a handshake, a message at a time: write, read, write. `pinned`: the Mac's key from the QR code;
 * the handshake fails if the Mac proves another.
 */
export class Handshake {
  private ck: Uint8Array;
  private h: Uint8Array;
  private cipher = new CipherState();
  private e: Keypair | null = null;
  private re: Uint8Array | null = null;
  private rs: Uint8Array | null = null;
  private step = 0;
  private readonly tokens: Token[][];

  private constructor(
    private readonly s: Keypair,
    private readonly pinned: Uint8Array,
    private readonly psk: Uint8Array | null,
    /** Tests only: the ephemeral key to use instead of a random one. */
    private readonly fixedEphemeral: Uint8Array | null,
    prologue: Uint8Array = PROLOGUE,
  ) {
    const name = new TextEncoder().encode(psk ? PAIR_PATTERN : CONNECT_PATTERN);
    this.h = name.length <= 32 ? concat(name, new Uint8Array(32 - name.length)) : sha256(name);
    this.ck = this.h;
    this.mixHash(prologue);
    this.tokens = psk ? XX_PSK3 : XX;
  }

  /** The published Noise test vectors, which have a prologue of their own. Tests only. */
  static forVectors(phone: Keypair, macKey: Uint8Array, psk: Uint8Array | null, ephemeral: Uint8Array, prologue: Uint8Array) {
    return new Handshake(phone, macKey, psk, ephemeral, prologue);
  }

  /** The handshake hash once it is finished (what both sides end up with). */
  hash() {
    return this.h;
  }

  static pair(phone: Keypair, macKey: Uint8Array, secret: Uint8Array, fixedEphemeral: Uint8Array | null = null) {
    if (secret.length !== 32) throw new Error("A pairing secret is 32 bytes.");
    return new Handshake(phone, macKey, secret, fixedEphemeral);
  }

  static connect(phone: Keypair, macKey: Uint8Array, fixedEphemeral: Uint8Array | null = null) {
    return new Handshake(phone, macKey, null, fixedEphemeral);
  }

  private mixHash(data: Uint8Array) {
    this.h = sha256(concat(this.h, data));
  }

  private mixKey(ikm: Uint8Array) {
    const [ck, k] = hkdf(this.ck, ikm, 2);
    this.ck = ck;
    this.cipher = new CipherState(k);
  }

  private mixKeyAndHash(ikm: Uint8Array) {
    const [ck, h, k] = hkdf(this.ck, ikm, 3);
    this.ck = ck;
    this.mixHash(h);
    this.cipher = new CipherState(k);
  }

  private encryptAndHash(plain: Uint8Array) {
    const c = this.cipher.encrypt(this.h, plain);
    this.mixHash(c);
    return c;
  }

  private decryptAndHash(cipher: Uint8Array) {
    const p = this.cipher.decrypt(this.h, cipher);
    this.mixHash(cipher);
    return p;
  }

  private dh(priv: Uint8Array, pub: Uint8Array) {
    return x25519.getSharedSecret(priv, pub);
  }

  /** Messages 1 and 3. `payload`: what goes in them (Lantern's handshakes carry none). */
  write(payload: Uint8Array = EMPTY): Uint8Array {
    if (this.step !== 0 && this.step !== 2) throw new Error("It isn't the phone's turn in the handshake.");
    const out: Uint8Array[] = [];
    for (const t of this.tokens[this.step]) {
      if (t === "e") {
        this.e = this.fixedEphemeral ? keypairFrom(this.fixedEphemeral) : generateKeypair();
        out.push(this.e.publicKey);
        this.mixHash(this.e.publicKey);
        if (this.psk) this.mixKey(this.e.publicKey);
      } else if (t === "s") {
        out.push(this.encryptAndHash(this.s.publicKey));
      } else if (t === "se") {
        this.mixKey(this.dh(this.s.privateKey, this.re!));
      } else if (t === "psk") {
        this.mixKeyAndHash(this.psk!);
      }
    }
    out.push(this.encryptAndHash(payload));
    this.step += 1;
    return concat(...out);
  }

  /**
   * Message 2: the Mac's, and its payload. Throws when it doesn't authenticate, or proves a key other than the pinned
   * one.
   */
  read(msg: Uint8Array): Uint8Array {
    if (this.step !== 1) throw new Error("It isn't the Mac's turn in the handshake.");
    let at = 0;
    const take = (n: number) => {
      if (at + n > msg.length) throw new Error("The Mac's handshake message is too short.");
      const part = msg.slice(at, at + n);
      at += n;
      return part;
    };
    for (const t of this.tokens[1]) {
      if (t === "e") {
        this.re = take(DH_LEN);
        this.mixHash(this.re);
        if (this.psk) this.mixKey(this.re);
      } else if (t === "ee") {
        this.mixKey(this.dh(this.e!.privateKey, this.re!));
      } else if (t === "s") {
        this.rs = this.decryptAndHash(take(DH_LEN + (this.cipher.hasKey() ? TAG_LEN : 0)));
        if (!equalBytes(this.rs, this.pinned)) throw new Error("This isn't the Mac you paired with.");
      } else if (t === "es") {
        this.mixKey(this.dh(this.e!.privateKey, this.rs!));
      }
    }
    const payload = this.decryptAndHash(msg.slice(at));
    this.step += 1;
    return payload;
  }

  /** The open channel's two ciphers: the phone sends with the first, reads with the second. */
  finish(): { send: CipherState; receive: CipherState } {
    if (this.step !== 3) throw new Error("The handshake isn't finished.");
    const [k1, k2] = hkdf(this.ck, EMPTY, 2);
    return { send: new CipherState(k1), receive: new CipherState(k2) };
  }
}
