import { useCallback, useEffect, useRef, useState } from "react";
import type { Chats } from "../sessions";
import { anythingWorking } from "./awake";
import { nodeStatus, orchestraNodes } from "./orchestraView";
import { CONTINUE_MESSAGE, loadPauseMemory, pauseStep, pausedLine, pauseWarning, savePauseMemory, usePauseAtPercent, windowKey, type PlanPause } from "./planPause";
import { usePlanUsage } from "./planUsage";
import { quietFor } from "./quiet";
import { useQuietAfter } from "./quietSetting";
import type { State } from "../store";

/** How often the app looks again for agents that have gone quiet, which no event announces. */
const LOOK_MS = 10_000;

/** What the guards do to chats and to the user; the app's own functions. */
export interface GuardActions {
  /** Interrupts the chat's turn (it stays open and can be messaged). */
  stop(slot: string): void;
  send(slot: string, text: string): void;
  queue(slot: string, items: string[]): void;
  /** A heads-up that the plan is close to the limit. */
  warn(text: string): void;
  /** The teams were just paused. */
  paused(text: string): void;
}

/** The chats of every team (Leads and agents) that are working now. */
export function teamAgentsWorking(chats: Chats): string[] {
  return orchestraNodes(chats, () => "").filter((n) => chats.slots[n.slot] && nodeStatus(chats.slots[n.slot]) === "working").map((n) => n.slot);
}

/** The chat sits where an interrupt left it: its latest turn was stopped and nothing has been said to it since. */
function stoppedAtRest(s: State): boolean {
  const at = s.items.map((it) => it.type).lastIndexOf("turn");
  const turn = s.items[at];
  return turn?.type === "turn" && turn.stopped && !s.items.slice(at + 1).some((it) => it.type === "user");
}

/**
 * The two things that keep a team from running unwatched: the pause when the plan reaches the user's limit (the setting
 * "Pause a team's work when my plan reaches"), and the clock the inbox uses to list agents that have gone quiet.
 * `pause` is set while the teams are paused, and while it is set no queued message or agent's note starts a turn:
 * `resume` tells each agent that was stopped to continue, and nothing else does.
 */
export function useTeamGuards(chats: Chats, actions: GuardActions) {
  const plan = usePlanUsage();
  const pauseAt = usePauseAtPercent();
  const quietAfter = useQuietAfter();
  const [pause, setPause] = useState<PlanPause | null>(null);
  const done = useRef(loadPauseMemory());
  // The effects and handlers below run later than the render that made them: they read what is current from here.
  const latest = useRef({ chats, actions, pause });
  latest.current = { chats, actions, pause };

  // Each reading of the plan: pause the teams once per window when it reaches the limit, warn once 5 points before.
  useEffect(() => {
    if (!plan) return;
    const { chats: now, actions: act } = latest.current;
    const working = teamAgentsWorking(now);
    const step = pauseStep(plan, pauseAt, working.length > 0, done.current);
    if (!step) return;
    const key = windowKey(plan);
    const percent = Math.round(plan.used * 100);
    if (step === "warn") {
      done.current = { ...done.current, warned: key };
      savePauseMemory(done.current);
      act.warn(pauseWarning(percent, pauseAt));
      return;
    }
    done.current = { paused: key, warned: key };
    savePauseMemory(done.current);
    for (const slot of working) act.stop(slot);
    const next: PlanPause = { percent, resetsAt: plan.resetsAt, since: Date.now(), slots: working };
    setPause((was) => (was ? { ...next, since: was.since, slots: [...new Set([...was.slots, ...working])] } : next));
    act.paused(pausedLine(next));
  }, [plan, pauseAt]);

  const resume = useCallback(() => {
    const { chats: now, actions: act, pause: paused } = latest.current;
    if (!paused) return;
    for (const slot of paused.slots) {
      const s = now.slots[slot];
      if (!s) continue;
      if (s.status === "idle" && stoppedAtRest(s)) {
        // What was queued for it while it was stopped goes along, so nothing waits behind a stopped agent.
        act.send(slot, [CONTINUE_MESSAGE, ...s.queued].join("\n\n"));
        if (s.queued.length > 0) act.queue(slot, []);
      } else if (s.status === "running" && s.stopRequested) {
        // Its interrupt hasn't landed yet: the message goes out when its turn ends.
        act.queue(slot, [...s.queued, CONTINUE_MESSAGE]);
      }
    }
    setPause(null);
  }, []);

  // The inbox lists an agent once it has been quiet for the user's time. That moment is not an event, so the app looks
  // again every few seconds while something works, and redraws only when the set of quiet agents has changed.
  const working = anythingWorking(chats);
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (!working) return;
    const quietNow = (at: number) =>
      Object.entries(latest.current.chats.slots)
        .filter(([, s]) => quietFor(s, at, quietAfter) !== null)
        .map(([slot]) => slot)
        .join(",");
    const timer = setInterval(() => setClock((was) => {
      const at = Date.now();
      return quietNow(was) === quietNow(at) ? was : at;
    }), LOOK_MS);
    return () => clearInterval(timer);
  }, [working, quietAfter]);

  return { pause, resume, quiet: { now: clock, after: quietAfter } };
}
