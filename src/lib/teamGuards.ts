import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { providerIdOf } from "./provider";
import type { Chats } from "../sessions";
import { nodeStatus, orchestraNodes } from "./orchestraView";
import { CONTINUE_MESSAGE, loadPauseMemory, pauseEndsAt, pauseStep, pausedLine, pauseWarning, savePauseMemory, usePauseAtPercent, windowKey, type PlanPause } from "./planPause";
import { useProviderUsage, usePlanUsage, type PlanUsage } from "./planUsage";
import type { State } from "../store";

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
 * What keeps a team from running unwatched: the pause when the plan reaches the user's limit (the setting
 * "Pause a team's work when my plan reaches"). `pause` is set while the teams are paused, and while it is set no queued message or agent's note starts a turn:
 * `resume` tells each agent that was stopped to continue, and nothing else does. The pause ends by itself when the plan's
 * window resets (nothing is told to continue: the agents stay stopped, and can be messaged), and `dismiss` ends it the same way
 * at once, for a user who doesn't want it on screen.
 */
function useProviderGuard(chats: Chats, actions: GuardActions, provider: string, plan: PlanUsage | null) {
  const pauseAt = usePauseAtPercent();
  const [pause, setPause] = useState<PlanPause | null>(null);
  const done = useRef(loadPauseMemory(provider));
  // The effects and handlers below run later than the render that made them: they read what is current from here.
  const latest = useRef({ chats, actions, pause });
  latest.current = { chats, actions, pause };

  // Pause only this provider’s agents, once per reported window.
  useEffect(() => {
    if (!plan || (plan.resetsAt !== null && plan.resetsAt * 1000 <= Date.now())) return;
    const { chats: now, actions: act } = latest.current;
    const working = teamAgentsWorking(now).filter(slot => providerIdOf(now.slots[slot].provider) === provider);
    const step = pauseStep(plan, pauseAt, working.length > 0, done.current);
    if (!step) return;
    const key = windowKey(plan);
    const percent = Math.round(plan.used * 100);
    if (step === "warn") {
      done.current = { ...done.current, warned: key };
      savePauseMemory(done.current, provider);
      act.warn(`${provider === "claude" ? "Claude" : "Codex"}: ${pauseWarning(percent, pauseAt)}`);
      return;
    }
    done.current = { paused: key, warned: key };
    savePauseMemory(done.current, provider);
    for (const slot of working) act.stop(slot);
    const next: PlanPause = { provider, percent, resetsAt: plan.resetsAt, since: Date.now(), slots: working };
    setPause((was) => (was ? { ...next, since: was.since, slots: [...new Set([...was.slots, ...working])] } : next));
    act.paused(pausedLine(next));
  }, [plan, pauseAt]);

  // The limit has reset: nothing is held back any more, so the pause card has nothing left to say.
  const endsAt = pause ? pauseEndsAt(pause) : null;
  useEffect(() => {
    if (endsAt === null) return;
    const timer = setTimeout(() => setPause(null), Math.max(0, endsAt - Date.now()));
    return () => clearTimeout(timer);
  }, [endsAt]);

  const dismiss = useCallback(() => setPause(null), []);

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

  return { pause, resume, dismiss };
}

export function useTeamGuards(chats: Chats, actions: GuardActions) {
  const fallback = usePlanUsage();
  const providers = useProviderUsage();
  const [claudePlan, codexPlan] = useMemo(() => {
    const fullestPlan = (provider: string): PlanUsage | null => {
      const windows = providers[provider]?.windows.filter(w => w.resets_at === null || w.resets_at * 1000 > Date.now()) ?? [];
      const fullest = windows.reduce<(typeof windows)[number] | null>((best, w) => !best || w.used > best.used ? w : best, null);
      return fullest ? { used: fullest.used, resetsAt: fullest.resets_at } : null;
    };
    return [fullestPlan("claude") ?? fallback, fullestPlan("codex")];
  }, [providers, fallback]);
  const claude = useProviderGuard(chats, actions, "claude", claudePlan);
  const codex = useProviderGuard(chats, actions, "codex", codexPlan);
  const first = claude.pause ? claude : codex;
  const heldProviders = new Set([claude.pause?.provider, codex.pause?.provider].filter(Boolean));
  const heldSlots = Object.entries(chats.slots).filter(([, state]) => heldProviders.has(providerIdOf(state.provider))).map(([slot]) => slot);
  return { ...first, heldSlots, pausedSlots: [...(claude.pause?.slots ?? []), ...(codex.pause?.slots ?? [])] };
}
