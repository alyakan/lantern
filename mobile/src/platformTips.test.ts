/** The real tip store, against a stand-in for expo-iap that records what it was asked and lets a test play the store's part. */
type Listener<T> = (e: T) => void;

const mockStore = {
  connected: 0,
  initFails: false,
  products: [] as unknown[],
  requested: [] as unknown[],
  finished: [] as unknown[],
  finishFails: false,
  updated: [] as Listener<Record<string, unknown>>[],
  errored: [] as Listener<{ code: string; message: string }>[],
  requestFails: null as Error | null,
};

jest.mock("expo-iap", () => ({
  ErrorCode: { UserCancelled: "user-cancelled" },
  initConnection: jest.fn(async () => {
    mockStore.connected += 1;
    if (mockStore.initFails) throw new Error("no store");
    return true;
  }),
  fetchProducts: jest.fn(async () => mockStore.products),
  requestPurchase: jest.fn(async (r: unknown) => {
    mockStore.requested.push(r);
    if (mockStore.requestFails) throw mockStore.requestFails;
  }),
  finishTransaction: jest.fn(async (a: unknown) => {
    if (mockStore.finishFails) throw new Error("finish failed");
    mockStore.finished.push(a);
  }),
  purchaseUpdatedListener: jest.fn((l: Listener<Record<string, unknown>>) => {
    mockStore.updated.push(l);
    return { remove: jest.fn() };
  }),
  purchaseErrorListener: jest.fn((l: Listener<{ code: string; message: string }>) => {
    mockStore.errored.push(l);
    return { remove: jest.fn() };
  }),
}));
jest.mock("expo-secure-store", () => {
  const data = new Map<string, string>();
  return { getItemAsync: jest.fn(async (k: string) => data.get(k) ?? null), setItemAsync: jest.fn(async (k: string, v: string) => void data.set(k, v)) };
});

import * as SecureStore from "expo-secure-store";
import { iapPlatform, secureTipMemory, startTipListener } from "./platformTips";
import { TIP_IDS } from "./tips";

const purchase = (productId: string, state = "purchased") => ({ productId, purchaseState: state, id: `t-${productId}` });
const play = (e: Record<string, unknown>) => mockStore.updated.forEach((l) => l(e));
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("the real tip store", () => {
  it("lists the tips cheapest first, under the names the store gives them without the app's name after", async () => {
    mockStore.products = [
      { id: TIP_IDS[2], title: "Generous Support (Lantern)", displayName: null, displayPrice: "$9.99", price: 9.99 },
      { id: TIP_IDS[0], title: "Small Coffee (Lantern)", displayName: "Small Coffee", displayPrice: "$0.99", price: 0.99 },
      { id: TIP_IDS[1], title: "Large Coffee (Lantern)", displayName: null, displayPrice: "$2.99", price: 2.99 },
    ];
    const tips = await iapPlatform.products(TIP_IDS);
    expect(tips).toEqual([
      { id: TIP_IDS[0], name: "Small Coffee", price: "$0.99" },
      { id: TIP_IDS[1], name: "Large Coffee", price: "$2.99" },
      { id: TIP_IDS[2], name: "Generous Support", price: "$9.99" },
    ]);
  });

  it("connects to the store once, and listens for purchases once", async () => {
    const connections = mockStore.connected;
    const listeners = mockStore.updated.length;
    await iapPlatform.products(TIP_IDS);
    await iapPlatform.products(TIP_IDS);
    expect(mockStore.connected).toBe(connections);
    expect(mockStore.updated.length).toBe(listeners);
  });

  it("asks the store for the one tip, for both stores' ways of saying it", async () => {
    const bought = iapPlatform.buy(TIP_IDS[1]);
    await settle();
    expect(mockStore.requested.at(-1)).toEqual({ request: { apple: { sku: TIP_IDS[1] }, google: { skus: [TIP_IDS[1]] } }, type: "in-app" });
    play(purchase(TIP_IDS[1]));
    await expect(bought).resolves.toBe("thanked");
  });

  it("finishes the tip as one that is used up, so it can be given again", async () => {
    const bought = iapPlatform.buy(TIP_IDS[0]);
    await settle();
    const p = purchase(TIP_IDS[0]);
    play(p);
    await bought;
    expect(mockStore.finished.at(-1)).toEqual({ purchase: p, isConsumable: true });
  });

  it("says a tip is pending when the store holds it for an approval, and does not finish it yet", async () => {
    const before = mockStore.finished.length;
    const bought = iapPlatform.buy(TIP_IDS[0]);
    await settle();
    play(purchase(TIP_IDS[0], "pending"));
    await expect(bought).resolves.toBe("pending");
    expect(mockStore.finished.length).toBe(before);
  });

  it("says it was cancelled when the person backed out, and failed for any other error", async () => {
    const backed = iapPlatform.buy(TIP_IDS[0]);
    await settle();
    mockStore.errored.forEach((l) => l({ code: "user-cancelled", message: "cancelled" }));
    await expect(backed).resolves.toBe("cancelled");

    const failed = iapPlatform.buy(TIP_IDS[0]);
    await settle();
    mockStore.errored.forEach((l) => l({ code: "network-error", message: "no network" }));
    await expect(failed).rejects.toThrow("no network");
  });

  it("fails when the purchase can't even be started", async () => {
    mockStore.requestFails = new Error("not prepared");
    await expect(iapPlatform.buy(TIP_IDS[0])).rejects.toThrow("not prepared");
    mockStore.requestFails = null;
  });

  it("fails when the store won't finish the transaction", async () => {
    mockStore.finishFails = true;
    const bought = iapPlatform.buy(TIP_IDS[0]);
    await settle();
    play(purchase(TIP_IDS[0]));
    await expect(bought).rejects.toThrow("finish failed");
    mockStore.finishFails = false;
  });

  it("finishes a tip that arrives with nobody waiting on it (an approval that came late), and ignores what isn't a tip", async () => {
    const before = mockStore.finished.length;
    play(purchase("com.somebody.else.product"));
    await settle();
    expect(mockStore.finished.length).toBe(before);
    const late = purchase(TIP_IDS[2]);
    play(late);
    await settle();
    expect(mockStore.finished.at(-1)).toEqual({ purchase: late, isConsumable: true });
  });

  it("is not thanked by the purchase of another tip than the one it waits on", async () => {
    const bought = iapPlatform.buy(TIP_IDS[0]);
    await settle();
    let resolved = false;
    void bought.then(() => (resolved = true));
    play(purchase(TIP_IDS[2]));
    await settle();
    expect(resolved).toBe(false);
    play(purchase(TIP_IDS[0]));
    await expect(bought).resolves.toBe("thanked");
  });

  it("can be started at launch without waiting, and never fails there", async () => {
    mockStore.initFails = true;
    expect(() => startTipListener()).not.toThrow();
    await settle();
    mockStore.initFails = false;
  });

  it("asks again to connect after a connection that failed (on a fresh copy: the others are connected already)", async () => {
    let fresh: typeof iapPlatform | undefined;
    jest.isolateModules(() => {
      fresh = (require("./platformTips") as typeof import("./platformTips")).iapPlatform;
    });
    const before = mockStore.connected;
    mockStore.initFails = true;
    await expect(fresh!.products(TIP_IDS)).rejects.toThrow("no store");
    mockStore.initFails = false;
    await fresh!.products(TIP_IDS);
    expect(mockStore.connected).toBe(before + 2);
  });
});

describe("the memory of the last tip", () => {
  it("keeps the day, and reads it back", async () => {
    expect(await secureTipMemory.load()).toBeNull();
    await secureTipMemory.save(1_700_000_000_000);
    expect(await secureTipMemory.load()).toBe(1_700_000_000_000);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("lantern.last-tip", "1700000000000");
  });

  it("reads nothing from what isn't a day", async () => {
    await SecureStore.setItemAsync("lantern.last-tip", "not a number");
    expect(await secureTipMemory.load()).toBeNull();
    await SecureStore.setItemAsync("lantern.last-tip", "-5");
    expect(await secureTipMemory.load()).toBeNull();
  });
});
