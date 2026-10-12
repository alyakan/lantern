import { useEffect, useState } from "react";
import { api } from "../api";
import type { UpdateState } from "../types";

/** Lantern is replacing itself: the window should say so, and nothing else matters until it reopens. */
export const isInstalling = (s: UpdateState) => s.kind === "installing" || s.kind === "restarting";

/** How far along a download is, 0–100; null when the size isn't known. */
export function downloadPercent(s: UpdateState): number | null {
  if (s.kind !== "downloading" || !s.total || s.total <= 0) return null;
  return Math.min(100, Math.round((s.downloaded / s.total) * 100));
}

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));

/** The updating state, kept up to date by the backend's events, with a way to ask for a check now. */
export function useUpdateState() {
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    const unlisten = api.onUpdateState(setState);
    // It may have moved on before this window was listening.
    api.updateState().then((s) => setState((now) => (now.kind === "idle" ? s : now)), () => {});
    api.appVersion().then(setVersion, () => {});
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);
  /** Looks for an update now. The events show the progress; this settles on what the check ended with. */
  const check = () => api.checkForUpdates().then(setState, (e) => setState({ kind: "failed", error: errText(e) }));
  return { state, version, check };
}
