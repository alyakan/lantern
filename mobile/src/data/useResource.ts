/** A cached resource as a screen reads it: what to show, how old it is, and a pull to ask again. */
import { useEffect, useSyncExternalStore } from "react";
import type { Resource } from "../cache/cache";
import { ageText } from "../lastKnown";

export interface Loaded<T> {
  value: T | null;
  /** How old `value` is: "just now", "5 min ago"; null with no value. */
  updated: string | null;
  loading: boolean;
  error: string | null;
  /** Asks the Mac again, however fresh it is (a pull, or Try again). */
  refresh: () => void;
}

/** Reads `resource`, and loads it whenever it is `active` (shown) or changes: fresh enough, it isn't asked for again. */
export function useResource<T>(resource: Resource<T>, active = true): Loaded<T> {
  const s = useSyncExternalStore(resource.subscribe, resource.getState, resource.getState);
  useEffect(() => {
    if (active) void resource.load();
  }, [resource, active]);
  return {
    value: s.value,
    updated: s.savedAt === null ? null : ageText(s.savedAt, resource.now()),
    loading: s.loading,
    error: s.error,
    refresh: () => void resource.load({ force: true }),
  };
}
