/**
 * Model, effort and permission picks for a side chat that has not started
 * yet. They come from the agent's runtime catalog, like the New Chat page,
 * and the last pick per agent is kept while the app runs.
 */

import type { Assistant } from '@/common/types/agent/assistantTypes';
import { assistantRuntimeKey } from '@/common/types/agent/assistantTypes';
import { useManagedAgentRuntimeCatalog } from '@/renderer/hooks/agent/useManagedAgents';
import {
  buildAgentRuntimeModeState,
  buildAgentRuntimeModelInfo,
  buildAgentRuntimeThoughtLevelOption,
} from '@/renderer/utils/model/agentRuntimeCatalog';
import { useCallback, useMemo, useState } from 'react';

export type StartOverrides = { model?: string; permission?: string; thought_level?: string };

const picksByAgent = new Map<string, StartOverrides>();

export function useSideStartOptions(assistant: Assistant | undefined) {
  const catalog = useManagedAgentRuntimeCatalog();
  const runtime = useMemo(
    () => (assistant?.agent_id ? catalog.find((agent) => agent.id === assistant.agent_id) : undefined),
    [catalog, assistant?.agent_id]
  );
  const modelInfo = useMemo(() => buildAgentRuntimeModelInfo(runtime), [runtime]);
  const modeState = useMemo(() => buildAgentRuntimeModeState(runtime), [runtime]);
  const thoughtOption = useMemo(() => buildAgentRuntimeThoughtLevelOption(runtime), [runtime]);

  const agentKey = assistant?.id ?? '';
  const [, bump] = useState(0);
  const picks = picksByAgent.get(agentKey) ?? {};
  const update = useCallback(
    (patch: StartOverrides) => {
      picksByAgent.set(agentKey, { ...picksByAgent.get(agentKey), ...patch });
      bump((n) => n + 1);
    },
    [agentKey]
  );

  // A pick the agent no longer offers falls back to its own default.
  const model = picks.model && modelInfo?.available_models.some((m) => m.id === picks.model) ? picks.model : null;
  const mode =
    picks.permission && modeState.options.some((m) => m.value === picks.permission)
      ? picks.permission
      : (modeState.currentMode ?? modeState.options[0]?.value ?? '');
  const thought =
    picks.thought_level && thoughtOption?.options.some((o) => o.value === picks.thought_level)
      ? picks.thought_level
      : (thoughtOption?.currentValue ?? thoughtOption?.options[0]?.value ?? '');

  const overrides: StartOverrides = {
    // No pick means no override: the agent then uses the user's own default model.
    model: model ?? undefined,
    permission: picks.permission ? mode : undefined,
    thought_level: picks.thought_level ? thought : undefined,
  };

  return {
    backend: assistantRuntimeKey(assistant),
    modelInfo,
    model,
    setModel: (value: string | null) => update({ model: value ?? undefined }),
    modes: modeState.options,
    mode,
    setMode: (value: string) => update({ permission: value }),
    thoughtOption: thoughtOption ? { ...thoughtOption, currentValue: thought } : null,
    setThought: (value: string) => update({ thought_level: value }),
    overrides,
  };
}
