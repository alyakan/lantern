import { useEffect, useRef } from "react";

/**
 * The tab bar's tab tapped again while it is the one shown (`toTop` counts the taps): iOS takes a tab back to its first screen,
 * or to the top of it when it is there already. `run` does that for the screen; nothing happens when it is first drawn.
 */
export function useToTop(toTop: number | undefined, run: () => void) {
  const latest = useRef(run);
  latest.current = run;
  const seen = useRef(toTop);
  useEffect(() => {
    if (toTop === seen.current) return;
    seen.current = toTop;
    latest.current();
  }, [toTop]);
}
