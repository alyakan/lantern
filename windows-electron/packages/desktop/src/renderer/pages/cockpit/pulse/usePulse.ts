/**
 * Live Pulse snapshot, refreshed every 10 seconds (Claude itself is re-probed at most every 15 minutes).
 */
import { useCallback, useState } from 'react';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import type { PulseSnapshot } from '@/common/types/cockpitPulse';

export function usePulse() {
  const { data, mutate } = useSWR<PulseSnapshot>('cockpit.pulse', () => ipcBridge.cockpit.pulse.invoke({}), {
    refreshInterval: 10_000,
    revalidateOnFocus: true,
  });
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (action: () => Promise<PulseSnapshot>) => {
      setBusy(true);
      try {
        await mutate(await action(), { revalidate: false });
      } finally {
        setBusy(false);
      }
    },
    [mutate]
  );

  return {
    pulse: data,
    busy,
    refresh: () => run(() => ipcBridge.cockpit.pulse.invoke({ force: true })),
    setGameMode: (on: boolean) => run(() => ipcBridge.cockpit.setGameMode.invoke({ on })),
    setModelLoaded: (model: string, loaded: boolean) =>
      run(() => ipcBridge.cockpit.setModelLoaded.invoke({ model, loaded })),
  };
}
