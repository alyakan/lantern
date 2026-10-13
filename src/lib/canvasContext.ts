import { createContext, useContext, useRef, useSyncExternalStore } from "react";
import type { State } from "../store";

/**
 * Every open chat's state, for the canvas: each agent on it subscribes to its own chat, so a streaming reply in one agent
 * redraws that agent and nothing else (and panning, zooming or dragging redraws none of them).
 */
export interface ChatStore {
  get(slot: string): State | undefined;
  /** Replaces the chats without telling anyone: for the render that has them, so what its children read is current. */
  assign(slots: Record<string, State>): void;
  /** Tells subscribers the chats changed; only those whose own chat is a different object redraw. */
  notify(): void;
  /** Both: replace the chats and tell subscribers. */
  set(slots: Record<string, State>): void;
  subscribe(listener: () => void): () => void;
}

export function createChatStore(): ChatStore {
  let slots: Record<string, State> = {};
  const listeners = new Set<() => void>();
  const store: ChatStore = {
    get: (slot) => slots[slot],
    assign(next) {
      slots = next;
    },
    notify() {
      listeners.forEach((l) => l());
    },
    set(next) {
      if (next === slots) return;
      slots = next;
      store.notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return store;
}

export const ChatStoreContext = createContext<ChatStore>(createChatStore());

/** The state of one chat, redrawing only when that chat changes. */
export function useChatState(slot: string): State | undefined {
  const store = useContext(ChatStoreContext);
  return useSyncExternalStore(store.subscribe, () => store.get(slot), () => store.get(slot));
}

/** Several chats' states at once, redrawing when any of them changes (for the team list and totals, not for each agent). */
export function useChatStates(slots: string[]): (State | undefined)[] {
  const store = useContext(ChatStoreContext);
  const last = useRef<(State | undefined)[]>([]);
  // The same array while nothing changed, which is what useSyncExternalStore needs to not redraw in a loop.
  const snapshot = () => {
    const next = slots.map((s) => store.get(s));
    if (next.length === last.current.length && next.every((s, i) => s === last.current[i])) return last.current;
    last.current = next;
    return next;
  };
  return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}

/** What an agent on the canvas can do, for whichever chat it is. Stable for the app's life, so agents needn't redraw for it. */
export interface NodeActions {
  send(slot: string, text: string): void;
  stop(slot: string): void;
  /** Messages typed while the agent works, sent together when its turn ends. */
  queue(slot: string, items: string[]): void;
  decide(slot: string, id: string, allow: boolean, note?: string, answered?: Record<string, unknown>): void;
  openFile(slot: string, path: string): void;
  openTestRun(slot: string, id: string): void;
  stopShell(slot: string, id: string): void;
  shellInput(slot: string, id: string, text: string): void;
  /** Starts the agent again after it stopped. */
  restart(slot: string): void;
  /** The user's answer to a worker's merge proposal: merge its branch into the main checkout, or not yet. */
  approveMerge(worker: string): void;
  declineMerge(worker: string): void;
  /** Removes a merged worker's worktree; rejects with why it couldn't. */
  removeWorktree(worker: string): Promise<void>;
}

export const NodeActionsContext = createContext<NodeActions | null>(null);

export function useNodeActions(): NodeActions {
  const actions = useContext(NodeActionsContext);
  if (!actions) throw new Error("An agent on the canvas needs NodeActionsContext");
  return actions;
}
