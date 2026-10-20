/**
 * Keeping the phone connected to its Mac: pairing from a scanned code, finding the Mac again (Bonjour first, then the
 * addresses it gave when pairing), coming back after the link drops (with a growing pause, up to 30 seconds), and
 * saying where it stands for the UI.
 */
import { generateKeypair, keypairFrom, type Keypair } from "../noise/noise";
import { fromBase64Url, toBase64Url, type PairingOffer } from "../pairing";
import { comeIn, ProtocolMismatch, Session, type Pushed, type Welcome } from "./session";
import type { Transport } from "./transport";

/** The Mac this phone is paired with, as kept (its own key in the Keychain or Keystore, see storage). */
export interface PairedMac {
  macKey: string;
  deviceKey: string;
  hosts: string[];
  port: number;
  macName: string;
}

export interface MacStore {
  load(): Promise<PairedMac | null>;
  save(mac: PairedMac): Promise<void>;
  forget(): Promise<void>;
}

/** A Mac Bonjour found: where, and the id it says (the start of its key, which tells this phone's Mac from another). */
export interface Found {
  host: string;
  port: number;
  id: string;
}

export interface Discovery {
  find(waitMs: number): Promise<Found[]>;
}

export const noDiscovery: Discovery = { find: async () => [] };

/** The id a Mac's Bonjour record carries (the Mac's start_remote: the first 10 characters of its key). */
export const macId = (macKey: string) => macKey.slice(0, 10);

export type ConnectionState =
  | { kind: "unpaired" }
  | { kind: "connecting" }
  | { kind: "connected"; welcome: Welcome; host: string }
  | { kind: "offline"; reason: string; retryInMs: number | null };

export interface ConnectionDeps {
  transport: Transport;
  store: MacStore;
  discovery?: Discovery;
  deviceName: string;
  appVersion: string;
  onPushed: (msg: Pushed) => void;
  onState: (s: ConnectionState) => void;
  /** A connection came up (the sync store subscribes again from where it was). */
  onSession?: (s: Session) => void;
  wait?: (ms: number) => Promise<void>;
  newKey?: () => Keypair;
  /** Tests only: replays a recorded handshake. */
  fixedEphemeral?: Uint8Array;
}

/** The pauses between tries after the link drops. */
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const OPEN_WAIT = 3000;
const FIND_WAIT = 1500;

export class Connection {
  private session: Session | null = null;
  private stopped = false;
  private tries = 0;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly d: ConnectionDeps) {
    this.wait = d.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  current(): Session | null {
    return this.session;
  }

  /** Pairs with the Mac a scanned code names, and stays connected. Throws with why it couldn't. */
  async pair(offer: PairingOffer): Promise<void> {
    this.stopped = false;
    const key = (this.d.newKey ?? generateKeypair)();
    const candidates = await this.candidates(toBase64Url(offer.macKey), offer.hosts, offer.port);
    if (candidates.length === 0) throw new Error("Your Mac isn't on this Wi-Fi.");
    this.d.onState({ kind: "connecting" });
    let lastError: Error = new Error("Couldn't reach your Mac.");
    for (const [host, port] of candidates) {
      try {
        const link = await this.d.transport.open(host, port, OPEN_WAIT);
        const { channel, welcome } = await comeIn(link, key, offer.macKey, { secret: offer.secret, deviceName: this.d.deviceName, appVersion: this.d.appVersion, fixedEphemeral: this.d.fixedEphemeral });
        await this.d.store.save({ macKey: toBase64Url(offer.macKey), deviceKey: toBase64Url(key.privateKey), hosts: offer.hosts, port: offer.port, macName: welcome.mac_name || offer.macName });
        this.up(new Session(link, channel, welcome, this.d.onPushed), host);
        return;
      } catch (e) {
        lastError = e as Error;
        // A code is used up by one try: another address won't take it either.
        if (!(e instanceof Error && /didn't answer|Couldn't reach/.test(e.message))) break;
      }
    }
    this.d.onState({ kind: "offline", reason: lastError.message, retryInMs: null });
    throw lastError;
  }

  /** Connects to the paired Mac, and keeps at it until `stop`. */
  async start(): Promise<void> {
    this.stopped = false;
    const paired = await this.d.store.load();
    if (!paired) return this.d.onState({ kind: "unpaired" });
    void this.loop(paired);
  }

  stop() {
    this.stopped = true;
    this.session?.close();
    this.session = null;
  }

  /** Forgets the Mac (the user unpaired, or the Mac removed this phone). */
  async forget() {
    this.stop();
    await this.d.store.forget();
    this.d.onState({ kind: "unpaired" });
  }

  private up(session: Session, host: string) {
    this.session = session;
    this.tries = 0;
    this.d.onState({ kind: "connected", welcome: session.welcome, host });
    this.d.onSession?.(session);
    void session.done.then(async () => {
      if (this.session !== session) return;
      this.session = null;
      if (this.stopped) return;
      const paired = await this.d.store.load();
      if (paired) void this.loop(paired);
    });
  }

  private async candidates(macKey: string, hosts: string[], port: number): Promise<[string, number][]> {
    const found = await (this.d.discovery ?? noDiscovery).find(FIND_WAIT).catch(() => []);
    const mine = found.filter((f) => f.id === macId(macKey)).map((f): [string, number] => [f.host, f.port]);
    const all = [...mine, ...hosts.map((h): [string, number] => [h, port])];
    return all.filter(([h, p], i) => all.findIndex(([h2, p2]) => h2 === h && p2 === p) === i);
  }

  private async loop(paired: PairedMac) {
    while (!this.stopped && !this.session) {
      this.d.onState({ kind: "connecting" });
      const reason = await this.attempt(paired);
      if (reason === null || this.stopped) return;
      if (reason instanceof ProtocolMismatch) return this.d.onState({ kind: "offline", reason: reason.message, retryInMs: null });
      const pause = BACKOFF_MS[Math.min(this.tries, BACKOFF_MS.length - 1)];
      this.tries += 1;
      this.d.onState({ kind: "offline", reason: reason.message, retryInMs: pause });
      await this.wait(pause);
    }
  }

  /** One try at every place the Mac may be: null once in, else why not. */
  private async attempt(paired: PairedMac): Promise<Error | null> {
    const candidates = await this.candidates(paired.macKey, paired.hosts, paired.port);
    if (candidates.length === 0) return new Error(`Can't find ${paired.macName}. Check that it's awake and on the same Wi-Fi.`);
    // Nothing answered at all: said in words, not as a transport's error.
    let last: Error = new Error(`Can't reach ${paired.macName}. Check that it's awake, on the same Wi-Fi as this phone, and that Remote control is on in Lantern.`);
    for (const [host, port] of candidates) {
      let link;
      try {
        link = await this.d.transport.open(host, port, OPEN_WAIT);
      } catch {
        continue;
      }
      try {
        const { channel, welcome } = await comeIn(link, keypairFrom(fromBase64Url(paired.deviceKey)), fromBase64Url(paired.macKey), { deviceName: this.d.deviceName, appVersion: this.d.appVersion, fixedEphemeral: this.d.fixedEphemeral });
        this.up(new Session(link, channel, welcome, this.d.onPushed), host);
        return null;
      } catch (e) {
        if (e instanceof ProtocolMismatch) return e;
        last = e as Error;
      }
    }
    return last;
  }
}
