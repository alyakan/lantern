/**
 * Keeping the phone connected to its Mac: pairing from a scanned code, finding the Mac again (Bonjour first, then the
 * addresses it gave when pairing), coming back after the link drops (with a growing pause, up to 30 seconds), and
 * saying where it stands for the UI.
 */
import { generateKeypair, keypairFrom, type Keypair } from "../noise/noise";
import { fromBase64Url, toBase64Url, type PairingOffer } from "../pairing";
import { MacKeyMismatch } from "../noise/noise";
import { comeIn, NoAnswer, ProtocolMismatch, Session, type Pushed, type Welcome } from "./session";
import type { Link, Transport } from "./transport";

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
/** How long a local address gets to answer: on its own network it takes milliseconds, and from anywhere else it never does. */
const OPEN_WAIT = 1500;
/** A Tailscale address gets longer: from cold its tunnel may take a few seconds to find a way through to the Mac. */
const TAILNET_WAIT = 6000;
const FIND_WAIT = 1500;

/** Tailscale's addresses (100.64.0.0/10): the ones that reach the Mac from anywhere, not only on its own network. */
export function isTailnetHost(host: string): boolean {
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  return m !== null && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

const openWait = (host: string) => (isTailnetHost(host) ? TAILNET_WAIT : OPEN_WAIT);

/** The most addresses kept for the Mac: a longer list would only be longer to walk through on every try. */
const MAX_HOSTS = 8;

/** A host the Mac told the phone to keep: an address or a name, nothing a URL could be made odd by. */
const plainHost = (h: unknown): h is string => typeof h === "string" && /^[A-Za-z0-9.-]{1,253}$/.test(h);

/**
 * The addresses to keep for the Mac: the one that just worked first (it may be one the Mac doesn't list, such as the
 * 10.0.2.2 an Android emulator reaches it at), then the Mac's own list when it gave one (an older Mac doesn't), else those
 * kept already. The first is what the next cold start dials first, so away from home it goes straight to Tailscale.
 */
export function savedHosts(worked: string, told: unknown, before: string[]): string[] {
  const list = Array.isArray(told) ? told.filter(plainHost) : [];
  return [worked, ...(list.length ? list : before).filter((h) => h !== worked)].slice(0, MAX_HOSTS);
}

/** Nothing answered at an address (or it answered too slowly). */
export class Unreachable extends Error {}

/** Whether the next address may be tried after this failure: this address wasn't the Mac, or didn't answer. */
const tryNext = (e: unknown) => e instanceof Unreachable || e instanceof NoAnswer || e instanceof MacKeyMismatch;

type Opened = { session: Session; host: string };

export class Connection {
  private session: Session | null = null;
  /** Bumped by every start, pair, stop and forget: a try that finds it changed leaves nothing behind. */
  private gen = 0;
  /** The run (see `gen`) the try-again loop belongs to, while one is going. */
  private loopGen: number | null = null;
  private tries = 0;
  /** The address the last connection came up on (see `candidates`). */
  private lastHost: string | null = null;
  private wakeUp: (() => void) | null = null;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly d: ConnectionDeps) {
    this.wait = d.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  current(): Session | null {
    return this.session;
  }

  /** Opens a link to one address and comes in over it; the link is closed when that fails. */
  private async open(host: string, port: number, device: Keypair, macKey: Uint8Array, secret?: Uint8Array) {
    let link: Link;
    try {
      link = await this.d.transport.open(host, port, openWait(host));
    } catch (e) {
      throw new Unreachable((e as Error).message);
    }
    try {
      const { channel, welcome } = await comeIn(link, device, macKey, { secret, deviceName: this.d.deviceName, appVersion: this.d.appVersion, fixedEphemeral: this.d.fixedEphemeral });
      return { link, channel, welcome };
    } catch (e) {
      link.close();
      throw e;
    }
  }

  /**
   * Pairs with the Mac a scanned code names, and stays connected. Throws with why it couldn't, and a phone that was paired
   * before goes back to its Mac (a code that fails, from a link anyone can send, mustn't take the real Mac away).
   */
  async pair(offer: PairingOffer): Promise<void> {
    const my = ++this.gen;
    this.hangUp();
    try {
      await this.pairWith(offer, my);
    } catch (e) {
      if (my === this.gen) void this.start();
      throw e;
    }
  }

  private async pairWith(offer: PairingOffer, my: number): Promise<void> {
    const key = (this.d.newKey ?? generateKeypair)();
    const candidates = await this.candidates(toBase64Url(offer.macKey), offer.hosts, offer.port);
    if (candidates.length === 0) throw new Error("The code has no address for your Mac. Show a new one on your Mac, and check that Remote control is on.");
    // No "connecting" state here: the app swaps its screen for a connecting one, and the pairing screen (which says
    // "Pairing…" itself, and holds the error when this fails) would be unmounted underneath the attempt.
    let lastError: Error = new Error("Couldn't reach your Mac.");
    for (const [host, port] of candidates) {
      try {
        const { link, channel, welcome } = await this.open(host, port, key, offer.macKey, offer.secret);
        const session = new Session(link, channel, welcome, this.d.onPushed);
        if (my !== this.gen) {
          session.close();
          throw new Error("Pairing was cancelled.");
        }
        const hosts = savedHosts(host, welcome.hosts, offer.hosts);
        await this.d.store.save({ macKey: toBase64Url(offer.macKey), deviceKey: toBase64Url(key.privateKey), hosts, port: offer.port, macName: welcome.mac_name || offer.macName });
        this.up({ session, host });
        return;
      } catch (e) {
        lastError = e as Error;
        // Only a failure that says this address wasn't the Mac goes on to the next: anything else (the code was taken and
        // failed, the Mac speaks another protocol) would use up the code or won't change.
        if (!tryNext(e)) break;
      }
    }
    throw lastError;
  }

  /** Whether a try-again loop is running for the current run of things (an older one winding down doesn't count). */
  private get looping() {
    return this.loopGen !== null && this.loopGen === this.gen;
  }

  /** Connects to the paired Mac, and keeps at it until `stop`. Starting again while it is at it does nothing. */
  async start(): Promise<void> {
    if (this.looping || this.session) return;
    const my = ++this.gen;
    const paired = await this.d.store.load();
    if (my !== this.gen) return;
    if (!paired) return this.d.onState({ kind: "unpaired" });
    void this.loop(paired, my);
  }

  /** The app came back to the foreground: a phone's connections don't survive being away, so try again now. */
  resume() {
    if (this.session) return;
    if (this.looping) this.wakeUp?.();
    else void this.start();
  }

  /**
   * An address typed in for the Mac (its Tailscale one, say, when this phone never learned it): kept first and dialled at
   * once. Safe whatever is typed: only the paired Mac's key gets through the handshake. Resolves to why it was refused, or null.
   */
  async useAddress(text: string): Promise<string | null> {
    const host = text.trim();
    if (!plainHost(host)) return "That isn't an address. Type it like 100.90.157.106, without the port.";
    const paired = await this.d.store.load();
    if (!paired) return "Pair with your Mac first, then you can add an address.";
    await this.d.store.save({ ...paired, hosts: [host, ...paired.hosts.filter((h) => h !== host)].slice(0, MAX_HOSTS) });
    if (this.session) return null;
    // A fresh run: the one going holds the addresses it loaded when it started.
    this.stop();
    void this.start();
    return null;
  }

  stop() {
    this.gen++;
    this.hangUp();
  }

  /** Forgets the Mac (the user unpaired, or the Mac removed this phone). */
  async forget() {
    this.stop();
    await this.d.store.forget();
    this.d.onState({ kind: "unpaired" });
  }

  private hangUp() {
    this.session?.close();
    this.session = null;
  }

  private up({ session, host }: Opened) {
    this.hangUp();
    this.lastHost = host;
    this.session = session;
    this.tries = 0;
    this.d.onState({ kind: "connected", welcome: session.welcome, host });
    this.d.onSession?.(session);
    const my = this.gen;
    void session.done.then(() => {
      if (this.session !== session) return;
      this.session = null;
      if (my === this.gen) void this.start();
    });
  }

  private async candidates(macKey: string, hosts: string[], port: number): Promise<[string, number][]> {
    const found = await (this.d.discovery ?? noDiscovery).find(FIND_WAIT).catch(() => []);
    const mine = found.filter((f) => f.id === macId(macKey)).map((f): [string, number] => [f.host, f.port]);
    const all = [...mine, ...hosts.map((h): [string, number] => [h, port])];
    const unique = all.filter(([h, p], i) => all.findIndex(([h2, p2]) => h2 === h && p2 === p) === i);
    // The address that worked last time goes first: away from home that is Tailscale's, and the local ones that can't
    // answer there don't each take their wait before it.
    const last = unique.findIndex(([h]) => h === this.lastHost);
    return last > 0 ? [unique[last], ...unique.slice(0, last), ...unique.slice(last + 1)] : unique;
  }

  /** Waits `ms`, or less when the app comes back to the foreground. */
  private pause(ms: number) {
    return Promise.race([this.wait(ms), new Promise<void>((r) => (this.wakeUp = r))]);
  }

  private async loop(paired: PairedMac, my: number) {
    this.loopGen = my;
    try {
      while (my === this.gen && !this.session) {
        this.d.onState({ kind: "connecting" });
        const tried = await this.attempt(paired);
        if (my !== this.gen) {
          if (!(tried instanceof Error)) tried.session.close();
          return;
        }
        if (!(tried instanceof Error)) {
          this.up(tried);
          // After `up`, which is where a run that was stopped or forgotten meanwhile has been ruled out above.
          void this.keepHosts(paired, tried.host, tried.session.welcome.hosts);
          return;
        }
        if (tried instanceof ProtocolMismatch) return this.d.onState({ kind: "offline", reason: tried.message, retryInMs: null });
        const wait = BACKOFF_MS[Math.min(this.tries, BACKOFF_MS.length - 1)];
        this.tries += 1;
        this.d.onState({ kind: "offline", reason: tried.message, retryInMs: wait });
        await this.pause(wait);
      }
    } finally {
      // Only the loop of the current run lets go: an older one must not clear a newer one's.
      if (this.loopGen === my) {
        this.loopGen = null;
        this.wakeUp = null;
      }
    }
  }

  /**
   * Keeps the address that worked first and the addresses the Mac says it has now after it (see `savedHosts`), so a Mac
   * whose address changed, or that joined Tailscale after this phone paired, is still found. A save that fails costs only
   * the update: the connection is already open.
   */
  private async keepHosts(paired: PairedMac, worked: string, told: string[] | undefined) {
    const hosts = savedHosts(worked, told, paired.hosts);
    if (hosts.length === paired.hosts.length && hosts.every((h, i) => h === paired.hosts[i])) return;
    try {
      // Only if this is still the Mac that is kept: one forgotten or paired again meanwhile must not come back.
      const kept = await this.d.store.load();
      if (kept?.macKey === paired.macKey) await this.d.store.save({ ...kept, hosts });
    } catch {
      // The next connection will hear them again.
    }
  }

  /** One try at every place the Mac may be: a session once in, else why not. */
  private async attempt(paired: PairedMac): Promise<Opened | Error> {
    const candidates = await this.candidates(paired.macKey, paired.hosts, paired.port);
    if (candidates.length === 0) return new Error(`Can't find ${paired.macName}. Check that it's awake, and that Tailscale is on if you're away from home.`);
    // Nothing answered at all: said in words, not as a transport's error.
    let last: Error = new Error(`Can't reach ${paired.macName}. It may be asleep or offline. Away from home, check that Tailscale is on here and on the Mac, and that Remote control is on in Lantern.`);
    for (const [host, port] of candidates) {
      try {
        const { link, channel, welcome } = await this.open(host, port, keypairFrom(fromBase64Url(paired.deviceKey)), fromBase64Url(paired.macKey));
        return { session: new Session(link, channel, welcome, this.d.onPushed), host };
      } catch (e) {
        if (e instanceof ProtocolMismatch) return e;
        if (e instanceof MacKeyMismatch) last = new Error(`Something at ${host} answered as another Mac, so this phone didn't talk to it.`);
        else if (!(e instanceof Unreachable)) last = e as Error;
      }
    }
    return last;
  }
}
