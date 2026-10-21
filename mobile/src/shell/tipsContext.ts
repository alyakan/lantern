import { createContext, useContext, useSyncExternalStore } from "react";
import { noPlatform, TipJar, type TipState } from "../tips";

export const TipsContext = createContext<TipJar | null>(null);

/** Where no real tip jar was given (the screens' tests): a store with nothing in it. */
const none = new TipJar(noPlatform, { load: async () => null, save: async () => {} });

export function useTipJar(): TipJar {
  return useContext(TipsContext) ?? none;
}

/** Where the tip jar stands: the tips, whether one is being bought, and when the last was given. */
export function useTips(): TipState {
  const jar = useTipJar();
  return useSyncExternalStore(jar.subscribe, jar.getState, jar.getState);
}
