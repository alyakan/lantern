import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { MergeTestsInfo } from "../types";

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : "That didn't work.");

/** How often a run going is looked at, for its clock and the line it is on. */
const POLL_MS = 1000;

/**
 * A merge card's tests: what the backend knows of them (it keeps the result, so a card drawn again finds it), looked at again
 * whenever `refreshOn` changes and when the window comes back, and every second while a run is going (not at all when the
 * card has no tests to show, `enabled` off). `run` starts one
 * (`words`: what the user typed, as the backend split it; null for what the worktree says) and `cancel` stops it.
 */
export function useMergeTests(worker: string, enabled: boolean, refreshOn: unknown[]) {
  const [info, setInfo] = useState<MergeTestsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A run this card asked for and hasn't heard the end of.
  const [asked, setAsked] = useState(false);
  const alive = useRef(true);

  const refresh = useCallback(
    () =>
      api.mergeTestsInfo(worker).then(
        (i) => {
          if (alive.current) setInfo(i);
          return i;
        },
        () => null,
      ),
    [worker],
  );

  useEffect(() => {
    alive.current = true;
    if (enabled) void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh, enabled, ...refreshOn]);

  useEffect(() => {
    if (!enabled) return;
    const back = () => void refresh();
    window.addEventListener("focus", back);
    return () => window.removeEventListener("focus", back);
  }, [refresh, enabled]);

  const going = enabled && (asked || info?.running != null);
  useEffect(() => {
    if (!going) return;
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [going, refresh]);

  const run = (words: string[] | null) => {
    setError(null);
    setAsked(true);
    api.runMergeTests(worker, words).then(
      () => {},
      (e) => alive.current && setError(errText(e)),
    ).finally(() => {
      if (!alive.current) return;
      setAsked(false);
      void refresh();
    });
    // The backend marks the run going as it starts: looked at once it has.
    setTimeout(() => alive.current && void refresh(), 150);
  };

  const cancel = () => void api.cancelMergeTests(worker).catch(() => {});

  return { info, error, going, run, cancel, refresh, clearError: () => setError(null) };
}
