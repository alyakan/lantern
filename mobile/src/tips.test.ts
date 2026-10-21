import { cleanName, sameMonth, TIP_IDS, TipJar, type Tip, type TipMemory, type TipPlatform } from "./tips";

const TIPS: Tip[] = [
  { id: TIP_IDS[0], name: "Small Coffee", price: "$0.99" },
  { id: TIP_IDS[1], name: "Large Coffee", price: "$2.99" },
  { id: TIP_IDS[2], name: "Generous Support", price: "$9.99" },
];

/** A store the test steers: what it answers, and when. */
function fakeStore(over: Partial<TipPlatform> = {}) {
  const asked: string[] = [];
  const platform: TipPlatform = {
    products: jest.fn(async () => TIPS),
    buy: jest.fn(async (id: string) => {
      asked.push(id);
      return "thanked" as const;
    }),
    ...over,
  };
  return { platform, asked };
}

function memory(initial: number | null = null) {
  const saved: number[] = [];
  const m: TipMemory = { load: async () => initial, save: async (at) => void saved.push(at) };
  return { m, saved };
}

const NOW = new Date(2026, 9, 21, 12).getTime();
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("the tip ids", () => {
  it("are three, smallest first, under the app's id", () => {
    expect(TIP_IDS).toEqual(["com.alyakan.lantern.tip.small", "com.alyakan.lantern.tip.medium", "com.alyakan.lantern.tip.large"]);
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
  it("starts out loading, and has the tips once the store has answered", async () => {
    const { platform } = fakeStore();
    const jar = new TipJar(platform, memory().m, () => NOW);
    expect(jar.getState().phase).toBe("loading");
    await jar.load();
    expect(jar.getState()).toMatchObject({ phase: "ready", tips: TIPS, error: null });
    expect(platform.products).toHaveBeenCalledWith(TIP_IDS);
  });

  it("asks the store once, however often it is asked to load, and not again once it has the tips", async () => {
    const { platform } = fakeStore();
    const jar = new TipJar(platform, memory().m, () => NOW);
    await Promise.all([jar.load(), jar.load()]);
    await jar.load();
    expect(platform.products).toHaveBeenCalledTimes(1);
  });

  it("is unavailable, saying so, when the store can't be reached, and asks again when told to", async () => {
    let up = false;
    const { platform } = fakeStore({ products: jest.fn(async () => (up ? TIPS : Promise.reject(new Error("offline")))) });
    const jar = new TipJar(platform, memory().m, () => NOW);
    await jar.load();
    expect(jar.getState()).toMatchObject({ phase: "unavailable", tips: [] });
    expect(jar.getState().error).toMatch(/aren't available right now/);
    up = true;
    await jar.load();
    expect(jar.getState()).toMatchObject({ phase: "ready", error: null });
  });

  it("is unavailable too when the store knows none of the tips", async () => {
    const jar = new TipJar(fakeStore({ products: async () => [] }).platform, memory().m, () => NOW);
    await jar.load();
    expect(jar.getState().phase).toBe("unavailable");
  });

  it("buys the tip asked for, says thanks, and remembers the day", async () => {
    const { platform, asked } = fakeStore();
    const { m, saved } = memory();
    const jar = new TipJar(platform, m, () => NOW);
    await jar.load();
    await jar.tip(TIP_IDS[1]);
    expect(asked).toEqual([TIP_IDS[1]]);
    expect(jar.getState()).toMatchObject({ phase: "thanked", lastTipAt: NOW });
    expect(saved).toEqual([NOW]);
    expect(jar.hasTippedThisMonth()).toBe(true);
  });

  it("goes back to the list once the thanks have been seen, with the tips still there", async () => {
    const jar = new TipJar(fakeStore().platform, memory().m, () => NOW);
    await jar.load();
    await jar.tip(TIP_IDS[0]);
    jar.acknowledge();
    expect(jar.getState()).toMatchObject({ phase: "ready", tips: TIPS });
  });

  it("leaves everything as it was when the person backs out", async () => {
    const { m, saved } = memory();
    const jar = new TipJar(fakeStore({ buy: async () => "cancelled" }).platform, m, () => NOW);
    await jar.load();
    await jar.tip(TIP_IDS[0]);
    expect(jar.getState()).toMatchObject({ phase: "ready", lastTipAt: null, awaitingApproval: false });
    expect(saved).toEqual([]);
  });

  it("says a tip awaits approval (Ask to Buy), without thanking yet", async () => {
    const jar = new TipJar(fakeStore({ buy: async () => "pending" }).platform, memory().m, () => NOW);
    await jar.load();
    await jar.tip(TIP_IDS[0]);
    expect(jar.getState()).toMatchObject({ phase: "ready", awaitingApproval: true, lastTipAt: null });
  });

  it("says nothing was charged when the purchase failed, and can be tried again", async () => {
    let fail = true;
    const { platform } = fakeStore({ buy: jest.fn(async () => (fail ? Promise.reject(new Error("store error")) : ("thanked" as const))) });
    const jar = new TipJar(platform, memory().m, () => NOW);
    await jar.load();
    await jar.tip(TIP_IDS[0]);
    expect(jar.getState().phase).toBe("failed");
    expect(jar.getState().error).toMatch(/Nothing was charged/);
    expect(jar.getState().lastTipAt).toBeNull();
    fail = false;
    await jar.tip(TIP_IDS[0]);
    expect(jar.getState()).toMatchObject({ phase: "thanked", error: null });
  });

  it("buys one tip at a time", async () => {
    let release: (v: "thanked") => void = () => {};
    const buy = jest.fn(() => new Promise<"thanked">((r) => (release = r)));
    const jar = new TipJar(fakeStore({ buy }).platform, memory().m, () => NOW);
    await jar.load();
    const first = jar.tip(TIP_IDS[0]);
    expect(jar.getState().phase).toBe("purchasing");
    await jar.tip(TIP_IDS[1]);
    expect(buy).toHaveBeenCalledTimes(1);
    release("thanked");
    await first;
    expect(jar.getState().phase).toBe("thanked");
  });

  it("remembers the last tip from a run before, and says whether it was this month", async () => {
    const lastMonth = new Date(2026, 8, 30).getTime();
    const thisMonth = new Date(2026, 9, 2).getTime();
    const before = new TipJar(fakeStore().platform, memory(lastMonth).m, () => NOW);
    await settle();
    expect(before.getState().lastTipAt).toBe(lastMonth);
    expect(before.hasTippedThisMonth()).toBe(false);
    const recent = new TipJar(fakeStore().platform, memory(thisMonth).m, () => NOW);
    await settle();
    expect(recent.hasTippedThisMonth()).toBe(true);
  });

  it("is not stopped by a memory that can't be read or written", async () => {
    const broken: TipMemory = { load: async () => Promise.reject(new Error("keychain")), save: async () => Promise.reject(new Error("keychain")) };
    const jar = new TipJar(fakeStore().platform, broken, () => NOW);
    await jar.load();
    await jar.tip(TIP_IDS[0]);
    expect(jar.getState().phase).toBe("thanked");
  });

  it("tells its listeners when anything changes, and stops when they go", async () => {
    const jar = new TipJar(fakeStore().platform, memory().m, () => NOW);
    const seen: string[] = [];
    const stop = jar.subscribe(() => seen.push(jar.getState().phase));
    await jar.load();
    stop();
    await jar.tip(TIP_IDS[0]);
    expect(seen).toEqual(["loading", "ready"]);
  });
});
