/**
 * Which agents a chat can be handed to ("Continue in another agent").
 */

import type { IProvider, TProviderWithModel } from '@/common/config/storage';
import type { Assistant } from '@/common/types/agent/assistantTypes';

export type HandoffTarget = {
  /** Stable menu key. */
  key: string;
  assistantId: string;
  label: string;
  avatar?: string;
  /** `aionrs` targets run on an app-configured model; ACP agents bring their own. */
  backend: 'aionrs' | 'acp';
  model?: TProviderWithModel;
};

/**
 * One target per online bare agent (Claude Code, Codex, custom agents such as
 * the Mac mini one). Aion CLI expands into one target per configured model so
 * the user can pick e.g. the local Qwen directly.
 */
export function buildHandoffTargets(
  assistants: Assistant[],
  providers: IProvider[],
  currentAssistantId?: string
): HandoffTarget[] {
  const targets: HandoffTarget[] = [];
  for (const assistant of assistants) {
    if (assistant.source !== 'generated' || !assistant.enabled || assistant.agent_status !== 'online') continue;
    const type = assistant.agent?.type;
    if (type === 'aionrs') {
      for (const provider of providers) {
        if (provider.enabled === false) continue;
        for (const model of provider.models ?? []) {
          if (provider.model_enabled?.[model] === false) continue;
          targets.push({
            key: `${assistant.id}::${provider.id}::${model}`,
            assistantId: assistant.id,
            label: `${assistant.name} · ${model}`,
            avatar: assistant.avatar,
            backend: 'aionrs',
            model: { ...provider, use_model: model },
          });
        }
      }
      continue;
    }
    if (assistant.id === currentAssistantId) continue;
    targets.push({
      key: assistant.id,
      assistantId: assistant.id,
      label: assistant.name,
      avatar: assistant.avatar,
      backend: 'acp',
    });
  }
  return targets;
}
