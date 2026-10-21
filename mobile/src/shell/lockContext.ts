import { createContext, useContext, useSyncExternalStore } from "react";
import { AppLock, noLockMemory, noLockPlatform, type LockState } from "../lock";

export const LockContext = createContext<AppLock | null>(null);

/** Where no real lock was given (the screens' tests): a phone that can't check anyone, with the lock off. */
const none = new AppLock(noLockPlatform, noLockMemory);

export function useAppLock(): AppLock {
  return useContext(LockContext) ?? none;
}

/** Where the lock stands: on or off, locked now, and whether the phone can check someone at all. */
export function useLockState(): LockState {
  const lock = useAppLock();
  return useSyncExternalStore(lock.subscribe, lock.getState, lock.getState);
}
