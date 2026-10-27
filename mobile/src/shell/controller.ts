/**
 * The app's one object: the connection to the Mac and the sync of what it says, with where the connection stands for the
 * screens. Outside React so it is tested alone; the screens read it through hooks (hooks.ts).
 */
import { Connection, type ConnectionState, type Discovery, type MacStore } from "../net/connection";
import type { Transport } from "../net/transport";
import { keypairFrom } from "../noise/noise";
import { fromBase64Url, readPairingLink, toBase64Url, type PairingOffer } from "../pairing";
import { Sync, type SyncDeps } from "../sync/sync";
import { LiveCards, type CardFactory } from "../liveActivity";
import { forgetLastKnown } from "../lastKnown";
import { forgetUsageHistory } from "../usageHistory";

export interface ControllerDeps {
  transport: Transport;
  store: MacStore;
  discovery?: Discovery;
  deviceName: string;
  appVersion: string;
  now?: () => number;
  sync?: SyncDeps;
  /** The lock-screen card's native side (tests give a fake; the app's own is used when this is left out). */
  liveFactory?: () => CardFactory | null;
}

/** The Mac a pairing link names, as the confirmation says it. */
export interface Preview {
  macName: string;
  /** Where it will be dialed from the code (the first address; null when it has none). */
  host: string | null;
  offer: PairingOffer;
}

export class Controller {
  readonly sync: Sync;
  /** The card on the lock screen for the chat last messaged from this phone. */
  readonly liveCards: LiveCards;
  readonly connection: Connection;
  private state: ConnectionState = { kind: "connecting" };
  private listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly d: ControllerDeps) {
    this.now = d.now ?? Date.now;
    this.sync = new Sync(d.sync);
    this.liveCards = new LiveCards({ factory: d.liveFactory, tell: (state) => this.sync.liveActivity(state), now: d.now });
    this.sync.onSending = (id, slot, project) => void this.liveCards.begin(id, slot, project);
    this.sync.onSent = (id) => void this.liveCards.confirm(id);
    this.sync.onFailed = (id) => void this.liveCards.abandon(id);
    this.sync.onConnected = () => void this.liveCards.connected();
    this.connection = new Connection({
      transport: d.transport,
      store: d.store,
      discovery: d.discovery,
      deviceName: d.deviceName,
      appVersion: d.appVersion,
      onPushed: this.sync.onPushed,
      onSession: this.sync.onSession,
      onState: (s) => this.setConnection(s),
    });
  }

  /** Where the connection stands (the connection says so; the screens' tests do too). */
  setConnection(s: ConnectionState) {
    this.state = s;
    if (s.kind === "connected") void this.loadDeviceId();
    for (const l of this.listeners) l();
  }

  private device: string | null = null;

  /** This phone's id on the Mac's list (the Mac names it from this phone's key), once it is known. */
  getDeviceId = () => this.device;

  private async loadDeviceId() {
    const m = await this.d.store.load();
    if (!m) return;
    const id = `phone-${toBase64Url(keypairFrom(fromBase64Url(m.deviceKey)).publicKey).slice(0, 12)}`;
    if (id === this.device) return;
    this.device = id;
    for (const l of this.listeners) l();
  }

  getConnection = () => this.state;

  subscribeConnection = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  /** Connects to the paired Mac (or says there is none). */
  start() {
    return this.connection.start();
  }

  /** The app came back to the foreground. */
  resume() {
    this.connection.resume();
  }

  /** Dials an address typed in for the Mac, and keeps it. Resolves to why it was refused, or null. */
  useAddress(text: string) {
    return this.connection.useAddress(text);
  }

  /** What a scanned or pasted link would pair with, to confirm first; or why it can't. */
  preview(text: string): Preview | { error: string } {
    const offer = readPairingLink(text, this.now());
    if ("error" in offer) return offer;
    return { macName: offer.macName, host: offer.hosts[0] ?? null, offer };
  }

  /** Pairs with the Mac a link names. Resolves to why it didn't work, or null once it has. */
  async pair(text: string): Promise<string | null> {
    const p = this.preview(text);
    if ("error" in p) return p.error;
    try {
      await this.connection.pair(p.offer);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  /** Forgets the Mac: this phone is unpaired (the Mac still lists it until it is removed there). */
  async unpair() {
    await this.connection.forget();
    this.sync.reset();
    // What the offline screen remembers of that Mac's chats goes with it.
    void forgetLastKnown();
    void forgetUsageHistory();
  }
}
