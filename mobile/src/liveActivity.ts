import { Platform } from "react-native";
import type { RemoteLiveCard } from "./protocol/generated/RemoteLiveCard";

/** What the card says (the layout reads it, and the Mac sends the same: see widgets/lanternChat.tsx). */
export type CardProps = {
  project: string;
  status: "working" | "needs_you" | "done" | "failed";
  since: number;
  /** A summary card's chats (the Mac fills them in); its presence makes the card a summary. */
  chats?: { project: string; status: CardProps["status"]; title?: string; since?: number }[];
  counts?: { needs_you: number; working: number; done: number; failed: number };
};

/** One card on the lock screen, as expo-widgets gives it. */
export interface CardInstance {
  getId(): string;
  getPushToken(): Promise<string | null>;
  addPushTokenListener(listener: (event: { activityId: string; pushToken: string }) => void): { remove(): void };
  end(policy?: "default" | "immediate"): Promise<void>;
}

/** Starts cards of the one kind Lantern has (expo-widgets' LiveActivityFactory). */
export interface CardFactory {
  start(props: CardProps, url?: string, staleDate?: Date): CardInstance;
  /** The cards already on the lock screen (left by the app's last run). */
  getInstances?(): CardInstance[];
}

/** A summary card older than this is started afresh when it can be: iOS ends every card after about 8 hours. */
export const SUMMARY_RENEW_MS = 7.5 * 60 * 60 * 1000;

/** What decides whether a summary card should be up, as the phone sees it now. */
export interface World {
  /** The Mac keeps summary cards (it lists "livesummary"). */
  summary: boolean;
  connected: boolean;
  /** The app is in front: iOS lets it start a card only then. */
  foreground: boolean;
  /** A chat is working or needs you. */
  busy: boolean;
}

interface SummaryCard {
  instance: CardInstance;
  token: string | null;
  since: number;
  /** Nothing was working or waiting the last time the phone looked: the Mac has ended it, or will. */
  over: boolean;
  reported: boolean;
  listener: { remove(): void } | null;
}

/** How long a card may go without an update before the phone calls it stale (the Mac pushes again well before this). */
export const STALE_MS = 25 * 60 * 1000;

/** The link a tap on the card opens: the chat, as the app's own scheme says it. */
export const chatLink = (slot: string) => `lantern://chat/${encodeURIComponent(slot)}`;

/** The chat a link names (a tap on the card), or null for any other link. */
export function slotOfLink(url: string | null | undefined): string | null {
  const m = /^lantern:\/\/chat\/([^/?#]{1,64})\/?$/i.exec(url ?? "");
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/**
 * The card's layout and the native side behind it, which only an iPhone has: loaded when first wanted, so Android and the
 * tests never touch it. Null when it isn't there (an older build, a platform without Live Activities).
 */
export function nativeFactory(): CardFactory | null {
  if (Platform.OS !== "ios") return null;
  try {
    return (require("./widgets/lanternChat") as { default: CardFactory }).default;
  } catch {
    return null;
  }
}

export interface LiveCardsDeps {
  factory?: () => CardFactory | null;
  /** Tells the Mac what the phone shows (only called when there is something to say). */
  tell: (state: { card: RemoteLiveCard | null }) => Promise<unknown>;
  now?: () => number;
}

interface Current {
  /** The message that started it (the phone's own id for it). */
  id: string;
  slot: string;
  project: string;
  since: number;
  instance: CardInstance;
  token: string | null;
  /** The Mac took the message: only then is it told of the card (a chat it hasn't heard of yet looks idle, and so finished). */
  confirmed: boolean;
  /** The Mac has been told of this card. */
  reported: boolean;
  listener: { remove(): void } | null;
}

/**
 * The card on the lock screen for the chat the user last messaged from this phone. Sending a message starts it at once (iOS
 * only lets an app start one while it is in front, and the phone may be locked a moment later), ending the one before; when the
 * Mac has taken the message its token goes to the Mac, which keeps it right with pushes straight to Apple, whether this app is
 * running or not. A message the Mac didn't take takes its card back. Opening the chat on the phone clears it. Everything about
 * it is best effort: a card that can't start (Live Activities turned off for Lantern, an iPhone too old for them) is not a
 * reason to fail a message. Calls run one after another, so two quick sends can't both start a card and lose one.
 */
export class LiveCards {
  private current: Current | null = null;
  /** With a Mac that keeps them: the one card about every chat, in place of `current`. */
  private summaryCard: SummaryCard | null = null;
  /** The phone last saw a Mac that keeps summary cards: a message sent starts no card of its own. */
  private summaryMode = false;
  /** The cards left by the app's last run have been looked at. */
  private adopted = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly factory: () => CardFactory | null;
  private readonly now: () => number;

  constructor(private readonly d: LiveCardsDeps) {
    this.factory = d.factory ?? nativeFactory;
    this.now = d.now ?? Date.now;
  }

  /** The chat the card is for now, if there is one. */
  get slot(): string | null {
    return this.current?.slot ?? null;
  }

  private chain(f: () => Promise<void>): Promise<void> {
    const run = this.queue.then(f, f);
    this.queue = run.catch(() => {});
    return run;
  }

  /** A message `id` is being sent to chat `slot` (in the project `project`): its card replaces any other. */
  begin(id: string, slot: string, project: string | null): Promise<void> {
    return this.chain(async () => {
      // The summary card shows the chat working once the Mac says so.
      if (this.summaryMode) return;
      const factory = this.factory();
      if (!factory) return;
      await this.endCurrent();
      const since = this.now();
      const name = (project ?? "").trim() || "Lantern";
      let instance: CardInstance;
      try {
        instance = factory.start({ project: name, status: "working", since }, chatLink(slot), new Date(since + STALE_MS));
      } catch {
        return;
      }
      const current: Current = { id, slot, project: name, since, instance, token: null, confirmed: false, reported: false, listener: null };
      this.current = current;
      // The token comes when Apple has made it, and may change: the Mac is told each time (once it has the message).
      const take = (token: string | null) => {
        if (this.current !== current || !token || token === current.token) return;
        current.token = token;
        void this.report();
      };
      try {
        current.listener = instance.addPushTokenListener((e) => take(e.pushToken));
        take(await instance.getPushToken());
      } catch {
        // Without a token the Mac can't update the card: it shows what it started with.
      }
    });
  }

  /** The Mac took message `id`: it is told of the card now. */
  confirm(id: string): Promise<void> {
    return this.chain(async () => {
      if (this.current?.id !== id) return;
      this.current.confirmed = true;
      await this.report();
    });
  }

  /** The Mac didn't take message `id`: its card goes, and the Mac is told there is none if it had been told of one. */
  abandon(id: string): Promise<void> {
    return this.chain(async () => {
      const c = this.current;
      if (c?.id !== id) return;
      await this.endCurrent();
      if (c.reported) await this.d.tell({ card: null }).catch(() => {});
    });
  }

  /** The user opened chat `slot` on the phone: what the card was for has been seen. */
  opened(slot: string): Promise<void> {
    return this.chain(async () => {
      if (this.current?.slot !== slot) return;
      await this.endCurrent();
      await this.d.tell({ card: null }).catch(() => {});
    });
  }

  /** A connection to the Mac came up: it is told of the card again (it only knows what it was told while connected). */
  connected(): Promise<void> {
    return this.chain(async () => {
      await this.report();
      await this.reportSummary();
    });
  }

  /**
   * With a Mac that keeps summary cards: the one card about every chat. It is started while the app is in front, connected,
   * and some chat is working or needs you, and there is none (or the last one is over, or nearly as old as iOS lets one get);
   * from then on the Mac keeps it right, and ends it when nothing works or waits. The phone never ends it itself except to
   * start the next one. A card the app's last run left is taken over, not doubled.
   */
  look(world: World): Promise<void> {
    return this.chain(async () => {
      this.summaryMode = world.summary;
      if (!world.summary) return;
      const factory = this.factory();
      if (!factory) return;
      if (!this.adopted) {
        this.adopted = true;
        this.adopt(factory);
      }
      const card = this.summaryCard;
      if (card && !world.busy) {
        card.over = true;
        return;
      }
      if (!world.busy || !world.foreground || !world.connected) return;
      if (card && !card.over && this.now() - card.since < SUMMARY_RENEW_MS) return;
      await this.endSummary();
      // The old kind of card, from before this Mac kept summaries, goes too.
      await this.endCurrent();
      this.startSummary(factory);
      await this.waitForToken();
    });
  }

  private adopt(factory: CardFactory) {
    let left: CardInstance[] = [];
    try {
      left = factory.getInstances?.() ?? [];
    } catch {
      return;
    }
    const [keep, ...rest] = left;
    for (const extra of rest) void extra.end("immediate").catch(() => {});
    // Its age isn't known: it is taken as new, and the Mac (told its token again) goes on with it or ends it.
    if (keep) this.follow(keep, this.now());
  }

  private startSummary(factory: CardFactory) {
    const since = this.now();
    let instance: CardInstance;
    try {
      instance = factory.start({ project: "Lantern", status: "working", since, chats: [], counts: { needs_you: 0, working: 0, done: 0, failed: 0 } }, undefined, new Date(since + STALE_MS));
    } catch {
      return;
    }
    this.follow(instance, since);
  }

  private follow(instance: CardInstance, since: number) {
    const card: SummaryCard = { instance, token: null, since, over: false, reported: false, listener: null };
    this.summaryCard = card;
    const take = (token: string | null) => {
      if (this.summaryCard !== card || !token || token === card.token) return;
      card.token = token;
      void this.reportSummary();
    };
    try {
      card.listener = instance.addPushTokenListener((e) => take(e.pushToken));
    } catch {
      // Without a token the Mac can't update it: it shows what it started with.
    }
    this.pendingToken = instance
      .getPushToken()
      .then(take)
      .catch(() => {});
  }

  private pendingToken: Promise<void> = Promise.resolve();

  private waitForToken() {
    return this.pendingToken;
  }

  private async reportSummary(): Promise<void> {
    const c = this.summaryCard;
    if (!c?.token) return;
    c.reported = true;
    await this.d.tell({ card: { slot: "", token: c.token, project: "Lantern", since: c.since, summary: true } }).catch(() => {});
  }

  private async endSummary(): Promise<void> {
    const c = this.summaryCard;
    this.summaryCard = null;
    if (!c) return;
    c.listener?.remove();
    await c.instance.end("immediate").catch(() => {});
  }

  private async report(): Promise<void> {
    const c = this.current;
    if (!c?.token || !c.confirmed) return;
    c.reported = true;
    await this.d.tell({ card: { slot: c.slot, token: c.token, project: c.project, since: c.since } }).catch(() => {});
  }

  private async endCurrent(): Promise<void> {
    const c = this.current;
    this.current = null;
    if (!c) return;
    c.listener?.remove();
    await c.instance.end("immediate").catch(() => {});
  }
}
