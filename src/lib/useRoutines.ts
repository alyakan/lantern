import { useEffect, useMemo, useRef, useState } from "react";
import type { State } from "../store";
import { nodeStatus } from "./orchestraView";
import { usePlanUsage } from "./planUsage";
import {
  MAX_NAME,
  MAX_ROUTINES,
  ROUTINES_KEY,
  TICK_MS,
  draftProblem,
  newRoutine,
  nextRun,
  planUsedNow,
  readRoutines,
  routineTitles,
  runNow,
  settleStale,
  tick,
  updateRun,
  withEnabled,
  withPause,
  type Routine,
  type RunOutcome,
} from "./routines";

/** What the form holds. */
export type Draft = Pick<Routine, "name" | "folder" | "prompt" | "schedule" | "permissions" | "model">;

/** How long a routine's chat may take to be ready for its prompt before the run is given up as failed. */
const START_WAIT_MS = 2 * 60_000;

/** A run being followed: the chat it is in, and whether its prompt has gone yet. */
interface Follow {
  routine: string;
  at: number;
  prompt: string;
  slot: string;
  sent: boolean;
  /** The chat has been seen open, so its being gone means it was closed. */
  seen: boolean;
  since: number;
  session: string | null;
  outcome: RunOutcome;
}

export interface RoutinesOptions {
  /** claude was found, so chats can start. */
  ready: boolean;
  chats: Record<string, State>;
  /** Opens a chat for a routine (in the background, with its Permissions and model) and resolves to its slot; rejects with the reason in plain words. */
  open: (routine: Routine) => Promise<string>;
  /** Sends the prompt as the chat's first message. */
  send: (slot: string, text: string) => void;
}

const readSaved = (): Routine[] => {
  try {
    return settleStale(readRoutines(JSON.parse(localStorage.getItem(ROUTINES_KEY) ?? "null")));
  } catch {
    return [];
  }
};

let counter = 0;
const newId = () => `rt${Date.now().toString(36)}${(++counter).toString(36)}`;
const reason = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : "it didn't start");

/**
 * The routines, and the scheduler that runs them while Lantern is open: it looks every 30 seconds and when the window
 * wakes (see `tick`), starts the ones that are due by opening a chat for each, and follows each run until its chat has
 * finished, so the history says how it ended. Saved as they change.
 */
export function useRoutines({ ready, chats, open, send }: RoutinesOptions) {
  const [routines, setRoutines] = useState<Routine[]>(readSaved);
  const ref = useRef(routines);
  const plan = usePlanUsage();
  const live = useRef({ ready, chats, open, send, plan });
  live.current = { ready, chats, open, send, plan };
  const follows = useRef(new Map<string, Follow>());

  const commit = (next: Routine[]) => {
    ref.current = next;
    setRoutines(next);
    try {
      localStorage.setItem(ROUTINES_KEY, JSON.stringify(next));
    } catch {
      // storage unavailable: they just won't survive a restart
    }
  };
  const update = (change: (all: Routine[]) => Routine[]) => commit(change(ref.current));
  const patch = (id: string, at: number, change: Parameters<typeof updateRun>[2]) => update((all) => all.map((r) => (r.id === id ? updateRun(r, at, change) : r)));

  /** Follows each run: sends the prompt once its chat is ready, and writes down how it is going and how it ended. */
  const settle = () => {
    const now = Date.now();
    for (const [key, f] of follows.current) {
      const s = live.current.chats[f.slot];
      const end = (outcome: RunOutcome, note?: string) => {
        follows.current.delete(key);
        patch(f.routine, f.at, { outcome, ...(note ? { note } : {}) });
      };
      if (!s) {
        if (f.seen) end("stopped", "the chat was closed");
        else if (now - f.since > START_WAIT_MS) end("failed", "the chat didn't open");
        continue;
      }
      f.seen = true;
      if (s.sessionId && f.session !== s.sessionId) {
        f.session = s.sessionId;
        patch(f.routine, f.at, { sessionId: s.sessionId });
      }
      const status = nodeStatus(s);
      const problem = s.banner?.kind === "error" ? s.banner.text : null;
      if (!f.sent) {
        if (s.status === "idle") {
          f.sent = true;
          live.current.send(f.slot, f.prompt);
        } else if (status === "ended" || status === "failed") end("failed", problem ?? "Claude didn't start");
        else if (now - f.since > START_WAIT_MS) end("failed", "Claude took too long to start");
        continue;
      }
      // A stop that restarts claude (Stop that made it exit) is on its way back, not the end.
      if (status === "ended" && s.stopRequested) continue;
      if (status === "failed") end("failed", problem ?? undefined);
      else if (status === "ended") end("stopped");
      else if (status === "waiting" || status === "working" || status === "starting") {
        const outcome: RunOutcome = status === "waiting" ? "waiting" : "running";
        if (f.outcome !== outcome) {
          f.outcome = outcome;
          patch(f.routine, f.at, { outcome });
        }
      } else if (s.items.some((it) => it.type === "user")) end("done");
    }
  };

  /** Opens the chat for the run just put at the top of a routine's history, and follows it. */
  const begin = (id: string) => {
    const r = ref.current.find((x) => x.id === id);
    const run = r?.runs[0];
    if (!r || !run || run.outcome !== "running") return;
    live.current.open(r).then(
      (slot) => {
        follows.current.set(`${id}:${run.at}`, { routine: id, at: run.at, prompt: r.prompt, slot, sent: false, seen: false, since: Date.now(), session: null, outcome: "running" });
        settle();
      },
      (e) => patch(id, run.at, { outcome: "failed", note: reason(e) }),
    );
  };

  const look = () => {
    const { ready, plan } = live.current;
    const now = Date.now();
    const out = tick(ref.current, { now, planUsed: planUsedNow(plan, now), ready });
    if (out.routines.some((r, i) => r !== ref.current[i])) commit(out.routines);
    for (const id of out.start) begin(id);
    settle();
  };

  useEffect(() => {
    // What was settled at launch (runs that were working when Lantern closed) is saved too.
    commit(ref.current);
    // Also when the window comes back: a Mac that slept doesn't run its timers, and what was due then is missed, not late.
    const wake = () => document.visibilityState !== "hidden" && look();
    const timer = setInterval(look, TICK_MS);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);
  // Once claude is found, what is due can start.
  useEffect(() => {
    if (ready) look();
  }, [ready]);
  useEffect(settle, [chats]);

  const titles = useMemo(() => routineTitles(routines), [routines]);

  return {
    routines,
    /** Chats routines started, by session id: "Routine: name". */
    titles,
    /** The routines as a move of a folder left them (see migrateFolderState). */
    replace: (list: unknown) => commit(readRoutines(list)),
    /** Adds a routine; resolves to what is wrong with the draft, or null. */
    add: (draft: Draft): string | null => {
      if (ref.current.length >= MAX_ROUTINES) return `There can be ${MAX_ROUTINES} routines at most.`;
      const problem = draftProblem(draft);
      if (problem) return problem;
      update((all) => [...all, newRoutine({ ...draft, name: draft.name.trim().slice(0, MAX_NAME) }, newId(), Date.now())]);
      return null;
    },
    edit: (id: string, draft: Draft): string | null => {
      const problem = draftProblem(draft);
      if (problem) return problem;
      update((all) =>
        all.map((r) => {
          if (r.id !== id) return r;
          const changed = JSON.stringify(r.schedule) !== JSON.stringify(draft.schedule);
          const { folder, prompt, schedule, permissions, model } = draft;
          return { ...r, folder, prompt, schedule, permissions, model, name: draft.name.trim().slice(0, MAX_NAME), nextAt: changed && r.enabled ? nextRun(schedule, Date.now()) : r.nextAt };
        }),
      );
      return null;
    },
    remove: (id: string) => {
      for (const [key, f] of follows.current) if (f.routine === id) follows.current.delete(key);
      update((all) => all.filter((r) => r.id !== id));
    },
    enable: (id: string, on: boolean) => update((all) => all.map((r) => (r.id === id ? withEnabled(r, on, Date.now()) : r))),
    pause: (id: string, pause: boolean) => update((all) => all.map((r) => (r.id === id ? withPause(r, pause, Date.now()) : r))),
    /** Starts a run now; resolves to why it can't, or null. */
    runNow: (id: string): string | null => {
      const { ready, plan } = live.current;
      const now = Date.now();
      const out = runNow(ref.current, id, { now, planUsed: planUsedNow(plan, now), ready });
      if (out.error) return out.error;
      commit(out.routines);
      begin(id);
      return null;
    },
  };
}

export type Routines = ReturnType<typeof useRoutines>;
