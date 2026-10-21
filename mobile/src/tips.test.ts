import { cleanName, demoPlatform, noMemory, noPlatform, PLEDGE_IDS, sameMonth, STORE_TIMEOUT, TIP_IDS, TipJar, type Pledge, type Tip, type TipMemory, type TipPlatform } from "./tips";

const TIPS: Tip[] = [
  { id: TIP_IDS[0], name: "Small Coffee", price: "$0.99" },
  { id: TIP_IDS[1], name: "Large Coffee", price: "$2.99" },
  { id: TIP_IDS[2], name: "Generous Support", price: "$9.99" },
];

const PLEDGES: Pledge[] = [
  { id: PLEDGE_IDS[0], name: "Monthly pledge", price: "$1.99/mo", per: "month" },
  { id: PLEDGE_IDS[1], name: "Yearly pledge", price: "$19.99/yr", per: "year" },
];

/** A store the test steers: what it answers, and when. */
function fakeStore(over: Partial<TipPlatform> = {}) {
  const asked: string[] = [];
  const platform: TipPlatform = {
    ...noPlatform,
    products: jest.fn(async () => TIPS),
    buy: jest.fn(async (id: string) => {
      asked.push(id);
      return "thanked" as const;
    }),
    pledges: jest.fn(async () => PLEDGES),
    subscribe: jest.fn(async (id: string) => {
      asked.push(id);
      return "thanked" as const;
    }),
    ...over,
  };
  return { platform, asked };
}

function memory(initial: number | null = null, pledger: boolean | null = null) {
  const saved: number[] = [];
  const pledges: boolean[] = [];
  const m: TipMemory = {
    load: async () => initial,
    save: async (at) => void saved.push(at),
    loadPledger: async () => pledger,
    savePledger: async (on) => void pledges.push(on),
  };
  return { m, saved, pledges };
}

const NOW = new Date(2026, 9, 21, 12).getTime();
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
/** A jar whose "wait a second" doesn't. */
const jarOf = (platform: TipPlatform, m: TipMemory = memory().m) => new TipJar(platform, m, () => NOW, async () => {});

describe("the product ids", () => {
  it("are three tips, smallest first, and two pledges, monthly first, under the app's id", () => {
    expect(TIP_IDS).toEqual(["com.alyakan.lantern.tip.small", "com.alyakan.lantern.tip.medium", "com.alyakan.lantern.tip.large"]);
    expect(PLEDGE_IDS).toEqual(["com.alyakan.lantern.pledge.monthly", "com.alyakan.lantern.pledge.yearly"]);
  });
});

describe("a tip's name", () => {
  it("drops the app's name Google Play puts in brackets after it", () => {
    expect(cleanName("Small Coffee (Lantern)")).toBe("Small Coffee");
    expect(cleanName("Generous Support")).toBe("Generous Support");
    expect(cleanName("A (b) c (Lantern)")).toBe("A (b) c");
    expect(cleanName("(Only brackets)")).toBe("(Only brackets)");
  });
});

describe("the same month", () => {
  it("is the same year and month, not just the same month number", () => {
    expect(sameMonth(new Date(2026, 9, 1).getTime(), new Date(2026, 9, 31).getTime())).toBe(true);
    expect(sameMonth(new Date(2026, 9, 31).getTime(), new Date(2026, 10, 1).getTime())).toBe(false);
    expect(sameMonth(new Date(2025, 9, 21).getTime(), new Date(2026, 9, 21).getTime())).toBe(false);
  });
});

describe("the tip jar", () => {
  it("starts out loading, and has the tips and pledges once the store has answered", async () => {
    const { platform } = fakeStore();
    const jar = jarOf(platform);
    expect(jar.getState().phase).toBe("loading");
    await jar.load();
    expect(jar.getState()).toMatchObject({ phase: "ready", tips: TIPS, pledges: PLEDGES, error: null });
    expect(platform.products).toHaveBeenCalledWith(TIP_IDS);
    expect(platform.pledges).toHaveBeenCalledWith(PLEDGE_IDS);
  });

  it("asks the store once, however often it is asked to load, and not again once it has them", async () => {
    const { platform } = fakeStore();
    const jar = jarOf(platform);
    await Promise.all([jar.load(), jar.load()]);
    await jar.load();
    expect(platform.products).toHaveBeenCalledTimes(1);
    expect(platform.pledges).toHaveBeenCalledTimes(1);
  });

  it("is unavailable, saying so, when the store can't be reached, and asks again when told to", async () => {
    let up = false;
    const { platform } = fakeStore({ products: jest.fn(async () => (up ? TIPS : Promise.reject(new Error("offline")))), pledges: jest.fn(async () => (up ? PLEDGES : Promise.reject(new Error("offline")))) });
    const jar = jarOf(platform);
    await jar.load();
    expect(jar.getState()).toMatchObject({ phase: "unavailable", tips: [], pledges: [] });
    expect(jar.getState().error).toMatch(/aren't available right now/);
    up = true;
    await jar.load();
    expect(jar.getState()).toMatchObject({ phase: "ready", error: null });
  });

  it("is unavailable too when the store knows none of them", async () => {
    const jar = jarOf(fakeStore({ products: async () => [], pledges: async () => [] }).platform);
    await jar.load();
    expect(jar.getState().phase).toBe("unavailable");
  });

  it("shows the tips when only the pledges can't be had, and the pledges when only the tips can't", async () => {
    const noPledges = jarOf(fakeStore({ pledges: () => Promise.reject(new Error("no subscriptions")) }).platform);
    await noPledges.load();
    expect(noPledges.getState()).toMatchObject({ phase: "ready", tips: TIPS, pledges: [] });
    const noTips = jarOf(fakeStore({ products: () => Promise.reject(new Error("no products")) }).platform);
    await noTips.load();
    expect(noTips.getState()).toMatchObject({ phase: "ready", tips: [], pledges: PLEDGES });
  });

  it("buys the tip asked for, says thanks for it, and remembers the day", async () => {
    const { platform, asked } = fakeStore();
    const { m, saved } = memory();
    const jar = jarOf(platform, m);
    await jar.load();
    await jar.tip(TIP_IDS[1]);
    expect(asked).toEqual([TIP_IDS[1]]);
    expect(jar.getState()).toMatchObject({ phase: "thanked", thanksFor: "tip", lastTipAt: NOW, pledger: false });
    expect(saved).toEqual([NOW]);
    expect(jar.hasTippedThisMonth()).toBe(true);
  });

  it("goes back to the list once the thanks have been seen, with everything still there", async () => {
    const jar = jarOf(fakeStore().platform);
    await jar.load();
    await jar.tip(TIP_IDS[0]);
    jar.acknowledge();
    expect(jar.getState()).toMatchObject({ phase: "ready", tips: TIPS, pledges: PLEDGES, thanksFor: null });
  });

  it("leaves everything as it was when the person backs out", async () => {
    const { m, saved } = memory();
    const jar = jarOf(fakeStore({ buy: async () => "cancelled" }).platform, m);
    await jar.load();
    await jar.tip(TIP_IDS[0]);
    expect(jar.getState()).toMatchObject({ phase: "ready", lastTipAt: null, awaitingApproval: false });
    expect(saved).toEqual([]);
  });

  it("says a tip awaits approval (Ask to Buy), without thanking yet", async () => {
    const jar = jarOf(fakeStore({ buy: async () => "pending" }).platform);
    await jar.load();
    await jar.tip(TIP_IDS[0]);
    expect(jar.getState()).toMatchObject({ phase: "ready", awaitingApproval: true, lastTipAt: null });
  });

  it("says nothing was charged when the purchase failed, and can be tried again", async () => {
    let fail = true;
    const { platform } = fakeStore({ buy: jest.fn(async () => (fail ? Promise.reject(new Error("store error")) : ("thanked" as const))) });
    const jar = jarOf(platform);
    await jar.load();
    await jar.tip(TIP_IDS[0]);
    expect(jar.getState().phase).toBe("failed");
    expect(jar.getState().error).toMatch(/Nothing was charged/);
    expect(jar.getState().lastTipAt).toBeNull();
    fail = false;
    await jar.tip(TIP_IDS[0]);
    expect(jar.getState()).toMatchObject({ phase: "thanked", error: null });
  });

  it("buys one thing at a time, a tip or a pledge", async () => {
    let release: (v: "thanked") => void = () => {};
    const buy = jest.fn(() => new Promise<"thanked">((r) => (release = r)));
    const { platform } = fakeStore({ buy });
    const jar = jarOf(platform);
    await jar.load();
    const first = jar.tip(TIP_IDS[0]);
    expect(jar.getState().phase).toBe("purchasing");
    await jar.tip(TIP_IDS[1]);
    await jar.pledge(PLEDGE_IDS[0]);
    expect(buy).toHaveBeenCalledTimes(1);
    expect(platform.subscribe).not.toHaveBeenCalled();
    release("thanked");
    await first;
    expect(jar.getState().phase).toBe("thanked");
  });

  it("remembers the last tip from a run before, and says whether it was this month", async () => {
    const lastMonth = new Date(2026, 8, 30).getTime();
    const thisMonth = new Date(2026, 9, 2).getTime();
    const before = jarOf(fakeStore().platform, memory(lastMonth).m);
    await settle();
    expect(before.getState().lastTipAt).toBe(lastMonth);
    expect(before.hasTippedThisMonth()).toBe(false);
    const recent = jarOf(fakeStore().platform, memory(thisMonth).m);
    await settle();
    expect(recent.hasTippedThisMonth()).toBe(true);
  });

  it("is not stopped by a memory that can't be read or written", async () => {
    const broken: TipMemory = { load: async () => Promise.reject(new Error("keychain")), save: async () => Promise.reject(new Error("keychain")), loadPledger: async () => Promise.reject(new Error("keychain")), savePledger: async () => Promise.reject(new Error("keychain")) };
    const jar = jarOf(fakeStore().platform, broken);
    await jar.load();
    await jar.tip(TIP_IDS[0]);
    expect(jar.getState().phase).toBe("thanked");
    await jar.pledge(PLEDGE_IDS[0]);
    expect(jar.getState().pledger).toBe(true);
  });

  it("tells its listeners when anything changes, and stops when they go", async () => {
    const jar = jarOf(fakeStore().platform);
    const seen: string[] = [];
    const stop = jar.subscribe(() => seen.push(jar.getState().phase));
    await jar.load();
    stop();
    await jar.tip(TIP_IDS[0]);
    expect(seen[0]).toBe("loading");
    expect(seen).toContain("ready");
    expect(seen).not.toContain("thanked");
  });
});

describe("a store that does not answer", () => {
  it("says so in its own words, not that nothing was charged: a payment may still have gone through", async () => {
    const jar = jarOf(fakeStore({ buy: () => Promise.reject(new Error(STORE_TIMEOUT)) }).platform);
    await jar.load();
    await jar.tip(TIP_IDS[0]);
    expect(jar.getState().phase).toBe("failed");
    expect(jar.getState().error).toMatch(/taking a long time to answer/);
    expect(jar.getState().error).not.toMatch(/Nothing was charged/);
    const pledge = jarOf(fakeStore({ subscribe: () => Promise.reject(new Error(STORE_TIMEOUT)) }).platform);
    await pledge.load();
    await pledge.pledge(PLEDGE_IDS[0]);
    expect(pledge.getState().error).toMatch(/taking a long time to answer/);
  });
});

describe("restoring a pledge", () => {
  it("asks the store to bring it back, then looks at whether one is running", async () => {
    let running = false;
    const restore = jest.fn(async () => void (running = true));
    const jar = jarOf(fakeStore({ restore, isPledger: async () => running }).platform);
    await jar.restore();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(jar.getState().pledger).toBe(true);
  });

  it("is not stopped by a store that can't restore", async () => {
    const jar = jarOf(fakeStore({ restore: () => Promise.reject(new Error("no")), isPledger: async () => false }).platform);
    await expect(jar.restore()).resolves.toBeUndefined();
    expect(jar.getState().pledger).toBe(false);
  });
});

describe("pledges: becoming a regular", () => {
  it("starts a pledge, thanks for it, and is a regular at once (the store's own list may not show it yet)", async () => {
    const { platform, asked } = fakeStore({ isPledger: async () => false });
    const { m, pledges } = memory();
    const jar = jarOf(platform, m);
    await jar.load();
    await jar.pledge(PLEDGE_IDS[1]);
    expect(asked).toEqual([PLEDGE_IDS[1]]);
    expect(jar.getState()).toMatchObject({ phase: "thanked", thanksFor: "pledge", pledger: true });
    expect(pledges).toEqual([true]);
    // Not undone by the list that doesn't show it yet, on the look at it after loading.
    expect(jar.getState().lastTipAt).toBeNull();
  });

  it("is not a regular by giving a tip", async () => {
    const jar = jarOf(fakeStore().platform);
    await jar.load();
    await jar.tip(TIP_IDS[2]);
    expect(jar.getState().pledger).toBe(false);
  });

  it("leaves everything as it was when the person backs out of a pledge, and says it waits for an approval when it does", async () => {
    const cancelled = jarOf(fakeStore({ subscribe: async () => "cancelled" }).platform);
    await cancelled.load();
    await cancelled.pledge(PLEDGE_IDS[0]);
    expect(cancelled.getState()).toMatchObject({ phase: "ready", pledger: false });
    const pending = jarOf(fakeStore({ subscribe: async () => "pending" }).platform);
    await pending.load();
    await pending.pledge(PLEDGE_IDS[0]);
    expect(pending.getState()).toMatchObject({ phase: "ready", pledger: false, awaitingApproval: true });
  });

  it("says nothing was charged when a pledge failed", async () => {
    const jar = jarOf(fakeStore({ subscribe: () => Promise.reject(new Error("store")) }).platform);
    await jar.load();
    await jar.pledge(PLEDGE_IDS[0]);
    expect(jar.getState()).toMatchObject({ phase: "failed", pledger: false });
    expect(jar.getState().error).toMatch(/Nothing was charged/);
  });

  it("is a regular when the store says a pledge is running, once it has loaded, and remembers that", async () => {
    const { m, pledges } = memory();
    const jar = jarOf(fakeStore({ isPledger: async () => true }).platform, m);
    await jar.load();
    await settle();
    expect(jar.getState().pledger).toBe(true);
    expect(pledges).toEqual([true]);
  });

  it("is a regular from the first moment of a run when it was one at the last", async () => {
    const jar = jarOf(fakeStore({ isPledger: () => new Promise<boolean>(() => {}) }).platform, memory(null, true).m);
    await settle();
    expect(jar.getState().pledger).toBe(true);
  });

  it("is not stopped being a regular by one empty answer: the store is asked again after a second", async () => {
    let answers = [false, true];
    const isPledger = jest.fn(async () => answers.shift() ?? true);
    const waits: number[] = [];
    const jar = new TipJar(fakeStore({ isPledger }).platform, memory(null, true).m, () => NOW, async (ms) => void waits.push(ms));
    await settle();
    await jar.refreshPledger();
    expect(isPledger).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([1000]);
    expect(jar.getState().pledger).toBe(true);
  });

  it("stops being a regular when the store says twice that no pledge is running (it ended)", async () => {
    const { m, pledges } = memory(null, true);
    const jar = jarOf(fakeStore({ isPledger: async () => false }).platform, m);
    await settle();
    await jar.refreshPledger();
    expect(jar.getState().pledger).toBe(false);
    expect(pledges).toEqual([false]);
  });

  it("keeps what it knew when the store can't say whether a pledge is running", async () => {
    const jar = jarOf(fakeStore({ isPledger: () => Promise.reject(new Error("offline")) }).platform, memory(null, true).m);
    await settle();
    await jar.refreshPledger();
    expect(jar.getState().pledger).toBe(true);
    const never = jarOf(fakeStore({ isPledger: () => Promise.reject(new Error("offline")) }).platform);
    await never.refreshPledger();
    expect(never.getState().pledger).toBe(false);
  });

  it("looks again when a purchase finishes with nobody waiting on it (an approval, a renewal)", async () => {
    let changed: () => void = () => {};
    let running = false;
    const platform = fakeStore({ isPledger: async () => running, watch: (cb) => ((changed = cb), () => {}) }).platform;
    const jar = jarOf(platform);
    expect(jar.getState().pledger).toBe(false);
    running = true;
    changed();
    await settle();
    expect(jar.getState().pledger).toBe(true);
  });

  it("opens the store's page to manage a pledge, and looks at it again afterwards", async () => {
    let running = true;
    const manage = jest.fn(async () => void (running = false));
    const jar = jarOf(fakeStore({ manage, isPledger: async () => running }).platform, memory(null, true).m);
    await settle();
    await jar.manage();
    await settle();
    expect(manage).toHaveBeenCalledTimes(1);
    expect(jar.getState().pledger).toBe(false);
  });

  it("is not stopped by a store that can't open its page", async () => {
    const jar = jarOf(fakeStore({ manage: () => Promise.reject(new Error("no page")) }).platform);
    await expect(jar.manage()).resolves.toBeUndefined();
  });

  it("has a made-up store whose pledge makes a regular, and whose Manage ends it, and an empty one", async () => {
    const demo = demoPlatform();
    expect((await demo.pledges(PLEDGE_IDS)).map((p) => p.price)).toEqual(["$1.99/mo", "$19.99/yr"]);
    expect(await demo.isPledger()).toBe(false);
    jest.useFakeTimers();
    try {
      const done = demo.subscribe(PLEDGE_IDS[0]);
      jest.advanceTimersByTime(800);
      await expect(done).resolves.toBe("thanked");
    } finally {
      jest.useRealTimers();
    }
    expect(await demo.isPledger()).toBe(true);
    await demo.manage();
    expect(await demo.isPledger()).toBe(false);
    expect(await noPlatform.products(TIP_IDS)).toEqual([]);
    expect(await noMemory.loadPledger()).toBeNull();
  });
});
