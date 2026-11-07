/**
 * Messages written while the Mac couldn't be reached, kept on this phone (the Keychain, as drafts are) until they go, so iOS
 * ending the app in a long stretch offline doesn't lose them. The box was cleared when each was sent, so this is the only copy.
 */
import * as SecureStore from "expo-secure-store";

const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const KEY = "lantern.outbox";

/** How many wait at most, and how much of each is kept (as a draft is). */
export const OUTBOX_KEPT = 20;
const TEXT_MAX = 4000;

/** `epoch`: the Mac's run it was written for (its chats are named afresh each run, so a slot is only that run's). */
export interface Held {
  slot: string;
  text: string;
  clientId: string;
  epoch: number | null;
  at: number;
  /** The chat's project when it was written (null: none known): an empty chat's slot can take another project's chat. Absent in
   * what an older build kept. */
  project?: string | null;
}

/** What waits, and the Mac run this phone last spoke to (what a message written before any connection this launch is for). */
export interface Kept {
  held: Held[];
  epoch: number | null;
}

export interface OutboxStore {
  load(): Promise<Kept>;
  save(kept: Kept): Promise<void>;
}

const valid = (h: unknown): h is Held => {
  const o = h as Held;
  return !!o && typeof o.slot === "string" && typeof o.text === "string" && typeof o.clientId === "string" && (o.epoch === null || typeof o.epoch === "number") && typeof o.at === "number";
};

export const keychainOutbox: OutboxStore = {
  async load() {
    try {
      const raw = JSON.parse((await SecureStore.getItemAsync(KEY, OPTIONS)) ?? "{}") as { held?: unknown; epoch?: unknown };
      return { held: Array.isArray(raw.held) ? raw.held.filter(valid).slice(-OUTBOX_KEPT) : [], epoch: typeof raw.epoch === "number" ? raw.epoch : null };
    } catch {
      return { held: [], epoch: null };
    }
  },
  async save({ held, epoch }) {
    try {
      await SecureStore.setItemAsync(KEY, JSON.stringify({ held: held.slice(-OUTBOX_KEPT).map((h) => ({ ...h, text: h.text.slice(0, TEXT_MAX) })), epoch }), OPTIONS);
    } catch {
      // Not kept on the phone: it holds until the app closes.
    }
  },
};

/** Forgets what waits, and the Mac run (the phone was unpaired: it was for another Mac). */
export async function forgetOutbox() {
  try {
    await SecureStore.deleteItemAsync(KEY, OPTIONS);
  } catch {
    // Nothing more to do.
  }
}
