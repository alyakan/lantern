/**
 * Pure helpers for Pulse: burn-rate forecasts, levels and short formatting.
 */
import type { PlanUsage, PulseWindow } from '@/common/types/cockpitPulse';

export const FIVE_HOURS = 5 * 3600;
export const WEEK = 7 * 24 * 3600;

export type Level = 'ok' | 'warn' | 'hot';

/** ok under 60 %, warn under 85 %, hot from there. */
export function levelOf(percent: number | undefined): Level {
  if (percent === undefined) return 'ok';
  if (percent >= 85) return 'hot';
  if (percent >= 60) return 'warn';
  return 'ok';
}

/**
 * When the window runs out at the pace used so far, as unix seconds; undefined when the pace
 * finishes the window before it resets (or there is not enough data).
 */
export function exhaustAt(window: PulseWindow | undefined, length: number, now: number): number | undefined {
  if (!window?.resetsAt || window.usedPercent <= 0) return undefined;
  if (window.usedPercent >= 100) return now;
  const start = window.resetsAt - length;
  const elapsed = now - start;
  if (elapsed < length * 0.05) return undefined;
  const ratePerSecond = window.usedPercent / elapsed;
  const at = now + (100 - window.usedPercent) / ratePerSecond;
  return at < window.resetsAt ? Math.round(at) : undefined;
}

/** Remaining headroom of a plan (0 to 100), the tighter of its two windows. */
export function headroom(usage: PlanUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const used = Math.max(usage.fiveHour?.usedPercent ?? 0, usage.week?.usedPercent ?? 0);
  return usage.note === 'limit reached' ? 0 : Math.max(0, 100 - used);
}

/** "in 2h 10m", "in 3d 4h". */
export function formatIn(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** "Mon 09:00" in local time. */
export function formatWhen(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const day = date.toLocaleDateString('en-GB', { weekday: 'short' });
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${day} ${time}`;
}

/** "17.3 GB". */
export function formatGb(bytes: number | undefined): string {
  if (!bytes) return '0 GB';
  return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
}

/** "20/24 GB". */
export function formatVram(used: number, total: number | undefined): string {
  const gb = (bytes: number) => Math.round(bytes / 1024 ** 3);
  return total ? `${gb(used)}/${gb(total)} GB` : formatGb(used);
}
