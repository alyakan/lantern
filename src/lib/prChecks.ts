import type { PrCheck, PullRequest } from "../types";

/**
 * What happens after a pull request is open and its checks run, decided per project. Lantern only reads GitHub through the
 * GitHub CLI; "Fix it myself" means it sends Claude a message (Claude still asks permission for each command) and never merges.
 * Everything here is pure, so the loop can be tested to the letter.
 */

/** Off: nothing watched. Tell me: the chat says how the checks stand. Fix it myself: a failure is sent to Claude by itself. */
export type PrMode = "off" | "tell" | "fix";

export interface PrSetting {
  mode: PrMode;
  /** How many times Fix it myself sends a failure to Claude for one pull request. */
  tries: number;
}

export const PR_SETTINGS_KEY = "prChecks.byFolder";
export const PR_LOOP_KEY = "prChecks.loopByFolder";

export const TRIES_MIN = 1;
export const TRIES_MAX = 5;
export const DEFAULT_PR_SETTING: PrSetting = { mode: "tell", tries: 3 };

export const PR_MODES: { mode: PrMode; label: string; hint: string }[] = [
  { mode: "off", label: "Off", hint: "Lantern doesn't look at the pull request's checks." },
  { mode: "tell", label: "Tell me", hint: "Lantern shows how the checks stand, and tells you when one fails." },
  { mode: "fix", label: "Fix it myself", hint: "When a check fails, Lantern asks Claude to fix it, a few times at most. It never merges." },
];

/** A project's setting from what was saved: a missing or odd entry is the default one. */
export function settingFor(saved: Record<string, Partial<PrSetting> | undefined>, folder: string | null): PrSetting {
  const found = folder ? saved[folder] : undefined;
  const mode = found?.mode === "off" || found?.mode === "tell" || found?.mode === "fix" ? found.mode : DEFAULT_PR_SETTING.mode;
  const raw = Number(found?.tries);
  const tries = Number.isFinite(raw) ? Math.min(TRIES_MAX, Math.max(TRIES_MIN, Math.round(raw))) : DEFAULT_PR_SETTING.tries;
  return { mode, tries };
}

export interface CheckTotals {
  passed: number;
  failed: number;
  running: number;
  skipped: number;
  cancelled: number;
  total: number;
}

export function totals(checks: PrCheck[]): CheckTotals {
  const count = (bucket: PrCheck["bucket"]) => checks.filter((c) => c.bucket === bucket).length;
  return { passed: count("pass"), failed: count("fail"), running: count("pending"), skipped: count("skipping"), cancelled: count("cancel"), total: checks.length };
}

/** none: no checks; running: some still going; failed: all finished and one failed; passed: all finished and none failed. */
export type Overall = "none" | "running" | "failed" | "passed";

export function overall(t: CheckTotals): Overall {
  if (t.total === 0) return "none";
  if (t.running > 0) return "running";
  return t.failed > 0 ? "failed" : "passed";
}

/** "Checks: 2 passed, 1 failed, 1 running" (the kinds there are none of are left out). */
export function summaryLine(t: CheckTotals): string {
  if (t.total === 0) return "No checks yet";
  const parts = [t.passed && `${t.passed} passed`, t.failed && `${t.failed} failed`, t.running && `${t.running} running`, t.skipped && `${t.skipped} skipped`, t.cancelled && `${t.cancelled} cancelled`].filter(Boolean);
  return `Checks: ${parts.join(", ")}`;
}

/** What one check's state is called on the card. */
export const BUCKET_WORD: Record<PrCheck["bucket"], string> = { pass: "Passed", fail: "Failed", pending: "Running", skipping: "Skipped", cancel: "Cancelled" };

/** A pull request and its checks as the loop sees them. */
export interface PrSnap {
  pr: PullRequest;
  checks: PrCheck[];
}

/**
 * One failing run of the checks: which runs failed. A new run is a new signature; a check that isn't a run Lantern can read
 * has no run number, so the commit stands in for it.
 */
export function failureSig(snap: PrSnap): string {
  const failing = snap.checks.filter((c) => c.bucket === "fail").map((c) => c.run_id ?? c.link ?? `${c.name}@${snap.pr.head_sha ?? "?"}`);
  return [...new Set(failing)].sort().join(",");
}

/**
 * idle: nothing sent. waiting: a failure was sent, and the next run of the checks is awaited. out: all the tries are used.
 * stalled: Claude finished and nothing new was pushed. stopped: the user stopped it.
 */
export type LoopStatus = "idle" | "waiting" | "out" | "stalled" | "stopped";

/** What the loop remembers about one pull request (kept, so a restart of Lantern doesn't hand out new tries). */
export interface LoopState {
  tries: number;
  status: LoopStatus;
  /** The failing run last sent to Claude, and the commit the branch was at then. */
  sentSig: string | null;
  sentHead: string | null;
  /** The failing run the user sent to Claude with the button: it needs no further telling. */
  handled: string | null;
  /** The failing run the user has been told about (a notification, an inbox row). */
  notified: string | null;
}

export const freshLoop = (): LoopState => ({ tries: 0, status: "idle", sentSig: null, sentHead: null, handled: null, notified: null });

export interface StepInput {
  setting: PrSetting;
  snap: PrSnap;
  loop: LoopState;
  /** The chat a message would go to is in the middle of a turn. */
  busy: boolean;
  /** A turn has ended since the last failure was sent (and the look is from after it). */
  turnEnded: boolean;
}

export interface StepResult {
  loop: LoopState;
  /** Send the failure to Claude now (the loop already counts it). */
  send: boolean;
  /** Tell the user (a notification and an inbox row): the checks failed and nothing is fixing them. */
  notify: boolean;
}

const sameCommit = (a: string | null, b: string | null) => a !== null && a === b;

/**
 * One look at the checks. Nothing is sent when the setting is off, the pull request isn't open, the checks are still
 * going or passed, the chat is busy, the tries are used, or no new commit followed the last try. The only thing ever sent
 * is the failure, once per failing run, and the loop counts each send as a try.
 */
export function step({ setting, snap, loop, busy, turnEnded }: StepInput): StepResult {
  const idle = { loop, send: false, notify: false };
  if (setting.mode === "off" || snap.pr.state !== "OPEN") return idle;
  const state = overall(totals(snap.checks));
  // Passed: the loop starts over for the next failure (the tries used stay counted for this pull request).
  if (state === "passed") return { ...idle, loop: loop.status === "idle" && loop.sentSig === null ? loop : { ...loop, status: loop.status === "stopped" ? "stopped" : "idle", sentSig: null, sentHead: null } };
  // Still running (or no checks): wait for them to finish.
  if (state !== "failed") return idle;

  const sig = failureSig(snap);
  const tell = (l: LoopState): StepResult => {
    const notify = l.notified !== sig && l.handled !== sig;
    return { loop: notify ? { ...l, notified: sig } : l, send: false, notify };
  };
  if (setting.mode === "tell" || loop.status === "out" || loop.status === "stalled" || loop.status === "stopped") return tell(loop);

  if (loop.sentSig !== null) {
    if (sig === loop.sentSig) {
      // The same failing run as the one sent. Claude's turn is over and the branch hasn't moved: the fix did not land.
      if (turnEnded && sameCommit(snap.pr.head_sha, loop.sentHead)) return tell({ ...loop, status: "stalled" });
      // A new commit that fails a check with no run to tell it by (the signature can't change) is a new failure; with a run,
      // the checks shown are still the old ones, so wait for the new run.
      const newCommit = snap.pr.head_sha !== loop.sentHead;
      const hasRun = snap.checks.some((c) => c.bucket === "fail" && c.run_id);
      if (!(turnEnded && newCommit && !hasRun)) return idle;
    } else if (sameCommit(snap.pr.head_sha, loop.sentHead)) {
      // Another failing run on the same commit. While Claude is still working it may yet push, so wait; once its turn is over,
      // nothing was pushed since the last try.
      return turnEnded && !busy ? tell({ ...loop, status: "stalled" }) : idle;
    }
  }
  // Wait for Claude to finish what it is doing.
  if (busy) return idle;
  if (loop.tries >= setting.tries) return tell({ ...loop, status: "out" });
  return { loop: { ...loop, tries: loop.tries + 1, status: "waiting", sentSig: sig, sentHead: snap.pr.head_sha }, send: true, notify: false };
}

/** The user stopped Fix it myself for this pull request: it falls back to Tell me. */
export const stopLoop = (loop: LoopState): LoopState => ({ ...loop, status: "stopped" });

/** The user sent the failure to Claude themselves: it needs no more telling. */
export const sentByUser = (loop: LoopState, sig: string): LoopState => ({ ...loop, handled: sig });

/**
 * Whether the checks failed and nothing is dealing with them, so the user has to: in Tell me, a failure Claude hasn't been
 * sent; in Fix it myself, once it has given up (out of tries, stalled, stopped).
 */
export function needsYou(setting: PrSetting, snap: PrSnap, loop: LoopState): boolean {
  if (setting.mode === "off" || snap.pr.state !== "OPEN" || overall(totals(snap.checks)) !== "failed") return false;
  if (loop.handled === failureSig(snap)) return false;
  return setting.mode === "tell" || loop.status === "out" || loop.status === "stalled" || loop.status === "stopped";
}

/** The visible line for Fix it myself, or null when it has nothing to say. */
export function fixLine(setting: PrSetting, loop: LoopState): { text: string; stoppable: boolean } | null {
  if (setting.mode !== "fix") return null;
  if (loop.status === "out") return { text: "Out of tries. Fixing failed checks has stopped.", stoppable: false };
  if (loop.status === "stalled") return { text: "Claude finished but nothing new was pushed, so the fix didn't land. Fixing failed checks has stopped.", stoppable: false };
  if (loop.status === "stopped") return { text: "Fixing failed checks was stopped.", stoppable: false };
  if (loop.tries === 0) return null;
  return { text: `Fixing failed checks: try ${loop.tries} of ${setting.tries}`, stoppable: loop.status === "waiting" };
}

/** How long the pull request is watched from when it was found (a push or a new turn starts the time again). */
export const WATCH_LIMIT_MS = 60 * 60 * 1000;

/** The wait before the next look: every 30 seconds at first, then less often. Null: stop watching. */
export function pollDelay(watchedMs: number): number | null {
  if (watchedMs >= WATCH_LIMIT_MS) return null;
  if (watchedMs < 5 * 60_000) return 30_000;
  if (watchedMs < 20 * 60_000) return 60_000;
  return 120_000;
}

/** Whether to keep looking: the pull request is open and its checks haven't all passed. */
export function worthWatching(snap: PrSnap): boolean {
  return snap.pr.state === "OPEN" && overall(totals(snap.checks)) !== "passed";
}

/** The pull requests' loop state, kept for the 8 newest numbers of a folder. */
export function pruneLoops(loops: Record<string, LoopState>): Record<string, LoopState> {
  const numbers = Object.keys(loops).sort((a, b) => Number(b) - Number(a));
  return Object.fromEntries(numbers.slice(0, 8).map((n) => [n, loops[n]]));
}
