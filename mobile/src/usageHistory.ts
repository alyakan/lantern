/** The plan usage history on this phone (the Keychain): read and written here, drawn by the usage sheet. */
import { useSyncExternalStore } from "react";
import * as SecureStore from "expo-secure-store";
import type { PlanUsage } from "./sync/reducer";
import { parseBuckets, record, toRaw, type Bucket } from "./view/usageHistory";

const KEY = "lantern.usage-history";
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

let buckets: Bucket[] = [];
let loading: Promise<void> | null = null;
let snapshot: Bucket[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

/** How long readings wait before the history is written down once. */
export const SAVE_AFTER_MS = 30_000;

function emit() {
  snapshot = [...buckets];
  listeners.forEach((l) => l());
}

function ensureLoaded(): Promise<void> {
  loading ??= (async () => {
    try {
      const kept = parseBuckets(JSON.parse((await SecureStore.getItemAsync(KEY, OPTIONS)) ?? "[]"));
      // Readings taken while this was reading stay: they are newer.
      const merged = new Map(kept.map((b) => [b.h, b] as const));
      for (const b of buckets) merged.set(b.h, { h: b.h, five: Math.max(b.five, merged.get(b.h)?.five ?? 0), week: b.week ?? merged.get(b.h)?.week ?? null });
      buckets = [...merged.values()].sort((a, b) => a.h - b.h);
    } catch {
      // Nothing kept, or not readable: it starts again from now.
    }
    emit();
  })();
  return loading;
}

function save() {
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    try {
      await SecureStore.setItemAsync(KEY, JSON.stringify(toRaw(buckets)), OPTIONS);
    } catch {
      // Not kept: it holds until the app closes.
    }
  }, SAVE_AFTER_MS);
}

/** The phone heard the plan's usage: it goes in the history. */
export function recordUsage(plan: PlanUsage, now = Date.now()) {
  void ensureLoaded().then(() => {
    buckets = record(buckets, plan, now);
    emit();
    save();
  });
}

export function useUsageHistory(): Bucket[] {
  void ensureLoaded();
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => snapshot,
  );
}

/** Forgets the history (this phone was unpaired from the Mac, or the tests' fresh start). */
export function resetUsageHistory() {
  buckets = [];
  snapshot = [];
  loading = null;
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Forgets the history on the phone too (this phone was unpaired from the Mac). */
export async function forgetUsageHistory() {
  resetUsageHistory();
  try {
    await SecureStore.deleteItemAsync(KEY, OPTIONS);
  } catch {
    // Nothing to do.
  }
}
