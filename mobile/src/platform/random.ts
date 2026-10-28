/**
 * Secure random bytes, for this phone's key. Hermes has no `crypto.getRandomValues` of its own: the app installs one
 * from expo-crypto at its entry (see polyfills.ts), and a key is never made without one.
 */

export function randomBytes(n: number): Uint8Array {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c || typeof c.getRandomValues !== "function") throw new Error("This phone has no secure random numbers, so it can't make a key.");
  return c.getRandomValues(new Uint8Array(n));
}
