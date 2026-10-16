import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { PrCheck } from "../types";
import { readStored, usePersistentState } from "./layout";
import { buildFailureMessage, MAX_FAILURES, type FailedCheck } from "./prFailure";
import { freshLoop, needsYou as needsYouFor, PR_LOOP_KEY, pollDelay, pruneLoops, sentByUser, settingFor, step, stopLoop, worthWatching, failureSig, type LoopState, type PrSetting, type PrSnap } from "./prChecks";

/** A chat the loop may talk to: where it is, and whether a message could go to it now. */
export interface PrChat {
  slot: string;
  folder: string;
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
  /** Checks finished failed and nothing is dealing with them: the user should hear of it. */
  onFailed: (folder: string, slot: string, snap: PrSnap) => void;
}

/** What the loop knows about a project's pull request, for the card and the inbox. */
export interface PrView {
  folder: string;
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
 * Watches each project's pull request while its checks aren't done (every 30 seconds at first, then less often, for up to an
 * hour), and runs the project's choice: Off, Tell me (the card and an inbox row) or Fix it myself (see `step`). Looking only
 * reads, through the GitHub CLI; the one thing sent is the failure, to a chat in the project, once per failing run.
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
  /** A failure Lantern sent, whose chat has not finished its turn yet. */
  const awaiting = useRef<Record<string, { slot: string; ran: boolean }>>({});
  const wasBusy = useRef<Record<string, boolean>>({});
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const t of Object.values(timers.current)) clearTimeout(t);
    };
  }, []);

  const setting = (folder: string) => settingFor(o.current.settings, folder);
  const watched = (folder: string) => setting(folder).mode !== "off" && o.current.chats.some((c) => c.folder === folder && c.live);
  /** The chat a message goes to: the one on screen if it is in the project, else the project's last live chat. */
  const targetOf = (folder: string) => {
    const inFolder = o.current.chats.filter((c) => c.folder === folder && c.live);
    return inFolder.find((c) => c.slot === o.current.active) ?? inFolder[inFolder.length - 1] ?? null;
  };
  const loopOf = (folder: string, number: number) => loopsRef.current[folder]?.[String(number)] ?? freshLoop();
  const commit = (folder: string, number: number, loop: LoopState) => {
    if (JSON.stringify(loopOf(folder, number)) === JSON.stringify(loop) && loopsRef.current[folder]?.[String(number)]) return;
    const all = { ...loopsRef.current, [folder]: pruneLoops({ ...loopsRef.current[folder], [String(number)]: loop }) };
    loopsRef.current = all;
    setLoops(all);
  };
  const show = (folder: string, look: Look) => {
    looksRef.current = { ...looksRef.current, [folder]: look };
    setLooks(looksRef.current);
  };

  const schedule = (folder: string) => {
    clearTimeout(timers.current[folder]);
    const snap = looksRef.current[folder]?.snap;
    if (!watched(folder) || !snap || !worthWatching(snap)) return;
    const wait = pollDelay(Date.now() - (startedAt.current[folder] ?? Date.now()));
    if (wait !== null) timers.current[folder] = setTimeout(() => void look(folder), wait);
  };

  async function look(folder: string) {
    if (inFlight.current.has(folder)) {
      again.current.add(folder);
      return;
    }
    clearTimeout(timers.current[folder]);
    inFlight.current.add(folder);
    // A turn that ended before this look counts for it; one that ends during it needs a look of its own.
    const ended = turnEnded.current[folder] === true;
    turnEnded.current[folder] = false;
    try {
      let found = null;
      try {
        found = await api.prWatch(folder);
      } catch {
        // gh failed for a reason that may pass: what was known stays, and the next look tries again
      }
      if (!alive.current || !watched(folder)) return;
      lastLook.current[folder] = Date.now();
      if (!found) return;
      if (found.kind !== "found") {
        show(folder, { snap: null, access: found.kind === "no_gh" ? "no_gh" : found.kind === "logged_out" ? "logged_out" : "ok" });
        return;
      }
      const snap: PrSnap = { pr: found.pr, checks: found.checks };
      const before = looksRef.current[folder]?.snap;
      if (!before || before.pr.number !== snap.pr.number || before.pr.head_sha !== snap.pr.head_sha) startedAt.current[folder] = Date.now();
      show(folder, { snap, access: "ok" });
      await decide(folder, snap, ended);
    } finally {
      inFlight.current.delete(folder);
      if (again.current.delete(folder)) void look(folder);
      else schedule(folder);
    }
  }

  async function decide(folder: string, snap: PrSnap, ended: boolean) {
    const s = setting(folder);
    const target = targetOf(folder);
    const res = step({ setting: s, snap, loop: loopOf(folder, snap.pr.number), busy: !target || target.busy, turnEnded: ended });
    if (!res.send) {
      commit(folder, snap.pr.number, res.loop);
      if (res.notify) o.current.onFailed(folder, target?.slot ?? "", snap);
      return;
    }
    if (!target) return;
    const failures = await collectFailures(folder, snap.checks);
    // The chat may have started a turn, or the setting changed, while the logs were read: then nothing is sent or counted yet.
    const now = targetOf(folder);
    if (!alive.current || !now || now.busy || now.slot !== target.slot || setting(folder).mode !== "fix") return;
    commit(folder, snap.pr.number, res.loop);
    awaiting.current[folder] = { slot: target.slot, ran: false };
    const note = `Lantern sent this on its own, because "Pull request checks" is set to "Fix it myself" for this project (try ${res.loop.tries} of ${s.tries}).`;
    o.current.send(target.slot, buildFailureMessage(snap.pr, failures, note));
  }

  // Watching starts when a project gets a live chat and a setting that isn't Off, and stops when it loses them.
  const watchKey = [...new Set(opts.chats.filter((c) => c.live).map((c) => c.folder))].map((f) => `${f}\u0000${setting(f).mode}`).sort().join("\n");
  useEffect(() => {
    const now = Date.now();
    const folders = [...new Set(o.current.chats.map((c) => c.folder))];
    for (const folder of folders) {
      if (watched(folder)) {
        if (looksRef.current[folder] === undefined && !inFlight.current.has(folder)) {
          startedAt.current[folder] = now;
          void look(folder);
        }
      } else {
        clearTimeout(timers.current[folder]);
        if (looksRef.current[folder]) {
          const { [folder]: _gone, ...rest } = looksRef.current;
          looksRef.current = rest;
          setLooks(rest);
        }
      }
    }
  }, [watchKey]);

  // A turn that ends may have pushed or opened a pull request: look again at once. After a failure Lantern sent, the end of
  // that turn is what tells whether the fix was pushed.
  const busyKey = opts.chats.map((c) => `${c.slot}:${c.busy ? 1 : 0}`).join(",");
  useEffect(() => {
    for (const c of o.current.chats) {
      const was = wasBusy.current[c.slot] ?? false;
      wasBusy.current[c.slot] = c.busy;
      const wait = awaiting.current[c.folder];
      if (c.busy && wait?.slot === c.slot) wait.ran = true;
      if (!was || c.busy || !watched(c.folder)) continue;
      if (wait?.slot === c.slot && wait.ran) {
        delete awaiting.current[c.folder];
        turnEnded.current[c.folder] = true;
      }
      startedAt.current[c.folder] = Date.now();
      void look(c.folder);
    }
  }, [busyKey]);

  // Back to the window, or to another chat: a push made elsewhere shows up.
  const refreshIfStale = useCallback(() => {
    const now = Date.now();
    for (const folder of new Set(o.current.chats.map((c) => c.folder))) {
      if (watched(folder) && !inFlight.current.has(folder) && now - (lastLook.current[folder] ?? 0) > REFRESH_AFTER_MS) {
        startedAt.current[folder] = now;
        void look(folder);
      }
    }
  }, []);
  useEffect(() => {
    window.addEventListener("focus", refreshIfStale);
    return () => window.removeEventListener("focus", refreshIfStale);
  }, [refreshIfStale]);
  useEffect(refreshIfStale, [opts.active]);

  const views: Record<string, PrView> = {};
  for (const [folder, l] of Object.entries(looks)) {
    const s = setting(folder);
    const loop = l.snap ? loopOf(folder, l.snap.pr.number) : freshLoop();
    views[folder] = { folder, setting: s, snap: l.snap, access: l.access, loop, needsYou: l.snap ? needsYouFor(s, l.snap, loop) : false };
  }

  /** The user stops Fix it myself for this pull request: it is Tell me from here. */
  const stop = (folder: string) => {
    const snap = looksRef.current[folder]?.snap;
    if (snap) commit(folder, snap.pr.number, stopLoop(loopOf(folder, snap.pr.number)));
  };

  /** The user's button: the failure goes to `slot` in one message, and counts as dealt with. */
  const sendFailure = async (folder: string, slot: string): Promise<void> => {
    const snap = looksRef.current[folder]?.snap;
    if (!snap) return;
    const failures = await collectFailures(folder, snap.checks);
    if (!alive.current) return;
    commit(folder, snap.pr.number, sentByUser(loopOf(folder, snap.pr.number), failureSig(snap)));
    o.current.send(slot, buildFailureMessage(snap.pr, failures));
  };

  const refresh = (folder: string) => {
    startedAt.current[folder] = Date.now();
    void look(folder);
  };

  /** A folder moved: its saved state was copied to the new path in storage, so read it again (the next save would write the old back). */
  const reloadLoops = () => {
    const all = readStored<Record<string, Record<string, LoopState>>>(PR_LOOP_KEY, {});
    loopsRef.current = all;
    setLoops(all);
  };

  return { views, stop, sendFailure, refresh, reloadLoops };
}
