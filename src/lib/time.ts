const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** How long something has run: "12s", "3m", "1h 5m". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const m = Math.floor((s % 3600) / 60);
  return `${Math.floor(s / 3600)}h${m ? ` ${m}m` : ""}`;
}

/** When a message was sent: "14:02" today, "Yesterday 14:02", then "Sep 28, 14:02". */
export function messageTime(ms: number, now = Date.now()): string {
  const at = new Date(ms);
  const clock = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(at)) / DAY);
  if (days === 0) return clock;
  if (days === 1) return `Yesterday ${clock}`;
  const date = at.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(at.getFullYear() !== new Date(now).getFullYear() && { year: "numeric" }) });
  return `${date}, ${clock}`;
}

/** Compact "how long ago" for session lists: just now, 5m ago, 3h ago, yesterday, 4d ago, then a short date. */
export function relativeTime(ms: number, now = Date.now()): string {
  const d = now - ms;
  if (d < MIN) return "just now";
  if (d < HOUR) return `${Math.floor(d / MIN)}m ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`;
  if (d < 2 * DAY) return "yesterday";
  if (d < 7 * DAY) return `${Math.floor(d / DAY)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
