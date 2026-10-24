import { Platform } from "react-native";
import type { RemoteLiveCard } from "./protocol/generated/RemoteLiveCard";

/** What the card says (the layout reads it, and the Mac sends the same: see widgets/lanternChat.tsx). */
export type CardProps = { project: string; status: "working" | "needs_you" | "done" | "failed"; since: number };

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
    });
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
