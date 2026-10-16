import { useEffect, useState } from "react";
import type { State } from "../store";
import { nodeStatus } from "./orchestraView";

/**
 * What Lantern does with an agent once its branch was merged (Settings > General > Teams): nothing (the merge card still has a quiet
 * "Tidy up"), asks (the card says so and the button stands out), or does it by itself when the agent has nothing left to lose.
 * App-wide, like the agent limit.
 */
export type TidyMode = "off" | "ask" | "auto";

const KEY = "lantern.tidyAfterMerge";
const CHANGED = "lantern-tidy-after-merge";
export const TIDY_DEFAULT: TidyMode = "off";
export const TIDY_MODES: { value: TidyMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "ask", label: "Ask me" },
  { value: "auto", label: "Automatically" },
];

const isMode = (v: unknown): v is TidyMode => TIDY_MODES.some((m) => m.value === v);

export function tidyMode(): TidyMode {
  try {
    const v = localStorage.getItem(KEY);
    return isMode(v) ? v : TIDY_DEFAULT;
  } catch {
    return TIDY_DEFAULT;
  }
}

export function setTidyMode(mode: TidyMode): void {
  if (!isMode(mode)) return;
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // storage unavailable: it lasts until Lantern quits
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** The setting, kept in step with every place that changes it. */
export function useTidyMode(): TidyMode {
  const [mode, setMode] = useState(tidyMode);
  useEffect(() => {
    const sync = () => setMode(tidyMode());
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, []);
  return mode;
}

/** Whether an agent is busy (at work, waiting for the user, starting): closing it would cut that off. */
export const isOccupied = (state: State | undefined): boolean => !!state && ["working", "waiting", "starting"].includes(nodeStatus(state));

/**
 * The merges that went through since `seen` was taken: the workers whose proposal is merged now and wasn't counted. The first look
 * (`seen` null) counts what is already merged without reporting it, so a restored chat isn't tidied. Returns the new `seen`.
 */
export function newlyMerged(seen: Set<string> | null, slots: Record<string, State>): { fresh: string[]; seen: Set<string> } {
  const now = new Set<string>();
  const fresh: string[] = [];
  for (const state of Object.values(slots)) {
    for (const p of state.proposals) {
      if (p.status !== "merged" || p.tidied) continue;
      const key = `${p.worker}:${p.branch}`;
      now.add(key);
      if (seen && !seen.has(key)) fresh.push(p.worker);
    }
  }
  return { fresh, seen: now };
}
