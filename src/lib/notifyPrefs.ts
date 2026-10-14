import type { Attention } from "./attention";
import { readStored } from "./layout";

export const NOTIFY_KEY = "settings.notify";

/** What Settings' General tab lets the user turn off. `pausedUntil` is a time in ms (0: not paused). */
export interface NotifyPrefs {
  on: boolean;
  finished: boolean;
  waiting: boolean;
  failed: boolean;
  pausedUntil: number;
}

export const NOTIFY_DEFAULTS: NotifyPrefs = { on: true, finished: true, waiting: true, failed: true, pausedUntil: 0 };

export const PAUSE_MS = 60 * 60 * 1000;

/** The saved preferences, with anything missing from them filled in from the defaults. */
export const loadNotifyPrefs = (): NotifyPrefs => ({ ...NOTIFY_DEFAULTS, ...readStored<Partial<NotifyPrefs>>(NOTIFY_KEY, {}) });

/**
 * Whether an event of this kind should reach the user now, as a macOS notification or a toast. "Stopped" has no switch
 * of its own: it follows "Finished", since both are a turn ending.
 */
export function shouldNotify(prefs: NotifyPrefs, kind: Attention["kind"], now = Date.now()): boolean {
  if (!prefs.on || now < prefs.pausedUntil) return false;
  if (kind === "waiting") return prefs.waiting;
  if (kind === "failed") return prefs.failed;
  return prefs.finished;
}
