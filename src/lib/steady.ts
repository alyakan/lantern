import { useMemo, useRef } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fns = Record<string, (...args: any[]) => any>;

/**
 * The same functions from one render to the next, each calling the latest one it was given. A memoised row that gets
 * them isn't drawn again because its parent rendered: new closures every render made every row of a long chat redraw for
 * every word a reply streamed. The keys must stay the same from render to render.
 */
export function useSteady<T extends Fns>(fns: T): T {
  const latest = useRef(fns);
  latest.current = fns;
  return useMemo(() => {
    const steady = {} as Fns;
    for (const key of Object.keys(fns)) steady[key] = (...args: unknown[]) => latest.current[key](...args);
    return steady as T;
  }, []);
}
