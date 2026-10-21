/**
 * Supporting development, all of it optional. Three one-time tips, and two ongoing pledges (monthly and yearly) whose
 * subscribers are "regulars" and get a warm accent (Ember) for the app. Everything else stays free for everyone. They are
 * bought through the App Store (or Google Play); nothing about the person is kept but the day of the last tip and whether
 * a pledge was running, on this phone. The store is behind the `TipPlatform` seam (platformTips.ts has the real one), so
 * this is tested alone.
 */

/** The three tips, smallest to largest. They are the product ids set up in App Store Connect and Play Console. */
export const TIP_IDS = ["com.alyakan.lantern.tip.small", "com.alyakan.lantern.tip.medium", "com.alyakan.lantern.tip.large"] as const;

/** The two pledges, monthly then yearly (one subscription group, "Support Lantern"). */
export const PLEDGE_IDS = ["com.alyakan.lantern.pledge.monthly", "com.alyakan.lantern.pledge.yearly"] as const;

/** What a tip row shows. */
export interface Tip {
  id: string;
  name: string;
  /** The price as the store writes it for this person ("$0.99", "0,99 €"). */
  price: string;
}

/** What a pledge row shows. */
export interface Pledge {
  id: string;
  name: string;
  /** The price and how often, as the store writes the price for this person ("$1.99/mo", "$19.99/yr"). */
  price: string;
  per: "month" | "year";
}

/** What a purchase came to: "thanked" once it went through, "cancelled" if the person backed out, "pending" when it awaits an approval (Ask to Buy). */
export type Outcome = "thanked" | "cancelled" | "pending";

/** The store, as the tip jar needs it. */
export interface TipPlatform {
  /** The tips the store knows (an id it doesn't know is left out), cheapest first. Rejects when the store can't be reached. */
  products: (ids: readonly string[]) => Promise<Tip[]>;
  /** Buys one tip. Rejects with why when it failed. */
  buy: (id: string) => Promise<Outcome>;
  /** The pledges the store knows, monthly first. */
  pledges: (ids: readonly string[]) => Promise<Pledge[]>;
  /** Starts a pledge. Rejects with why when it failed. */
  subscribe: (id: string) => Promise<Outcome>;
  /** Whether a pledge is running now, by the store's word (rejects when it can't say). */
  isPledger: () => Promise<boolean>;
  /** Opens the store's own page to change or cancel a pledge. */
  manage: () => Promise<void>;
  /** Calls `changed` when a purchase finishes with nobody waiting on it (an approval that came late, a renewal); returns how to stop. */
  watch?: (changed: () => void) => () => void;
}

/** What is kept between runs. */
export interface TipMemory {
  /** The last tip given from this phone (ms), or null. */
  load: () => Promise<number | null>;
  save: (at: number) => Promise<void>;
  /** Whether a pledge was running when last known (null: never known). */
  loadPledger: () => Promise<boolean | null>;
  savePledger: (on: boolean) => Promise<void>;
}

export type TipPhase = "loading" | "ready" | "purchasing" | "thanked" | "failed" | "unavailable";

export interface TipState {
  phase: TipPhase;
  tips: Tip[];
  pledges: Pledge[];
  /** Why it is unavailable or failed, in words for the person. */
  error: string | null;
  /** The last tip given from this phone (ms), or null. */
  lastTipAt: number | null;
  /** Whether a pledge is running: this person is a regular. */
  pledger: boolean;
  /** What the last thank-you was for. */
  thanksFor: "tip" | "pledge" | null;
  /** Something bought but waiting for someone's approval. */
  awaitingApproval: boolean;
}

const FAILED = "That didn't go through. Nothing was charged. Try again in a bit?";
const UNAVAILABLE = "Tips aren't available right now. Check your connection and try again.";

/** A store's name for a product without the app's name it is sometimes given in brackets ("Small Coffee (Lantern)"). */
export const cleanName = (title: string) => title.replace(/\s*\([^)]*\)\s*$/, "").trim() || title;

/** Whether a time is in the same calendar month as another. */
export const sameMonth = (a: number, b: number) => {
  const [x, y] = [new Date(a), new Date(b)];
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth();
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TipJar {
  private state: TipState = { phase: "loading", tips: [], pledges: [], error: null, lastTipAt: null, pledger: false, thanksFor: null, awaitingApproval: false };
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;

  constructor(
    private readonly platform: TipPlatform,
    private readonly memory: TipMemory,
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {
    // Remembered from the last run, so "thank you" and the accent show before the store has answered.
    void memory.load().then((at) => at !== null && this.set({ lastTipAt: at }), () => {});
    void memory.loadPledger().then((on) => on !== null && this.set({ pledger: on }), () => {});
    // A purchase that finishes with nobody waiting (an approval, a renewal) may change whether this is a regular.
    platform.watch?.(() => void this.refreshPledger());
  }

  getState = () => this.state;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<TipState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** Whether a tip was given this calendar month. */
  hasTippedThisMonth = () => this.state.lastTipAt !== null && sameMonth(this.state.lastTipAt, this.now());

  private setPledger(on: boolean) {
    if (this.state.pledger === on) return;
    this.set({ pledger: on });
    void this.memory.savePledger(on).catch(() => {});
  }

  /**
   * Asks the store whether a pledge is running. Its list of what is running is eventually consistent (it can say "nothing"
   * for a moment), so one empty answer never takes a regular's accent away: it is asked once more after a second. An answer
   * it can't give leaves what was known.
   */
  async refreshPledger(): Promise<void> {
    const ask = () => this.platform.isPledger().catch(() => this.state.pledger);
    let active = await ask();
    if (!active && this.state.pledger) {
      await this.wait(1000);
      active = await ask();
    }
    this.setPledger(active);
  }

  /** Asks the store for the tips and pledges (once at a time; again after a failure, or when there are none). */
  load(): Promise<void> {
    if (this.state.tips.length > 0 || this.state.pledges.length > 0) return Promise.resolve();
    if (this.loading) return this.loading;
    this.set({ phase: "loading", error: null });
    const run = async () => {
      // The pledges are an extra: the tips are what the sheet cannot do without, but either is enough to show.
      const [tips, pledges] = await Promise.all([this.platform.products(TIP_IDS).catch(() => [] as Tip[]), this.platform.pledges(PLEDGE_IDS).catch(() => [] as Pledge[])]);
      this.loading = null;
      if (tips.length === 0 && pledges.length === 0) this.set({ phase: "unavailable", error: UNAVAILABLE });
      else this.set({ phase: "ready", tips, pledges, error: null });
      void this.refreshPledger();
    };
    this.loading = run();
    return this.loading;
  }

  private async buyWith(outcome: () => Promise<Outcome>, onThanks: (at: number) => Partial<TipState>, thanksFor: "tip" | "pledge") {
    if (this.state.phase === "purchasing") return;
    this.set({ phase: "purchasing", error: null });
    try {
      const result = await outcome();
      if (result === "thanked") this.set({ phase: "thanked", thanksFor, awaitingApproval: false, ...onThanks(this.now()) });
      else if (result === "pending") this.set({ phase: "ready", awaitingApproval: true });
      else this.set({ phase: "ready" });
    } catch {
      this.set({ phase: "failed", error: FAILED });
    }
  }

  /** Buys a tip. Only one thing at a time; the person backing out leaves everything as it was. */
  tip(id: string): Promise<void> {
    return this.buyWith(
      () => this.platform.buy(id),
      (at) => {
        void this.memory.save(at).catch(() => {});
        return { lastTipAt: at };
      },
      "tip",
    );
  }

  /** Starts a pledge. The purchase just verified is trusted: the store's list of what runs may not show it yet. */
  pledge(id: string): Promise<void> {
    return this.buyWith(
      () => this.platform.subscribe(id),
      () => {
        void this.memory.savePledger(true).catch(() => {});
        return { pledger: true };
      },
      "pledge",
    );
  }

  /** Opens the store's page to change or cancel a pledge; the answer is looked at again when the person is back. */
  async manage(): Promise<void> {
    await this.platform.manage().catch(() => {});
    void this.refreshPledger();
  }

  /** The thank-you has been seen: back to the list. */
  acknowledge() {
    if (this.state.phase === "thanked" || this.state.phase === "failed") {
      const has = this.state.tips.length > 0 || this.state.pledges.length > 0;
      this.set({ phase: has ? "ready" : "loading", error: null, thanksFor: null });
    }
  }
}

/** A store that isn't one: made-up tips and pledges, and every purchase "goes through" after a moment. For trying the screens out on a phone or simulator with no store set up (EXPO_PUBLIC_FAKE_TIPS=1). */
export function demoPlatform(): TipPlatform {
  let pledger = false;
  return {
    products: async () => [
      { id: TIP_IDS[0], name: "Small Coffee", price: "$0.99" },
      { id: TIP_IDS[1], name: "Large Coffee", price: "$2.99" },
      { id: TIP_IDS[2], name: "Generous Support", price: "$9.99" },
    ],
    buy: () => new Promise((resolve) => setTimeout(() => resolve("thanked"), 700)),
    pledges: async () => [
      { id: PLEDGE_IDS[0], name: "Monthly pledge", price: "$1.99/mo", per: "month" },
      { id: PLEDGE_IDS[1], name: "Yearly pledge", price: "$19.99/yr", per: "year" },
    ],
    subscribe: () =>
      new Promise((resolve) =>
        setTimeout(() => {
          pledger = true;
          resolve("thanked");
        }, 700),
      ),
    isPledger: async () => pledger,
    manage: async () => {
      pledger = false;
    },
  };
}

/** A store with nothing in it: what the screens get where no real one was given (their tests). */
export const noPlatform: TipPlatform = {
  products: async () => [],
  buy: async () => "cancelled",
  pledges: async () => [],
  subscribe: async () => "cancelled",
  isPledger: async () => false,
  manage: async () => {},
};

/** A memory that keeps nothing. */
export const noMemory: TipMemory = { load: async () => null, save: async () => {}, loadPledger: async () => null, savePledger: async () => {} };
