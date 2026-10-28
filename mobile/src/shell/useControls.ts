import { useCallback, useEffect, useState } from "react";
import type { Controls } from "../protocol/generated/Controls";
import { useConnectionState, useController } from "./hooks";

/** Whether the connected Mac says it can do `feature` (Welcome's features): a phone shows only what its Mac can do. */
export function useMacCan(feature: string): boolean {
  const connection = useConnectionState();
  return connection.kind === "connected" && connection.welcome.features?.includes(feature) === true;
}

/**
 * What this phone may choose for a chat, asked of the Mac each time a screen needs it (it can change in the Mac's Settings
 * meanwhile). `supported` is false for a Mac that can't say (an older Lantern): nothing is offered then, and nothing is asked
 * of it, since it ends the connection at a request it doesn't know.
 */
export function useControls(): { supported: boolean; controls: Controls | null; reload: () => void } {
  const { sync } = useController();
  const connection = useConnectionState();
  const supported = connection.kind === "connected" && connection.welcome.features?.includes("controls") === true;
  const [controls, setControls] = useState<Controls | null>(null);
  const reload = useCallback(() => {
    if (!supported) return;
    sync.controls().then(setControls, () => {});
  }, [sync, supported]);
  useEffect(reload, [reload]);
  return { supported, controls, reload };
}
