/**
 * The key this phone made for the words of its notifications. With "Show what Claude asks in notifications" on, the Mac encrypts
 * the command, the file or the question with it and sends the result in the push; the phone's notification extension (a native
 * target, see targets/) reads the key from the Keychain and decrypts it, so Apple only carries bytes it can't read. The phone
 * makes the key and tells the Mac over the paired channel; the Mac never makes one, and Apple never sees one.
 *
 * Kept in the iOS Keychain in a group the app and its extension share, readable once the phone has been unlocked since it
 * started (the extension runs while it is locked). Android has no such extension, so it makes none.
 */
import { toBase64Url } from "./platform/utf8";

/** Where the key is kept: the Keychain behind this seam (see platformPushKey.ts); a test stands in for it. */
export interface PushKeyStore {
  read(): Promise<string | null>;
  write(key: string): Promise<void>;
  forget(): Promise<void>;
}

/** ChaCha20-Poly1305's key size, and what a base64 of it looks like (standard alphabet, with padding). */
export const PUSH_KEY_BYTES = 32;
const STANDARD = /^[A-Za-z0-9+/]{43}=$/;

/** Standard base64, with padding: what the Mac and the extension read (the phone's other base64 is URL-safe and unpadded). */
export function toBase64(bytes: Uint8Array): string {
  const b = toBase64Url(bytes).replace(/-/g, "+").replace(/_/g, "/");
  return b + "=".repeat((4 - (b.length % 4)) % 4);
}

/** The phone's push key: the one it already made, or a new one (kept before it is used). Throws if it can't make or keep one. */
export async function ensurePushKey(store: PushKeyStore, random: (n: number) => Uint8Array): Promise<string> {
  const have = await store.read();
  if (have && STANDARD.test(have)) return have;
  const made = toBase64(random(PUSH_KEY_BYTES));
  await store.write(made);
  return made;
}

/** What this does with the Mac: ask it whether it takes a key, and send one. */
export interface PushKeyHost {
  has: (feature: string) => boolean;
  registerPushKey: (key: string) => Promise<unknown>;
}

/**
 * Gives the Mac the key, when it lists "pushkey" (an older Mac ends the connection at a request it doesn't know). Sent on every
 * connection: the Mac keeps the last one it was given. Any trouble (no Keychain access in this build, the Mac refusing) is no
 * matter: the notifications just stay in their short words. Says whether it was sent.
 */
export async function sharePushKey(host: PushKeyHost, store: PushKeyStore | null, random: (n: number) => Uint8Array): Promise<boolean> {
  if (!store || !host.has("pushkey")) return false;
  try {
    await host.registerPushKey(await ensurePushKey(store, random));
    return true;
  } catch {
    return false;
  }
}
