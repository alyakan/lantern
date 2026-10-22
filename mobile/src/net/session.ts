/**
 * Talking to a Mac once a transport link is open: the handshake and hello (see the Mac's gateway.rs), then requests
 * matched to their answers by id, and everything else the Mac sends (events, resets, the chat list) handed on.
 */
import type { ClientMessage } from "../protocol/generated/ClientMessage";
import type { Request } from "../protocol/generated/Request";
import type { ServerMessage } from "../protocol/generated/ServerMessage";
import { Channel } from "../noise/channel";
import { CONNECT, Handshake, PAIR, type Keypair } from "../noise/noise";
import { utf8Decode, utf8Encode } from "../platform/utf8";
import type { Link } from "./transport";

export const PROTOCOL_VERSION = 1;
/** How long the Mac has for each step of the handshake, and for each answer. */
export const STEP_WAIT = 10_000;
export const ANSWER_WAIT = 15_000;

export type Welcome = Extract<ServerMessage, { type: "welcome" }>;

/** The Mac speaks another version of the protocol: which side needs updating. */
export class ProtocolMismatch extends Error {
  constructor(readonly theirs: number) {
    super(theirs > PROTOCOL_VERSION ? "Your Mac's Lantern is newer than this app. Update the app." : "Your Mac's Lantern is older than this app. Update Lantern on your Mac.");
  }
}

/** The Mac closed the link, or went quiet, during the handshake. */
export class NoAnswer extends Error {}

/** The Mac hung up on the pairing code: it was used, expired or wrong, which another address of the Mac won't change. */
export class Refused extends Error {}

function sendMessage(link: Link, channel: Channel, msg: ClientMessage) {
  for (const frame of channel.seal(utf8Encode(JSON.stringify(msg)))) link.send(frame);
}

/** The Mac's next whole message (null: the link closed or went quiet for `waitMs`). */
async function nextMessage(link: Link, channel: Channel, waitMs?: number): Promise<ServerMessage | null> {
  for (;;) {
    const frame = await link.next(waitMs);
    if (!frame) return null;
    const plain = channel.open(frame);
    if (plain) return JSON.parse(utf8Decode(plain)) as ServerMessage;
  }
}

const NOT_TAKEN = "Your Mac didn't take this code. Show a new one on your Mac and try again.";

export interface HandshakeOptions {
  /** Pairing: the QR code's secret. Connecting again: none. */
  secret?: Uint8Array;
  deviceName: string;
  appVersion: string;
  /** Tests only: the ephemeral key, to replay a recorded handshake. */
  fixedEphemeral?: Uint8Array;
}

/** What this app can read beyond protocol 1, said in its hello: a Mac sends it nothing it doesn't list ("extras": commands, plan, usage). */
export const PHONE_FEATURES = ["extras"];

/** Runs the handshake over `link` and says hello: the open channel and the Mac's welcome. Throws on any failure. */
export async function comeIn(link: Link, device: Keypair, macKey: Uint8Array, o: HandshakeOptions): Promise<{ channel: Channel; welcome: Welcome }> {
  const hs = o.secret ? Handshake.pair(device, macKey, o.secret, o.fixedEphemeral ?? null) : Handshake.connect(device, macKey, o.fixedEphemeral ?? null);
  link.send(Uint8Array.of(o.secret ? PAIR : CONNECT));
  link.send(hs.write());
  const second = await link.next(STEP_WAIT);
  // A Mac with no code on screen (or one already used) closes right away; one that is asleep says nothing.
  if (!second) {
    if (o.secret) throw new (link.isClosed ? Refused : NoAnswer)(NOT_TAKEN);
    throw new NoAnswer("Your Mac didn't answer.");
  }
  hs.read(second);
  link.send(hs.write());
  const { send, receive } = hs.finish();
  const channel = new Channel(send, receive);
  sendMessage(link, channel, { type: "hello", protocol: PROTOCOL_VERSION, app_version: o.appVersion, device_name: o.deviceName, features: PHONE_FEATURES });
  const welcome = await nextMessage(link, channel, STEP_WAIT);
  if (!welcome || welcome.type !== "welcome") {
    if (o.secret) throw new (link.isClosed ? Refused : NoAnswer)(NOT_TAKEN);
    throw new NoAnswer("Your Mac didn't let this phone in. Pair it again.");
  }
  if (welcome.protocol !== PROTOCOL_VERSION) throw new ProtocolMismatch(welcome.protocol);
  return { channel, welcome };
}

/** A Mac's message that isn't an answer: events, resets and the chat list. */
export type Pushed = Exclude<ServerMessage, { type: "response" } | { type: "welcome" }>;

/** An open connection: ask the Mac things, and hear what it pushes. */
export class Session {
  private nextId = 1;
  private answers = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly done: Promise<void>;
  private closed = false;

  constructor(
    private readonly link: Link,
    private readonly channel: Channel,
    readonly welcome: Welcome,
    private readonly onPushed: (msg: Pushed) => void,
  ) {
    this.done = this.read();
  }

  /** Asks the Mac; resolves to its answer, rejects with its error (in words for the user). */
  ask<T = unknown>(request: Request): Promise<T> {
    // A connection that is gone answers at once, not after the wait for an answer that can't come.
    if (this.closed) return Promise.reject(new Error("The connection to your Mac closed."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.answers.delete(id);
        reject(new Error("Your Mac didn't answer in time."));
      }, ANSWER_WAIT);
      this.answers.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        sendMessage(this.link, this.channel, { type: "request", id, request });
      } catch (e) {
        clearTimeout(timer);
        this.answers.delete(id);
        reject(e as Error);
      }
    });
  }

  close() {
    this.link.close();
  }

  private async read() {
    try {
      for (;;) {
        const msg = await nextMessage(this.link, this.channel);
        if (!msg) break;
        if (msg.type === "response") {
          const waiting = this.answers.get(msg.id);
          if (!waiting) continue;
          this.answers.delete(msg.id);
          clearTimeout(waiting.timer);
          if (msg.error) waiting.reject(new Error(msg.error));
          else waiting.resolve(msg.ok ?? null);
        } else if (msg.type !== "welcome") {
          this.onPushed(msg);
        }
      }
    } catch {
      // A frame that didn't open: the channel is closed, and so is the link.
    } finally {
      this.closed = true;
      this.link.close();
      for (const [, w] of this.answers) {
        clearTimeout(w.timer);
        w.reject(new Error("The connection to your Mac closed."));
      }
      this.answers.clear();
    }
  }
}
