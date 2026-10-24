/** A paired phone as Settings lists it. */
export interface RemoteDevice {
  id: string;
  name: string;
  paired_at: number;
  last_seen: number | null;
}

/** Settings › Remote control, as the backend has it. */
export interface RemoteView {
  enabled: boolean;
  show_titles: boolean;
  /** The Mac isn't let to sleep from idling while Remote control is on. */
  keep_awake: boolean;
  /** The Mac's Tailscale addresses (none when Tailscale isn't on): what lets a phone reach it away from home. */
  tailnet: string[];
  allow_phone_auto: boolean;
  devices: RemoteDevice[];
  /** The ids of the phones connected now. */
  connected: string[];
  /** Something is listening for phones (it can be on and not listening: the port was taken). */
  listening: boolean;
  /** A pairing code is on offer and unused. */
  pairing: boolean;
  /** The id of the push key imported for the lock-screen cards (null: none yet). */
  live_key?: string | null;
  /** What Apple last answered about a card, in words (never a token, a payload or the key). */
  live_last?: string | null;
  /** The last change holds, but couldn't be saved: why (it won't last past a restart). */
  warning?: string | null;
}

/** The team Lantern's phone app is built under (it is printed on the app's store page, so it isn't a secret). */
export const LANTERN_TEAM_ID = "2NT5QR24SX";

/** The Key ID in the name Apple gives a push key's file ("AuthKey_ABCDE12345.p8"), or null for any other name. */
export function keyIdFromFile(path: string): string | null {
  const m = /(?:^|[\\/])AuthKey_([A-Za-z0-9]{10})\.p8$/.exec(path);
  return m ? m[1] : null;
}

/** The QR code a phone pairs with, and when it stops working (ms since the epoch). */
export interface PairView {
  svg: string;
  /** The same code as text, for a phone that can't read the screen with its camera. */
  link: string;
  expires_at: number;
}

/** The names of the phones connected now, as the title bar's chip says them. */
export const connectedNames = (v: RemoteView): string[] => v.devices.filter((d) => v.connected.includes(d.id)).map((d) => d.name);

/** "4:52": what's left of a pairing code. */
export function timeLeft(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** When a phone last connected, in words. */
export function lastSeen(at: number | null, now: number): string {
  if (at === null) return "Never connected";
  const min = Math.floor((now - at) / 60_000);
  if (min < 2) return "Connected just now";
  if (min < 60) return `Last connected ${min} minutes ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `Last connected ${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `Last connected ${d} day${d === 1 ? "" : "s"} ago`;
}
