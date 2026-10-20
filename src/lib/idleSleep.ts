import { useEffect, useState } from "react";
import { hasPendingPrompt, type State } from "../store";
import type { Chats } from "../sessions";

/**
 * How many minutes a chat you aren't looking at may sit idle before it goes to sleep (Settings > General): its claude
 * process is stopped and its messages are dropped from memory, and it wakes, resumed, when you open it. 0 is never.
 * App-wide, like the agent limit.
 */
const KEY = "lantern.sleepMinutes";
const CHANGED = "lantern-sleep-minutes";
export const SLEEP_MINUTES_DEFAULT = 10;
export const SLEEP_MINUTES = [0, 5, 10, 20, 30, 60] as const;

export function sleepMinutes(): number {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === null) return SLEEP_MINUTES_DEFAULT;
    const n = Number(stored);
    return (SLEEP_MINUTES as readonly number[]).includes(n) ? n : SLEEP_MINUTES_DEFAULT;
  } catch {
    return SLEEP_MINUTES_DEFAULT;
  }
}

export function setSleepMinutes(n: number): void {
  if (!(SLEEP_MINUTES as readonly number[]).includes(n)) return;
  try {
    localStorage.setItem(KEY, String(n));
  } catch {
    // storage unavailable: it lasts until Lantern quits
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** The setting in minutes, kept in step with every place that changes it. */
export function useSleepMinutes(): number {
  const [n, setN] = useState(sleepMinutes);
  useEffect(() => {
    const sync = () => setN(sleepMinutes());
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, []);
  return n;
}

/**
 * Whether a chat may go to sleep now: it is resting (nothing running, queued, waiting on the user or running in the
 * background), has a conversation to come back to, and isn't one of the chats that stay awake: the one on screen, a team's
 * Lead or agent, a routine's.
 */
export function canSleep(s: State, own: { active: boolean; agent: boolean; routine: boolean; team?: boolean }): boolean {
  // A team's Lead or agent sleeps only with its whole team (`team`: it is being asked as one of its members).
  if (own.active || own.routine || (!own.team && (own.agent || s.orchestrator))) return false;
  // A merge card still open would be gone when its Lead wakes: it is the user's to answer first.
  if (s.proposals.some((p) => p.status === "open")) return false;
  if (s.status !== "idle" || s.thinking || !s.folder || !s.sessionId || s.items.length === 0) return false;
  if (s.queued.length > 0 || s.wakes.length > 0 || s.backgroundTasks.length > 0 || s.setup || hasPendingPrompt(s.items)) return false;
  // A command the user started from the box, or the project's Run command: asleep, its process would be stopped.
  if (s.run?.status === "running" || s.items.some((it) => it.type === "shell" && it.status === "running")) return false;
  // What waits to go with the next message (output of commands, files put back, a flavour picked), or to be undone: sleeping loses it.
  if (s.revertNotes.length > 0 || s.revertUndo || s.restoreUndo || s.flavourPick || s.items.some((it) => it.type === "shell" && !it.shared)) return false;
  return true;
}

/**
 * Starts the idle clock of the chats that may sleep now, forgets the clock of those that may not, and says which chats
 * have been idle for `afterMs`. `clock` is when each chat started to be idle (ms since the epoch); the new one is returned.
 */
export function sweep(clock: Record<string, number>, eligible: ReadonlySet<string>, now: number, afterMs: number): { clock: Record<string, number>; due: string[] } {
  const next: Record<string, number> = {};
  for (const slot of eligible) next[slot] = clock[slot] ?? now;
  return { clock: next, due: afterMs > 0 ? Object.keys(next).filter((slot) => now - next[slot] >= afterMs) : [] };
}

/** The members of the team `lead` is the Lead of: the Lead, then the agents it started. */
export function teamSlots(chats: Chats, lead: string): string[] {
  return [lead, ...Object.entries(chats.agents).flatMap(([slot, meta]) => (meta.parent === lead && chats.slots[slot] ? [slot] : []))];
}

/**
 * The agents that may have their claude stopped now while their team goes on: idle and resting like any member of a sleeping team,
 * with their Lead awake (a sleeping team goes as a whole) and no merge card of theirs waiting for the user. A team that checks what
 * its builders make (a reviewer and a tester are started after a build) keeps its agents awake: which of them a chain is
 * waiting on is the backend's to know, and it refuses what is in one.
 */
export function agentsAtRest(chats: Chats, routine: (slot: string) => boolean): string[] {
  return Object.entries(chats.agents).flatMap(([slot, meta]) => {
    const s = chats.slots[slot];
    const lead = chats.slots[meta.parent];
    if (!s || !lead || !lead.orchestrator || lead.status === "asleep" || lead.review.on || s.agentAsleep) return [];
    if (lead.proposals.some((p) => p.worker === slot && p.status === "open")) return [];
    return canSleep(s, { active: slot === chats.active, agent: true, routine: routine(slot), team: true }) ? [slot] : [];
  });
}

/** The members a team goes to sleep with: an agent its Lead stopped has no process to free and isn't brought back, so it stays as it is. */
export function membersToSleep(chats: Chats, lead: string): string[] {
  return teamSlots(chats, lead).filter((slot) => !(slot !== lead && chats.slots[slot].status === "ended" && chats.slots[slot].leadStopped));
}

/**
 * The Leads whose whole team may go to sleep now: every member is resting, and none of them is the chat on screen. */
export function teamsAtRest(chats: Chats, routine: (slot: string) => boolean): string[] {
  return Object.entries(chats.slots).flatMap(([lead, state]) => {
    if (!state.orchestrator || chats.agents[lead]) return [];
    const resting = membersToSleep(chats, lead).every((slot) => canSleep(chats.slots[slot], { active: slot === chats.active, agent: !!chats.agents[slot], routine: routine(slot), team: true }));
    return resting ? [lead] : [];
  });
}
