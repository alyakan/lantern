/**
 * An open channel to the Mac: whole messages in and out, each split into frames that fit a Noise message, with a flag
 * inside every encrypted frame (more to come, or the last), as the Mac's Channel does (secure.rs). After its first
 * error it refuses everything: the connection has to go.
 */
import type { CipherState } from "./noise";

const NOISE_MAX = 65535;
const CHUNK = NOISE_MAX - 16 - 1;
/** The biggest message either side takes. */
export const MAX_MESSAGE = 8 << 20;
const EMPTY = new Uint8Array(0);

export class Channel {
  private partial: Uint8Array[] = [];
  private partialLength = 0;
  private broken = false;

  constructor(
    private readonly sendCipher: CipherState,
    private readonly receiveCipher: CipherState,
  ) {}

  /** The frames that carry `plain`, to send in order. */
  seal(plain: Uint8Array): Uint8Array[] {
    if (this.broken) throw new Error("The secure channel is closed.");
    if (plain.length > MAX_MESSAGE) throw new Error("That message is too big to send.");
    const chunks: Uint8Array[] = [];
    for (let at = 0; at < plain.length; at += CHUNK) chunks.push(plain.subarray(at, at + CHUNK));
    if (chunks.length === 0) chunks.push(EMPTY);
    try {
      return chunks.map((chunk, i) => {
        const framed = new Uint8Array(chunk.length + 1);
        framed[0] = i === chunks.length - 1 ? 1 : 0;
        framed.set(chunk, 1);
        return this.sendCipher.encrypt(EMPTY, framed);
      });
    } catch (e) {
      this.broken = true;
      throw e;
    }
  }

  /** Reads a frame: the whole message once its last frame is in, null before. Throws (and closes) on a bad one. */
  open(frame: Uint8Array): Uint8Array | null {
    if (this.broken) throw new Error("The secure channel is closed.");
    try {
      if (frame.length > NOISE_MAX) throw new Error("A frame bigger than a Noise message.");
      const plain = this.receiveCipher.decrypt(EMPTY, frame);
      if (plain.length === 0) throw new Error("An empty frame.");
      const [flag, data] = [plain[0], plain.subarray(1)];
      if (this.partialLength + data.length > MAX_MESSAGE) throw new Error("The Mac sent a message that is too big.");
      if (flag !== 0 && flag !== 1) throw new Error("A frame with a bad flag.");
      this.partial.push(data);
      this.partialLength += data.length;
      if (flag === 0) return null;
      const out = new Uint8Array(this.partialLength);
      let at = 0;
      for (const p of this.partial) {
        out.set(p, at);
        at += p.length;
      }
      this.partial = [];
      this.partialLength = 0;
      return out;
    } catch (e) {
      this.broken = true;
      throw e;
    }
  }
}
