import { useEffect, useState } from "react";
import type { ChangedFile } from "../store";

/** Keeps the left pane's share of the split within both panes' minimum widths. */
export function clampRatio(ratio: number, total: number, minLeft: number, minRight: number): number {
  if (total <= minLeft + minRight) return 0.5;
  return Math.min(Math.max(ratio, minLeft / total), 1 - minRight / total);
}

/** The path `delta` steps from `current`, stopping at either end of the list. */
export function stepFile(files: ChangedFile[], current: string | null, delta: number): string | null {
  if (files.length === 0) return null;
  const i = files.findIndex((f) => f.path === current);
  const from = i === -1 ? files.length - 1 : i;
  return files[Math.min(Math.max(from + delta, 0), files.length - 1)].path;
}

export function usePersistentState<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage unavailable; the value just won't survive a restart
    }
  }, [key, value]);
  return [value, setValue];
}
