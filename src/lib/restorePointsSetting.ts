import { useEffect, useState } from "react";
import { api } from "../api";

/** Whether restore points are kept before each message (Settings → General). On until the user turns it off. */
const KEY = "lantern.restorePoints";
const CHANGED = "lantern-restore-points";

export function restorePointsOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== "false";
  } catch {
    return true;
  }
}

/** Tells the backend the setting, which is where a message checks it. Done when the window starts and on every change. */
export function pushRestorePoints(): Promise<void> {
  return api.setRestorePoints(restorePointsOn()).catch(() => {});
}

export function setRestorePoints(on: boolean): void {
  try {
    localStorage.setItem(KEY, String(on));
  } catch {
    // storage unavailable: it lasts until Lantern quits
  }
  window.dispatchEvent(new Event(CHANGED));
  void api.setRestorePoints(on).catch(() => {});
}

/** The setting, kept in step with every place that changes it. */
export function useRestorePoints(): boolean {
  const [on, setOn] = useState(restorePointsOn);
  useEffect(() => {
    const sync = () => setOn(restorePointsOn());
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, []);
  return on;
}
