/**
 * The real tip store: expo-iap (StoreKit 2 on iOS, Google Play Billing on Android) behind the TipPlatform seam. One listener
 * for purchases lives for as long as the app does: it hands a finished purchase to whoever is waiting on it, and finishes
 * any other tip (one that went through after the screen was gone, or an Ask to Buy approval) so the store never replays it.
 */
import { ErrorCode, fetchProducts, finishTransaction, initConnection, purchaseErrorListener, purchaseUpdatedListener, requestPurchase, type Purchase } from "expo-iap";
import * as SecureStore from "expo-secure-store";
import { cleanName, TIP_IDS, type Tip, type TipMemory, type TipPlatform } from "./tips";

type Outcome = "thanked" | "cancelled" | "pending";

/** The purchase someone is waiting on. */
let waiting: { id: string; done: (outcome: Outcome) => void; fail: (e: Error) => void } | null = null;
let connected: Promise<unknown> | null = null;
let listening = false;

const isTip = (id: string) => (TIP_IDS as readonly string[]).includes(id);

function listen() {
  if (listening) return;
  listening = true;
  purchaseUpdatedListener(async (purchase: Purchase) => {
    if (!isTip(purchase.productId)) return;
    if (purchase.purchaseState === "pending") {
      if (waiting?.id === purchase.productId) waiting.done("pending");
      return;
    }
    try {
      // A tip is used up when it is bought, so it can be bought again.
      await finishTransaction({ purchase, isConsumable: true });
      if (waiting?.id === purchase.productId) waiting.done("thanked");
    } catch (e) {
      if (waiting?.id === purchase.productId) waiting.fail(e as Error);
    }
  });
  purchaseErrorListener((error) => {
    if (!waiting) return;
    if (error.code === ErrorCode.UserCancelled) waiting.done("cancelled");
    else waiting.fail(new Error(error.message));
  });
}

function connect() {
  listen();
  connected ??= initConnection().catch((e: unknown) => {
    connected = null;
    throw e;
  });
  return connected;
}

/** Starts listening (and finishing tips that arrive late) from the moment the app opens. */
export function startTipListener() {
  void connect().catch(() => {});
}

export const iapPlatform: TipPlatform = {
  async products(ids) {
    await connect();
    const found = await fetchProducts({ skus: [...ids], type: "in-app" });
    const list = (found ?? []) as { id: string; title: string; displayName?: string | null; displayPrice: string; price?: number | null }[];
    return list
      .map((p): Tip & { amount: number } => ({ id: p.id, name: cleanName(p.displayName || p.title), price: p.displayPrice, amount: p.price ?? 0 }))
      .sort((a, b) => a.amount - b.amount)
      .map(({ id, name, price }) => ({ id, name, price }));
  },

  async buy(id) {
    await connect();
    return new Promise<Outcome>((resolve, reject) => {
      const finish = (fn: () => void) => {
        waiting = null;
        fn();
      };
      waiting = { id, done: (o) => finish(() => resolve(o)), fail: (e) => finish(() => reject(e)) };
      requestPurchase({ request: { apple: { sku: id }, google: { skus: [id] } }, type: "in-app" }).catch((e: Error) => waiting?.id === id && waiting.fail(e));
    });
  },
};

const KEY = "lantern.last-tip";

/** The day of the last tip: it is not a secret, and the keychain is already how this app keeps what it keeps. */
export const secureTipMemory: TipMemory = {
  async load() {
    const raw = await SecureStore.getItemAsync(KEY);
    const at = raw ? Number(raw) : NaN;
    return Number.isFinite(at) && at > 0 ? at : null;
  },
  save: (at) => SecureStore.setItemAsync(KEY, String(at)),
};
