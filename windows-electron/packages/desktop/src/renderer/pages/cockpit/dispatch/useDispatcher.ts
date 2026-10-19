/**
 * Live dispatcher recommendation for a draft, with the preferences learned from past overrides.
 */
import { useCallback, useDeferredValue, useMemo, useState } from 'react';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import type { HandoffTarget } from '../handoff/handoffTargets';
import { usePulse } from '../pulse/usePulse';
import { dispatch, toneOf, type DispatchCandidate, type DispatchPrefs, type Goal, type Ranked } from './dispatch';

const GOAL_KEY = 'cockpit.dispatch.goal';

function readGoal(): Goal {
  try {
    return (localStorage.getItem(GOAL_KEY) as Goal | null) ?? 'auto';
  } catch {
    return 'auto';
  }
}

export function toCandidates(targets: HandoffTarget[]): DispatchCandidate[] {
  return targets.map((target) => ({
    key: target.key,
    label: target.label,
    assistantId: target.assistantId,
    tone: target.backend === 'aionrs' ? 'qwen' : toneOf(target.label),
  }));
}

export function useDispatcher(text: string, targets: HandoffTarget[], where: string) {
  const { pulse } = usePulse();
  const { data: prefs, mutate } = useSWR<DispatchPrefs>('cockpit.dispatch.prefs', () =>
    ipcBridge.cockpit.getDispatchPrefs.invoke()
  );
  const [goal, setGoalState] = useState<Goal>(readGoal);
  const deferred = useDeferredValue(text);

  const setGoal = useCallback((next: Goal) => {
    setGoalState(next);
    try {
      localStorage.setItem(GOAL_KEY, next);
    } catch {
      // per-viewer convenience only
    }
  }, []);

  const result = useMemo(() => {
    if (deferred.trim().length < 12 || !targets.length) return undefined;
    return dispatch(deferred, goal, toCandidates(targets), pulse, prefs ?? {});
  }, [deferred, goal, targets, pulse, prefs]);

  /** Note what was chosen; an override teaches the dispatcher. */
  const record = useCallback(
    async (chosen: Ranked) => {
      if (!result?.ranked[0]) return;
      const next = await ipcBridge.cockpit.recordDispatch.invoke({
        kind: result.kind,
        goal,
        picked: result.ranked[0].candidate.tone,
        chosen: chosen.candidate.tone,
        where,
      });
      await mutate(next, { revalidate: false });
    },
    [goal, mutate, result, where]
  );

  return { result, goal, setGoal, record };
}
