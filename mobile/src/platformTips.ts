/**
 * The real tip store: expo-iap (StoreKit 2 on iOS, Google Play Billing on Android) behind the TipPlatform seam. One listener
 * for purchases lives for as long as the app does: it hands a finished purchase to whoever is waiting on it, and finishes
 * any other tip or pledge (one that went through after the screen was gone, an Ask to Buy approval, a renewal) so the store
 * never replays it, telling whoever is watching so the pledge can be looked at again.
 */
import { Platform } from "react-native";
import { deepLinkToSubscriptions, ErrorCode, fetchProducts, finishTransaction, getActiveSubscriptions, initConnection, purchaseErrorListener, purchaseUpdatedListener, requestPurchase, showManageSubscriptionsIOS, type Purchase } from "expo-iap";
import * as SecureStore from "expo-secure-store";
import { cleanName, PLEDGE_IDS, TIP_IDS, type Outcome, type Pledge, type Tip, type TipMemory, type TipPlatform } from "./tips";

const PACKAGE = "com.alyakan.lantern";

/** The purchase someone is waiting on. */
let waiting: { id: string; done: (outcome: Outcome) => void; fail: (e: Error) => void } | null = null;
let connected: Promise<unknown> | null = null;
let listening = false;
const watchers = new Set<() => void>();
/** The Android offer to buy each pledge with (a subscription is bought through one of its offers). */
const offerTokens = new Map<string, string>();

const isTip = (id: string) => (TIP_IDS as readonly string[]).includes(id);
const isPledge = (id: string) => (PLEDGE_IDS as readonly string[]).includes(id);

function listen() {
  if (listening) return;
  listening = true;
  purchaseUpdatedListener(async (purchase: Purchase) => {
    const id = purchase.productId;
    if (!isTip(id) && !isPledge(id)) return;
    const mine = waiting?.id === id ? waiting : null;
    if (purchase.purchaseState === "pending") {
      mine?.done("pending");
      return;
    }
    try {
      // A tip is used up when it is bought, so it can be bought again; a pledge is not.
      await finishTransaction({ purchase, isConsumable: isTip(id) });
      if (mine) mine.done("thanked");
      else if (isPledge(id)) for (const w of watchers) w();
    } catch (e) {
      mine?.fail(e as Error);
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

/** Starts listening (and finishing tips and pledges that arrive late) from the moment the app opens. */
export function startTipListener() {
  void connect().catch(() => {});
}

type Bought = { id: string; title: string; displayName?: string | null; displayPrice: string; price?: number | null; subscriptionOffers?: { offerTokenAndroid?: string | null }[] | null };

function purchase(id: string, request: Parameters<typeof requestPurchase>[0]) {
  return new Promise<Outcome>((resolve, reject) => {
    const finish = (fn: () => void) => {
      waiting = null;
      fn();
    };
    waiting = { id, done: (o) => finish(() => resolve(o)), fail: (e) => finish(() => reject(e)) };
    requestPurchase(request).catch((e: Error) => waiting?.id === id && waiting.fail(e));
  });
}

export const iapPlatform: TipPlatform = {
  async products(ids) {
    await connect();
    const found = (await fetchProducts({ skus: [...ids], type: "in-app" })) as Bought[] | null;
    return (found ?? [])
      .map((p): Tip & { amount: number } => ({ id: p.id, name: cleanName(p.displayName || p.title), price: p.displayPrice, amount: p.price ?? 0 }))
      .sort((a, b) => a.amount - b.amount)
      .map(({ id, name, price }) => ({ id, name, price }));
  },

  async buy(id) {
    await connect();
    return purchase(id, { request: { apple: { sku: id }, google: { skus: [id] } }, type: "in-app" });
  },

  async pledges(ids) {
    await connect();
    const found = (await fetchProducts({ skus: [...ids], type: "subs" })) as Bought[] | null;
    const list = found ?? [];
    for (const p of list) {
      const token = p.subscriptionOffers?.find((o) => o.offerTokenAndroid)?.offerTokenAndroid;
      if (token) offerTokens.set(p.id, token);
    }
    return list
      .map((p): Pledge => {
        const per = p.id.endsWith(".yearly") ? "year" : "month";
        // The store's price, without any "/month" it may have added: this says how often in its own short way.
        return { id: p.id, name: cleanName(p.displayName || p.title), price: `${p.displayPrice.replace(/\s*\/.*$/, "")}/${per === "year" ? "yr" : "mo"}`, per };
      })
      .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  },

  async subscribe(id) {
    await connect();
    const token = offerTokens.get(id);
    return purchase(id, { request: { apple: { sku: id }, google: { skus: [id], subscriptionOffers: token ? [{ sku: id, offerToken: token }] : undefined } }, type: "subs" });
  },

  async isPledger() {
    await connect();
    const active = await getActiveSubscriptions([...PLEDGE_IDS]);
    return (active ?? []).some((s) => s.isActive);
  },

  async manage() {
    await connect();
    if (Platform.OS === "ios") await showManageSubscriptionsIOS();
    else await deepLinkToSubscriptions({ packageNameAndroid: PACKAGE, skuAndroid: PLEDGE_IDS[0] });
  },

  watch(changed) {
    watchers.add(changed);
    // Listening has to be on for anything to arrive.
    startTipListener();
    return () => void watchers.delete(changed);
  },
};

const KEY = "lantern.last-tip";
const PLEDGER = "lantern.pledger";

/** What is kept: they are not secrets, and the keychain is already how this app keeps what it keeps. */
export const secureTipMemory: TipMemory = {
  async load() {
    const raw = await SecureStore.getItemAsync(KEY);
    const at = raw ? Number(raw) : NaN;
    return Number.isFinite(at) && at > 0 ? at : null;
  },
  save: (at) => SecureStore.setItemAsync(KEY, String(at)),
  async loadPledger() {
    const raw = await SecureStore.getItemAsync(PLEDGER);
    return raw === "1" ? true : raw === "0" ? false : null;
  },
  savePledger: (on) => SecureStore.setItemAsync(PLEDGER, on ? "1" : "0"),
};
