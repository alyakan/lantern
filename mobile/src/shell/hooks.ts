import { createContext, useContext, useRef, useSyncExternalStore } from "react";
import type { ConnectionState } from "../net/connection";
import type { State } from "../sync/reducer";
import type { Controller } from "./controller";

export const ControllerContext = createContext<Controller | null>(null);

export function useController(): Controller {
  const c = useContext(ControllerContext);
  if (!c) throw new Error("No Lantern controller: the screens run inside the app's provider.");
  return c;
}

/** What the Mac has told this phone: chats, what waits, and each followed chat. */
export function useSyncState(): State {
  const { sync } = useController();
  return useSyncExternalStore(sync.subscribe, sync.getState, sync.getState);
}

/**
 * The part of what the Mac has told this phone that a screen draws, picked by `pick` (whose fields are compared one by one):
 * the screen draws again only when one of them changes, not for everything any chat does. `key` says what `pick` picks for
 * (a chat's slot): a new one picks afresh.
 */
export function useSyncPick<T extends Record<string, unknown>>(key: string, pick: (s: State) => T): T {
  const { sync } = useController();
  const last = useRef<{ key: string; state: State; value: T } | null>(null);
  const get = () => {
    const state = sync.getState();
    const was = last.current;
    if (was && was.key === key && was.state === state) return was.value;
    const value = pick(state);
    const same = was && was.key === key && Object.keys(value).length === Object.keys(was.value).length && Object.keys(value).every((k) => Object.is(value[k], was.value[k]));
    last.current = { key, state, value: same ? was.value : value };
    return last.current.value;
  };
  return useSyncExternalStore(sync.subscribe, get, get);
}

/** This phone's id on the Mac's list, to tell its own answers from the Mac's and other phones'. */
export function useDeviceId(): string | null {
  const c = useController();
  return useSyncExternalStore(c.subscribeConnection, c.getDeviceId, c.getDeviceId);
}

export function useConnectionState(): ConnectionState {
  const c = useController();
  return useSyncExternalStore(c.subscribeConnection, c.getConnection, c.getConnection);
}
