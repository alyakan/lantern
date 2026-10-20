/**
 * A Mac for the phone's tests: it answers the phone's handshake with the message the real Mac's Noise (snow) recorded
 * for the same keys (src/protocol/generated/noise-vectors.json), then speaks the protocol through a real Channel. The
 * phone under test must use the case's keys and ephemeral (Connection's fixedEphemeral and newKey).
 */
import vectors from "../protocol/generated/noise-vectors.json";
import type { ClientMessage } from "../protocol/generated/ClientMessage";
import type { Request } from "../protocol/generated/Request";
import type { ServerMessage } from "../protocol/generated/ServerMessage";
import { Channel } from "../noise/channel";
import { Handshake, keypairFrom, type Keypair } from "../noise/noise";
import { queueLink, type Link, type Transport } from "../net/transport";

const bytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export type Case = (typeof vectors)[number];
export const pairCase = vectors.find((v) => v.psk)!;
export const connectCase = vectors.find((v) => !v.psk)!;

/** What the phone needs to replay a case: its key and ephemeral, and the Mac's key and the code's secret. */
export const phoneKeys = (c: Case) => ({ device: keypairFrom(bytes(c.phone_static)) as Keypair, ephemeral: bytes(c.phone_ephemeral), macKey: keypairFrom(bytes(c.mac_static)).publicKey, secret: c.psk ? bytes(c.psk) : null });

/** The Mac's side of the channel a case opens: the phone's two ciphers, swapped. */
function macChannel(c: Case): Channel {
  const k = phoneKeys(c);
  const hs = k.secret ? Handshake.pair(k.device, k.macKey, k.secret, k.ephemeral) : Handshake.connect(k.device, k.macKey, k.ephemeral);
  hs.write();
  hs.read(bytes(c.messages[1]));
  hs.write();
  const { send, receive } = hs.finish();
  return new Channel(receive, send);
}

export interface FakeMacOptions {
  /** Which addresses answer (others are unreachable). */
  reachable?: string[];
  protocol?: number;
  epoch?: number;
  macName?: string;
  /** The Mac's answer to a request; an Error is sent back as the request's error. */
  answer?: (req: Request) => unknown;
}

export class FakeMac implements Transport {
  /** Every request the phone made, in order. */
  readonly requests: Request[] = [];
  readonly hellos: Extract<ClientMessage, { type: "hello" }>[] = [];
  private live: { link: ReturnType<typeof queueLink>; channel: Channel | null }[] = [];
  opened: string[] = [];

  constructor(
    private readonly c: Case,
    private readonly o: FakeMacOptions = {},
  ) {}

  async open(host: string, port: number): Promise<Link> {
    this.opened.push(`${host}:${port}`);
    if (this.o.reachable && !this.o.reachable.includes(host)) throw new Error(`Couldn't reach ${host}.`);
    const conn: { link: ReturnType<typeof queueLink>; channel: Channel | null } = { link: null!, channel: null };
    let step = 0;
    const toPhone = (f: Uint8Array) => queueMicrotask(() => conn.link.push(f));
    conn.link = queueLink(
      (frame) => {
        step += 1;
        if (step === 1) return; // the mode byte
        if (step === 2) {
          if (hex(frame) !== this.c.messages[0]) return conn.link.end();
          return toPhone(bytes(this.c.messages[1]));
        }
        if (step === 3) {
          if (hex(frame) !== this.c.messages[2]) return conn.link.end();
          conn.channel = macChannel(this.c);
          return;
        }
        const plain = conn.channel!.open(frame);
        if (!plain) return;
        const msg = JSON.parse(new TextDecoder().decode(plain)) as ClientMessage;
        if (msg.type === "hello") {
          this.hellos.push(msg);
          this.sendOn(conn, { type: "welcome", protocol: this.o.protocol ?? 1, app_version: "test", mac_name: this.o.macName ?? "Test Mac", epoch: this.o.epoch ?? 7 });
        } else {
          this.requests.push(msg.request);
          let ok: unknown = null;
          let error: string | null = null;
          try {
            ok = this.o.answer?.(msg.request) ?? null;
          } catch (e) {
            error = (e as Error).message;
          }
          this.sendOn(conn, { type: "response", id: msg.id, ok, error });
        }
      },
      () => {},
    );
    this.live.push(conn);
    return conn.link.link;
  }

  private sendOn(conn: { link: ReturnType<typeof queueLink>; channel: Channel | null }, msg: ServerMessage) {
    for (const f of conn.channel!.seal(new TextEncoder().encode(JSON.stringify(msg)))) queueMicrotask(() => conn.link.push(f));
  }

  /** Sends a message to the phone on the newest connection. */
  push(msg: ServerMessage) {
    const conn = this.live[this.live.length - 1];
    if (conn?.channel) this.sendOn(conn, msg);
  }

  /** Drops every connection, as a Mac going to sleep would. */
  dropAll() {
    for (const c of this.live) c.link.end();
    this.live = [];
  }
}
