import { initialState, reducer, type Action, type State, type Status } from "./store";

/**
 * Every open chat, by slot id, and which one is on screen. Each chat is a full `State` driven by the same reducer;
 * events and async results are routed to the chat they belong to, so a background chat keeps streaming.
 */
export interface Chats {
  active: string;
  slots: Record<string, State>;
}

export type ChatsAction =
  /** Applies `action` to one chat. */
  | { type: "in"; slot: string; action: Action }
  /** A new, empty chat that inherits the app-wide bits (claude's path, the permission mode) from the active one. */
  | { type: "add"; slot: string }
  | { type: "activate"; slot: string }
  | { type: "remove"; slot: string };

export const FIRST_SLOT = "s1";

export function initialChats(first: State = initialState): Chats {
  return { active: FIRST_SLOT, slots: { [FIRST_SLOT]: first } };
}

export function chatsReducer(chats: Chats, action: ChatsAction): Chats {
  switch (action.type) {
    case "in": {
      const current = chats.slots[action.slot];
      if (!current) return chats; // closed while a request was in flight
      return { ...chats, slots: { ...chats.slots, [action.slot]: reducer(current, action.action) } };
    }
    case "add": {
      const from = chats.slots[chats.active] ?? initialState;
      const fresh: State = { ...initialState, claudePath: from.claudePath, mode: from.mode, contextWindow: from.contextWindow, status: "no_folder" };
      return { ...chats, slots: { ...chats.slots, [action.slot]: fresh } };
    }
    case "activate":
      return chats.slots[action.slot] ? { ...chats, active: action.slot } : chats;
    case "remove": {
      if (action.slot === chats.active || !chats.slots[action.slot]) return chats;
      const { [action.slot]: _, ...rest } = chats.slots;
      return { ...chats, slots: rest };
    }
  }
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
  return (s.sessionId && titles[s.sessionId]) || firstPrompt(s)?.split("\n")[0] || "New session";
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
