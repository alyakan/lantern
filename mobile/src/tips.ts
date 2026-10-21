/**
 * The tip jar: an optional way to say thanks to the developer. Three one-time tips bought through the App Store (or Google
 * Play); nothing in the app is locked behind them and nothing about the person is kept but the day of the last tip, on this
 * phone. The store is behind the `TipPlatform` seam (platformTips.ts has the real one), so this is tested alone.
 */

/** The three tips, smallest to largest. They are the product ids set up in App Store Connect and Play Console. */
export const TIP_IDS = ["com.alyakan.lantern.tip.small", "com.alyakan.lantern.tip.medium", "com.alyakan.lantern.tip.large"] as const;

/** What a tip row shows. */
export interface Tip {
  id: string;
  name: string;
  /** The price as the store writes it for this person ("$0.99", "0,99 €"). */
  price: string;
}

/** The store, as the tip jar needs it. */
export interface TipPlatform {
  /** The tips the store knows (an id it doesn't know is left out), cheapest first. Rejects when the store can't be reached. */
  products: (ids: readonly string[]) => Promise<Tip[]>;
  /** Buys one: "thanked" once it went through, "cancelled" if the person backed out, "pending" when it awaits an approval (Ask to Buy). Rejects with why when it failed. */
  buy: (id: string) => Promise<"thanked" | "cancelled" | "pending">;
}

/** Where the day of the last tip is kept between runs. */
export interface TipMemory {
  load: () => Promise<number | null>;
  save: (at: number) => Promise<void>;
}

export type TipPhase = "loading" | "ready" | "purchasing" | "thanked" | "failed" | "unavailable";

export interface TipState {
  phase: TipPhase;
  tips: Tip[];
  /** Why it is unavailable or failed, in words for the person. */
  error: string | null;
  /** The last tip given from this phone (ms), or null. */
  lastTipAt: number | null;
  /** A tip bought but waiting for someone's approval. */
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

export class TipJar {
  private state: TipState = { phase: "loading", tips: [], error: null, lastTipAt: null, awaitingApproval: false };
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;

  constructor(
    private readonly platform: TipPlatform,
    private readonly memory: TipMemory,
    private readonly now: () => number = Date.now,
  ) {
    // Remembered from the last run, so "thank you" can show before the store has answered.
    void memory.load().then((at) => at !== null && this.set({ lastTipAt: at }), () => {});
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

  /** Asks the store for the tips (once at a time; again after a failure, or when the list is empty). */
  load(): Promise<void> {
    if (this.state.tips.length > 0) return Promise.resolve();
    if (this.loading) return this.loading;
    this.set({ phase: "loading", error: null });
    this.loading = this.platform.products(TIP_IDS).then(
      (tips) => {
        this.loading = null;
        this.set(tips.length > 0 ? { phase: "ready", tips, error: null } : { phase: "unavailable", error: UNAVAILABLE });
      },
      () => {
        this.loading = null;
        this.set({ phase: "unavailable", error: UNAVAILABLE });
      },
    );
    return this.loading;
  }

  /** Buys a tip. Only one at a time; the person backing out leaves everything as it was. */
  async tip(id: string): Promise<void> {
    if (this.state.phase === "purchasing") return;
    this.set({ phase: "purchasing", error: null });
    try {
      const outcome = await this.platform.buy(id);
      if (outcome === "thanked") {
        const at = this.now();
        this.set({ phase: "thanked", lastTipAt: at, awaitingApproval: false });
        void this.memory.save(at).catch(() => {});
      } else if (outcome === "pending") {
        this.set({ phase: "ready", awaitingApproval: true });
      } else {
        this.set({ phase: "ready" });
      }
    } catch {
      this.set({ phase: "failed", error: FAILED });
    }
  }

  /** The thank-you has been seen: back to the list. */
  acknowledge() {
    if (this.state.phase === "thanked" || this.state.phase === "failed") this.set({ phase: this.state.tips.length > 0 ? "ready" : "loading", error: null });
  }
}

/** A store that isn't one: three made-up tips, and every one "goes through" after a moment. For trying the screens out on a phone or simulator with no store set up (EXPO_PUBLIC_FAKE_TIPS=1), and for the first runs of a build. */
export const demoPlatform: TipPlatform = {
  products: async () => [
    { id: TIP_IDS[0], name: "Small Coffee", price: "$0.99" },
    { id: TIP_IDS[1], name: "Large Coffee", price: "$2.99" },
    { id: TIP_IDS[2], name: "Generous Support", price: "$9.99" },
  ],
  buy: () => new Promise((resolve) => setTimeout(() => resolve("thanked"), 700)),
};

/** A store with nothing in it: what the screens get where no real one was given (their tests). */
export const noPlatform: TipPlatform = {
  products: async () => [],
  buy: async () => "cancelled",
};
