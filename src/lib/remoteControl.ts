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
  devices: RemoteDevice[];
  /** The last change holds, but couldn't be saved: why (it won't last past a restart). */
  warning?: string | null;
}

/** The QR code a phone pairs with, and when it stops working (ms since the epoch). */
export interface PairView {
  svg: string;
  expires_at: number;
}

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
