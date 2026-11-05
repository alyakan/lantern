import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { PrCheck } from "../types";
import { readStored, usePersistentState } from "./layout";
import { buildFailureMessage, MAX_FAILURES, type FailedCheck } from "./prFailure";
import { freshLoop, needsYou as needsYouFor, PR_LOOP_KEY, pollDelay, pruneLoops, sentByUser, settingFor, step, stopLoop, worthWatching, failureSig, type LoopState, type PrSetting, type PrSnap } from "./prChecks";

/** A chat the loop may talk to: where it is, and whether a message could go to it now. */
export interface PrChat {
  slot: string;
  /** Its project's folder (where the setting and the loop's state are kept). */
  folder: string;
  /** Where it works: a worktree of the project it is in, or `folder` itself. */
  work: string;
  /** Its claude is running (a message can be sent). */
  live: boolean;
  /** It is in the middle of a turn, or waits on an answer or has messages queued. */
  busy: boolean;
}

export interface PrChecksOptions {
  chats: PrChat[];
  /** The chat on screen: the one a message goes to when there is a choice. */
  active: string | null;
  /** Each project's saved setting (see settingFor). */
  settings: Record<string, Partial<PrSetting> | undefined>;
  /** Sends a message to a chat, as Lantern's own (the chat shows it like any other message). */
  send: (slot: string, text: string) => void;
  /** Starts a chat in the project's `folder` with `text` as its first message; its slot, or null when none could start. */
  start: (folder: string, text: string) => string | null;
  /** Checks finished failed and nothing is dealing with them: the user should hear of it. */
  onFailed: (folder: string, slot: string, snap: PrSnap) => void;
}

/** What the loop knows about the pull request of a place (a project's folder, or a worktree a chat works in), for the card and the inbox. */
export interface PrView {
  /** The project the place belongs to. */
  folder: string;
  /** Where the pull request was looked up: its branch is checked out there. */
  place: string;
  setting: PrSetting;
  /** The pull request and its checks; null: none found (or gh can't be used: see `access`). */
  snap: PrSnap | null;
  access: "ok" | "no_gh" | "logged_out";
  loop: LoopState;
  needsYou: boolean;
}

/** How soon after the last look a window focus or a chat switch looks again. */
const REFRESH_AFTER_MS = 60_000;

interface Look {
  snap: PrSnap | null;
  access: PrView["access"];
}

/** The failed checks as the message has them: one entry per run, with the end of its log. */
async function collectFailures(folder: string, checks: PrCheck[]): Promise<FailedCheck[]> {
  const failing = checks.filter((c) => c.bucket === "fail");
  const groups = new Map<string, PrCheck[]>();
  for (const c of failing) groups.set(c.run_id ?? `check:${c.name}`, [...(groups.get(c.run_id ?? `check:${c.name}`) ?? []), c]);
  const out: FailedCheck[] = [];
  for (const group of [...groups.values()].slice(0, MAX_FAILURES)) {
    const first = group[0];
    const check = group.length > 1 ? { ...first, name: group.map((c) => c.name).join(", ") } : first;
    if (!first.run_id) {
      out.push({ check, log: null, logError: "this check isn't a GitHub Actions run" });
      continue;
    }
    try {
      out.push({ check, log: await api.prFailureLog(folder, first.run_id), logError: null });
    } catch (e) {
      out.push({ check, log: null, logError: String(e instanceof Error ? e.message : e) });
    }
  }
  return out;
}

/**
 * Watches the pull request of each place a chat works in (its project's folder, or a worktree of it) while its checks
 * aren't done (every 30 seconds at first, then less often, for up to an hour), and runs the project's choice: Off, Tell me
 * (the card and an inbox row) or Fix it myself (see `step`). Looking only reads, through the GitHub CLI; the one thing sent
 * is the failure, once per failing run, to the chat working on the pull request: the one that had the last try, else one
 * in a worktree where the pull request was found (or the project's folder's only chat, when the folder is on it), else a
 * new chat Lantern starts in the project: being in the project doesn't make a chat the pull request's.
 */
export function usePrChecks(opts: PrChecksOptions) {
  const o = useRef(opts);
  o.current = opts;
  const [looks, setLooks] = useState<Record<string, Look>>({});
  const looksRef = useRef<Record<string, Look>>({});
  const [loops, setLoops] = usePersistentState<Record<string, Record<string, LoopState>>>("prChecks.loopByFolder", {});
  const loopsRef = useRef(loops);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const inFlight = useRef(new Set<string>());
  const again = useRef(new Set<string>());
  const startedAt = useRef<Record<string, number>>({});
  const lastLook = useRef<Record<string, number>>({});
  const turnEnded = useRef<Record<string, boolean>>({});
  /** A failure Lantern sent, by place, whose chat has not finished its turn yet. */
  const awaiting = useRef<Record<string, { slot: string; ran: boolean }>>({});
  /** The chat each pull request's last try went to (by project and number): the next try goes there too. */
  const owners = useRef<Record<string, string>>({});
  /** Pull requests whose failure is being sent (its logs read), so a second place finding the same one waits. */
  const sending = useRef(new Set<string>());
  const wasBusy = useRef<Record<string, boolean>>({});
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const t of Object.values(timers.current)) clearTimeout(t);
    };
  }, []);

  const live = () => o.current.chats.filter((c) => c.live);
  /** The project a place belongs to: the folder of a live chat that is, or works, there. */
  const folderOf = (place: string) => live().find((c) => c.folder === place)?.folder ?? live().find((c) => c.work === place)?.folder ?? null;
  const places = () => [...new Set(live().flatMap((c) => [c.folder, c.work]))];
  const setting = (folder: string) => settingFor(o.current.settings, folder);
  const watched = (place: string) => {
    const folder = folderOf(place);
    return folder !== null && setting(folder).mode !== "off";
  };
  const prKey = (folder: string, number: number) => `${folder}\u0000${number}`;
  /**
   * The chat a failure of pull request `number` goes to: the one its last try went to while it is open, else a chat working
   * in a worktree of the project where that pull request was found (the one on screen if it is one of them, else the last).
   * `pending`: a chat's worktree hasn't been looked at yet, so it may still turn out to be on the pull request.
   */
  const targetOf = (folder: string, number: number): { chat: PrChat | null; pending: boolean } => {
    const owner = owners.current[prKey(folder, number)];
    const had = live().find((c) => c.slot === owner);
    if (had) return { chat: had, pending: false };
    const inWorktrees = live().filter((c) => c.folder === folder && c.work !== folder);
    const on = inWorktrees.filter((c) => looksRef.current[c.work]?.snap?.pr.number === number);
    // The project's folder itself on the branch (no worktrees): its chat when it is the only one there; with more, none of
    // them is known to be the pull request's.
    const inFolder = live().filter((c) => c.folder === folder && c.work === folder);
    if (looksRef.current[folder]?.snap?.pr.number === number && inFolder.length === 1) on.push(inFolder[0]);
    const chat = on.find((c) => c.slot === o.current.active) ?? on[on.length - 1] ?? null;
    return { chat, pending: !chat && inWorktrees.some((c) => lastLook.current[c.work] === undefined) };
  };
  const loopOf = (folder: string, number: number) => loopsRef.current[folder]?.[String(number)] ?? freshLoop();
  const commit = (folder: string, number: number, loop: LoopState) => {
    if (JSON.stringify(loopOf(folder, number)) === JSON.stringify(loop) && loopsRef.current[folder]?.[String(number)]) return;
    const all = { ...loopsRef.current, [folder]: pruneLoops({ ...loopsRef.current[folder], [String(number)]: loop }) };
    loopsRef.current = all;
    setLoops(all);
  };
  const show = (place: string, look: Look) => {
    looksRef.current = { ...looksRef.current, [place]: look };
    setLooks(looksRef.current);
  };

  const schedule = (place: string) => {
    clearTimeout(timers.current[place]);
    const snap = looksRef.current[place]?.snap;
    if (!watched(place) || !snap || !worthWatching(snap)) return;
    const wait = pollDelay(Date.now() - (startedAt.current[place] ?? Date.now()));
    if (wait !== null) timers.current[place] = setTimeout(() => void look(place), wait);
  };

  async function look(place: string) {
    if (inFlight.current.has(place)) {
      again.current.add(place);
      return;
    }
    clearTimeout(timers.current[place]);
    inFlight.current.add(place);
    // A turn that ended before this look counts for it; one that ends during it needs a look of its own. The signal is kept
    // until a look decides with it (gh failing or no pull request found leaves it for the next look).
    const ended = turnEnded.current[place] === true;
    turnEnded.current[place] = false;
    let decided = false;
    try {
      let found = null;
      try {
        found = await api.prWatch(place);
      } catch {
        // gh failed for a reason that may pass: what was known stays, and the next look tries again
      }
      if (!alive.current || !watched(place)) return;
      lastLook.current[place] = Date.now();
      if (!found) return;
      if (found.kind !== "found") {
        show(place, { snap: null, access: found.kind === "no_gh" ? "no_gh" : found.kind === "logged_out" ? "logged_out" : "ok" });
        return;
      }
      const snap: PrSnap = { pr: found.pr, checks: found.checks };
      const before = looksRef.current[place]?.snap;
      if (!before || before.pr.number !== snap.pr.number || before.pr.head_sha !== snap.pr.head_sha) startedAt.current[place] = Date.now();
      show(place, { snap, access: "ok" });
      decided = true;
      await decide(place, snap, ended);
    } finally {
      if (ended && !decided) turnEnded.current[place] = true;
      inFlight.current.delete(place);
      if (again.current.delete(place)) void look(place);
      else schedule(place);
      // A worktree's look may have been what the project's folder waited for (see targetOf's `pending`).
      const folder = folderOf(place);
      const waiting = folder !== null && folder !== place ? looksRef.current[folder]?.snap : null;
      if (folder && waiting && alive.current && watched(folder) && !inFlight.current.has(folder)) void decide(folder, waiting, false);
    }
  }

  async function decide(place: string, snap: PrSnap, ended: boolean) {
    const folder = folderOf(place);
    if (folder === null) return;
    const key = prKey(folder, snap.pr.number);
    if (sending.current.has(key)) return;
    const s = setting(folder);
    const { chat: target, pending } = targetOf(folder, snap.pr.number);
    // With no chat on the pull request a new one is started, so there is nothing to wait for, unless a worktree's look may
    // still find one: the look that ends there decides.
    const res = step({ setting: s, snap, loop: loopOf(folder, snap.pr.number), busy: target ? target.busy : pending, turnEnded: ended });
    if (!res.send) {
      commit(folder, snap.pr.number, res.loop);
      if (res.notify) o.current.onFailed(folder, target?.slot ?? "", snap);
      return;
    }
    sending.current.add(key);
    try {
      const failures = await collectFailures(place, snap.checks);
      // The chat may have started a turn, or the setting changed, while the logs were read: then nothing is sent or counted yet.
      const now = targetOf(folder, snap.pr.number).chat;
      if (!alive.current || now?.slot !== target?.slot || now?.busy || setting(folder).mode !== "fix") return;
      const note = `Lantern sent this on its own, because "Pull request checks" is set to "Fix it myself" for this project (try ${res.loop.tries} of ${s.tries}).`;
      const text = buildFailureMessage(snap.pr, failures, note);
      // No chat on it: a worktree is only looked at while a chat works there, so this is the project's folder.
      const slot = target ? target.slot : o.current.start(folder, text);
      // None could start (Claude isn't ready): nothing was sent, so no try is used and the next look tries again.
      if (slot === null) return;
      // Counted in the same step as the start (nothing awaits between them), so a look while the chat opens doesn't start another.
      commit(folder, snap.pr.number, res.loop);
      owners.current[key] = slot;
      awaiting.current[place] = { slot, ran: false };
      if (target) o.current.send(slot, text);
    } finally {
      sending.current.delete(key);
    }
  }

  // Watching starts when a place gets a live chat in a project whose setting isn't Off, and stops when it loses them.
  const watchKey = places()
    .map((p) => `${p}\u0000${watched(p) ? 1 : 0}`)
    .sort()
    .join("\n");
  useEffect(() => {
    const now = Date.now();
    const on = places();
    for (const place of new Set([...on, ...Object.keys(looksRef.current)])) {
      if (on.includes(place) && watched(place)) {
        if (looksRef.current[place] === undefined && !inFlight.current.has(place)) {
          startedAt.current[place] = now;
          void look(place);
        }
      } else {
        clearTimeout(timers.current[place]);
        if (looksRef.current[place]) {
          const { [place]: _gone, ...rest } = looksRef.current;
          looksRef.current = rest;
          setLooks(rest);
        }
      }
    }
  }, [watchKey]);

  // A turn that ends may have pushed or opened a pull request: look again at once where the chat is and works. After a
  // failure Lantern sent, the end of that chat's turn is what tells whether the fix was pushed.
  const busyKey = opts.chats.map((c) => `${c.slot}:${c.busy ? 1 : 0}`).join(",");
  useEffect(() => {
    for (const c of o.current.chats) {
      const was = wasBusy.current[c.slot] ?? false;
      wasBusy.current[c.slot] = c.busy;
      const waits = Object.entries(awaiting.current).filter(([, w]) => w.slot === c.slot);
      if (c.busy) for (const [, w] of waits) w.ran = true;
      if (!was || c.busy) continue;
      for (const [place, w] of waits) {
        if (!w.ran) continue;
        delete awaiting.current[place];
        turnEnded.current[place] = true;
        startedAt.current[place] = Date.now();
        void look(place);
      }
      for (const place of new Set([c.folder, c.work])) {
        if (!watched(place) || waits.some(([p]) => p === place)) continue;
        startedAt.current[place] = Date.now();
        void look(place);
      }
    }
  }, [busyKey]);

  // Back to the window, or to another chat: a push made elsewhere shows up.
  const refreshIfStale = useCallback(() => {
    const now = Date.now();
    for (const place of places()) {
      if (watched(place) && !inFlight.current.has(place) && now - (lastLook.current[place] ?? 0) > REFRESH_AFTER_MS) {
        startedAt.current[place] = now;
        void look(place);
      }
    }
  }, []);
  useEffect(() => {
    window.addEventListener("focus", refreshIfStale);
    return () => window.removeEventListener("focus", refreshIfStale);
  }, [refreshIfStale]);
  useEffect(refreshIfStale, [opts.active]);

  const views: Record<string, PrView> = {};
  for (const [place, l] of Object.entries(looks)) {
    const folder = folderOf(place);
    if (folder === null) continue;
    const s = setting(folder);
    const loop = l.snap ? loopOf(folder, l.snap.pr.number) : freshLoop();
    views[place] = { folder, place, setting: s, snap: l.snap, access: l.access, loop, needsYou: l.snap ? needsYouFor(s, l.snap, loop) : false };
  }

  /** The user stops Fix it myself for the pull request found at `place`: it is Tell me from here. */
  const stop = (place: string) => {
    const snap = looksRef.current[place]?.snap;
    const folder = folderOf(place);
    if (snap && folder !== null) commit(folder, snap.pr.number, stopLoop(loopOf(folder, snap.pr.number)));
  };

  /** The user's button: the failure found at `place` goes to `slot` in one message, and counts as dealt with. */
  const sendFailure = async (place: string, slot: string): Promise<void> => {
    const snap = looksRef.current[place]?.snap;
    const folder = folderOf(place);
    if (!snap || folder === null) return;
    const failures = await collectFailures(place, snap.checks);
    if (!alive.current) return;
    commit(folder, snap.pr.number, sentByUser(loopOf(folder, snap.pr.number), failureSig(snap)));
    o.current.send(slot, buildFailureMessage(snap.pr, failures));
  };

  const refresh = (place: string) => {
    startedAt.current[place] = Date.now();
    void look(place);
  };

  /** A folder moved: its saved state was copied to the new path in storage, so read it again (the next save would write the old back). */
  const reloadLoops = () => {
    const all = readStored<Record<string, Record<string, LoopState>>>(PR_LOOP_KEY, {});
    loopsRef.current = all;
    setLoops(all);
  };

  return { views, stop, sendFailure, refresh, reloadLoops };
}
