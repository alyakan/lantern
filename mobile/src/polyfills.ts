/**
 * What the phone's JavaScript engine (Hermes) lacks and the app needs, installed before anything else runs: secure random
 * numbers (a key is made from them), from expo-crypto. Imported first by index.ts.
 */
import * as ExpoCrypto from "expo-crypto";

const g = globalThis as { crypto?: { getRandomValues?: unknown } };
if (!g.crypto || typeof g.crypto.getRandomValues !== "function") {
  Object.defineProperty(globalThis, "crypto", {
    value: { ...(g.crypto ?? {}), getRandomValues: <T extends ArrayBufferView>(array: T): T => ExpoCrypto.getRandomValues(array as unknown as Uint8Array) as unknown as T },
    configurable: true,
    writable: true,
  });
}
