import { createContext, useContext, useSyncExternalStore } from "react";
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

/** This phone's id on the Mac's list, to tell its own answers from the Mac's and other phones'. */
export function useDeviceId(): string | null {
  const c = useController();
  return useSyncExternalStore(c.subscribeConnection, c.getDeviceId, c.getDeviceId);
}

export function useConnectionState(): ConnectionState {
  const c = useController();
  return useSyncExternalStore(c.subscribeConnection, c.getConnection, c.getConnection);
}
