import { createContext, createElement, useContext, useSyncExternalStore, type ReactNode } from "react";
import { noMemory, noPlatform, TipJar, type TipState } from "../tips";
import { AccentContext, EMBER } from "../ui/accent";

export const TipsContext = createContext<TipJar | null>(null);

/** Where no real tip jar was given (the screens' tests): a store with nothing in it. */
const none = new TipJar(noPlatform, noMemory);

export function useTipJar(): TipJar {
  return useContext(TipsContext) ?? none;
}

/** Where the tip jar stands: the tips and pledges, whether one is being bought, and when the last tip was given. */
export function useTips(): TipState {
  const jar = useTipJar();
  return useSyncExternalStore(jar.subscribe, jar.getState, jar.getState);
}

/** Gives everything inside the accent a regular (a running pledge) gets, Ember, and the usual cobalt to everyone else. */
export function AccentFromPledge({ children }: { children: ReactNode }) {
  const { pledger } = useTips();
  return createElement(AccentContext.Provider, { value: pledger ? EMBER : null }, children);
}
