import { initialState, reducer, type Action, type State, type Status } from "./store";
import type { UiEvent } from "./types";

/** A worker agent: whose it is and where it works (told by the main agent's `agent_spawned`). */
export interface AgentMeta {
  /** The main agent's slot. */
  parent: string;
  name: string;
  brief: string;
  folder: string;
  /** The worker's own branch, when it has a worktree. */
  branch: string | null;
  base: string | null;
  isolation: "worktree" | "shared";
  /** Taken off the canvas by the user: it keeps working, and comes back by itself when it needs them. Absent: on the canvas. */
  hidden?: boolean;
}

/**
 * Every open chat, by slot id, and which one is on screen. Each chat is a full `State` driven by the same reducer;
 * events and async results are routed to the chat they belong to, so a background chat keeps streaming.
 */
export interface Chats {
  active: string;
  slots: Record<string, State>;
  /** The chats that are workers of an orchestra, by slot, in the order they were started. */
  agents: Record<string, AgentMeta>;
}

export type ChatsAction =
  /** Applies `action` to one chat. */
  | { type: "in"; slot: string; action: Action }
  /** A new, empty chat that inherits the app-wide bits (claude's path, the permission mode) from the active one. */
  | { type: "add"; slot: string }
  | { type: "activate"; slot: string }
  | { type: "remove"; slot: string }
  /** A restored chat is a worker of an open main agent again (the backend adopted it): its tether and notes come back. */
  | { type: "adopt"; slot: string; meta: AgentMeta }
  /** A worker is taken off the canvas, or put back on it. */
  | { type: "set_hidden"; slot: string; hidden: boolean }
  /** A worker was closed from its card: its chat goes, and if it was on screen the main agent is. */
  | { type: "close_agent"; slot: string };

export const FIRST_SLOT = "s1";

export function initialChats(first: State = initialState): Chats {
  return { active: FIRST_SLOT, slots: { [FIRST_SLOT]: first }, agents: {} };
}

/**
 * The main agent started a worker: its chat opens now, already working on its brief, because the worker's own events
 * (tagged with its slot) start arriving before anything else could create it.
 */
function spawnWorker(chats: Chats, main: string, ev: Extract<UiEvent, { kind: "agent_spawned" }>): Chats {
  if (chats.slots[ev.worker]) return chats;
  const parent = chats.slots[main] ?? initialState;
  const worker: State = {
    ...initialState,
    claudePath: parent.claudePath,
    contextWindow: parent.contextWindow,
    mode: ev.mode,
    folder: ev.folder,
    status: "running",
    thinking: true,
    seq: 1,
    items: [{ type: "user", id: "u1", text: ev.brief, at: Date.now(), from: "main agent" }],
  };
  const meta: AgentMeta = { parent: main, name: ev.name, brief: ev.brief, folder: ev.folder, branch: ev.branch, base: ev.base, isolation: ev.isolation };
  return { ...chats, slots: { ...chats.slots, [ev.worker]: worker }, agents: { ...chats.agents, [ev.worker]: meta } };
}

export function chatsReducer(chats: Chats, action: ChatsAction): Chats {
  switch (action.type) {
    case "in": {
      const current = chats.slots[action.slot];
      if (!current) return chats; // closed while a request was in flight
      const inner = action.action;
      if (inner.type === "ui_event" && inner.event.kind === "agent_spawned") return spawnWorker(chats, action.slot, inner.event);
      return { ...chats, slots: { ...chats.slots, [action.slot]: reducer(current, inner) } };
    }
    case "add": {
      const from = chats.slots[chats.active] ?? initialState;
      const fresh: State = { ...initialState, claudePath: from.claudePath, mode: from.mode, contextWindow: from.contextWindow, status: "no_folder" };
      return { ...chats, slots: { ...chats.slots, [action.slot]: fresh } };
    }
    case "activate":
      return chats.slots[action.slot] ? { ...chats, active: action.slot } : chats;
    case "adopt":
      return chats.slots[action.slot] && chats.slots[action.meta.parent] ? { ...chats, agents: { ...chats.agents, [action.slot]: action.meta } } : chats;
    case "set_hidden": {
      const meta = chats.agents[action.slot];
      if (!meta || !!meta.hidden === action.hidden) return chats;
      const { hidden: _, ...rest } = meta;
      return { ...chats, agents: { ...chats.agents, [action.slot]: action.hidden ? { ...rest, hidden: true } : rest } };
    }
    case "close_agent": {
      const parent = chats.agents[action.slot]?.parent;
      const left = chats.active === action.slot && parent && chats.slots[parent] ? { ...chats, active: parent } : chats;
      return chatsReducer(left, { type: "remove", slot: action.slot });
    }
    case "remove": {
      if (action.slot === chats.active || !chats.slots[action.slot]) return chats;
      const { [action.slot]: _, ...rest } = chats.slots;
      const { [action.slot]: __, ...agents } = chats.agents;
      return { ...chats, slots: rest, agents };
    }
  }
}

/** Automatic turns in a row (from agents' notes, with nothing from the user between) before the notes wait for the user. */
export const WAKE_LIMIT = 8;

/**
 * The notes to send now: each main agent's pending ones, joined into one message, once it is idle. A main agent that has
 * already taken `WAKE_LIMIT` automatic turns without the user saying anything keeps them waiting instead, so a worker and
 * the main agent answering each other can't run on unwatched (see `wakesPaused`). `justSent`: chats that were sent something
 * in this same pass (their queue), which `slots` still shows idle: a second message would start a second turn on top of it.
 */
export function wakesToSend(slots: Record<string, State>, justSent: ReadonlySet<string> = new Set()): { slot: string; text: string }[] {
  return Object.entries(slots)
    .filter(([slot, s]) => !justSent.has(slot) && s.wakes.length > 0 && s.status === "idle" && s.autoStreak < WAKE_LIMIT)
    .map(([slot, s]) => ({ slot, text: s.wakes.join("\n\n") }));
}

/** Notes are waiting, but the loop guard holds them until the user writes to the main agent. */
export function wakesPaused(s: State): boolean {
  return s.wakes.length > 0 && s.autoStreak >= WAKE_LIMIT;
}

/** A chat that must not be closed when the user leaves it: it's working, waiting on them, or has messages queued. */
export function isBusy(s: State): boolean {
  return s.status === "running" || s.queued.length > 0 || s.items.some((it) => it.type === "permission" && it.decision === null);
}

/** How a background chat reads in the menu. `draft`: text typed in its box but not sent. */
export function chatState(s: State, draft = ""): "running" | "waiting" | "draft" | "done" {
  if (s.items.some((it) => it.type === "permission" && it.decision === null)) return "waiting";
  if (s.status === "running" || s.status === "starting" || s.queued.length > 0) return "running";
  return draft.trim() ? "draft" : "done";
}

/** The prompt a chat's title is made from: its first message. */
export function firstPrompt(s: State): string | null {
  const first = s.items.find((it) => it.type === "user" && !it.auto);
  return first?.type === "user" ? first.text : null;
}

/** What a chat is called in menus: its title once one is made (`titles`, by session id), until then its first prompt. */
export function chatTitle(s: State, titles: Record<string, string> = {}): string {
  return (s.sessionId && titles[s.sessionId]) || firstPrompt(s)?.split("\n")[0] || "New chat";
}

/**
 * The queued messages to send now: for each chat whose turn just ended normally (running → idle since `prev`), its
 * queue joined into one prompt. A crash or restart doesn't count, so those queues wait for the user.
 */
export function queuesToSend(prev: Record<string, Status>, slots: Record<string, State>): { slot: string; text: string }[] {
  return Object.entries(slots)
    .filter(([slot, s]) => prev[slot] === "running" && s.status === "idle" && s.queued.length > 0)
    .map(([slot, s]) => ({ slot, text: s.queued.join("\n\n") }));
}
