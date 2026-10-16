import { useEffect, useRef } from "react";
import type { State } from "../store";
import type { NodeActions } from "./canvasContext";
import { lostText } from "./orchestraView";
import { isOccupied, newlyMerged, tidyMode } from "./tidySetting";

/**
 * With "Tidy up an agent after its merge" on Automatically: when a merge the user approved goes through, closes that agent (and removes its
 * worktree and branch) by itself, if it has nothing left to lose and isn't at work. Otherwise the merge card keeps its "Tidy up" for the user.
 * Merges that were already there when the app started aren't touched.
 */
export function useAutoTidy(slots: Record<string, State>, actions: Pick<NodeActions, "closeCheck" | "closeWorker">): void {
  const seen = useRef<Set<string> | null>(null);
  const latest = useRef({ slots, actions });
  latest.current = { slots, actions };
  useEffect(() => {
    const { fresh, seen: now } = newlyMerged(seen.current, slots);
    seen.current = now;
    if (fresh.length === 0 || tidyMode() !== "auto") return;
    for (const worker of fresh) {
      if (isOccupied(latest.current.slots[worker])) continue;
      void latest.current.actions
        .closeCheck(worker)
        .then((check) => (lostText(check) ? undefined : latest.current.actions.closeWorker(worker)))
        .catch(() => {});
    }
  }, [slots]);
}
