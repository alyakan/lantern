/**
 * Data for the project board: projects (from disk), git chips per folder and
 * live Mac mini services, refreshed in the background.
 */

import { ipcBridge } from '@/common';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import type { GitStatus, MacService } from '@/common/types/cockpitProjects';
import { parseError } from '@/common/utils';
import { useProvidersQuery } from '@/renderer/hooks/agent/useModelProviderList';
import { emitter } from '@/renderer/utils/emitter';
import { Message } from '@arco-design/web-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { buildHandoffTargets, type HandoffTarget } from '../handoff/handoffTargets';
import type { StartOverrides } from './side/useSideStartOptions';
import { contextPointer, normalizeTarget, pickAgentTarget, targetKey, type BoardTarget } from './projectsGraph';

const GIT_REFRESH_MS = 30_000;
const SERVICES_REFRESH_MS = 30_000;

export function useProjectBoard() {
  const { data: listing, mutate } = useSWR('cockpit.projects', () => ipcBridge.cockpit.listProjects.invoke(), {
    revalidateOnFocus: true,
  });
  const projects = useMemo(() => listing?.projects ?? [], [listing]);

  const gitDirs = useMemo(
    () => [...new Set(projects.flatMap((project) => [project.dir, ...project.members]))].toSorted(),
    [projects]
  );
  const { data: git } = useSWR(
    gitDirs.length ? ['cockpit.git', gitDirs.join('|')] : null,
    () => ipcBridge.cockpit.gitStatus.invoke({ dirs: gitDirs }),
    { refreshInterval: GIT_REFRESH_MS }
  );

  const prefixes = useMemo(
    () => [...new Set(projects.flatMap((project) => project.servicePrefixes))].toSorted(),
    [projects]
  );
  const { data: mac } = useSWR(
    prefixes.length ? ['cockpit.mac', prefixes.join('|')] : null,
    () => ipcBridge.cockpit.macServices.invoke({ prefixes }),
    { refreshInterval: SERVICES_REFRESH_MS }
  );

  return {
    root: listing?.root ?? '',
    projects,
    git: (git ?? {}) as Record<string, GitStatus | null>,
    services: (mac?.services ?? []) as MacService[],
    servicesError: mac?.error,
    servicesLoaded: Boolean(mac),
    reload: mutate,
  };
}

/**
 * Starts a board target's chat: the right agent in the right folder. With a
 * first message, the context pointer goes in front of it; without one (Open
 * as full chat on a card that has no chat yet) the chat starts empty.
 * Model, effort and permission picks from the side panel ride along as
 * overrides. Returns the new conversation id.
 */
export function useBoardChatStarter(root: string, onBind: (key: string, conversationId: string | null) => void) {
  const { t, i18n } = useTranslation();
  const { data: assistants } = useSWR('assistants.list', () =>
    ipcBridge.assistants.list.invoke().catch(() => [] as Assistant[])
  );
  const { data: providers } = useProvidersQuery();
  const agents = useMemo(() => buildHandoffTargets(assistants ?? [], providers ?? []), [assistants, providers]);
  const [busy, setBusy] = useState(false);

  /** The agent a target's chat runs on, and its assistant record. */
  const agentFor = useCallback(
    (chatTarget: BoardTarget): { agent?: HandoffTarget; assistant?: Assistant } => {
      const target = normalizeTarget(chatTarget);
      if (target.kind === 'chat') return {};
      const agent = pickAgentTarget(target.kind === 'module' ? target.module.llm : 'Claude', agents);
      return { agent, assistant: assistants?.find((item) => item.id === agent?.assistantId) };
    },
    [agents, assistants]
  );

  const startChat = useCallback(
    async (chatTarget: BoardTarget, text?: string, overrides?: StartOverrides): Promise<string | undefined> => {
      const target = normalizeTarget(chatTarget);
      if (target.kind === 'chat') return target.conversationId;
      const { agent } = agentFor(target);
      if (!agent) {
        Message.error(t('cockpit.side.noAgent'));
        return undefined;
      }
      const workspace =
        target.kind === 'module' ? target.module.folder : target.kind === 'project' ? target.project.dir : root;
      const name =
        target.kind === 'pc'
          ? t('cockpit.side.pcTitle')
          : target.kind === 'module'
            ? `${target.project.name} · ${target.module.name}`
            : target.project.name;
      setBusy(true);
      try {
        const created = await ipcBridge.conversation.create.invoke({
          name,
          model: agent.model,
          assistant: { id: agent.assistantId, locale: i18n.language, conversation_overrides: overrides },
          extra: {
            workspace,
            custom_workspace: true,
            default_files: [],
            lantern_project: target.kind === 'pc' ? undefined : target.project.dir,
            lantern_module: target.kind === 'module' ? target.module.id : undefined,
          } as Parameters<typeof ipcBridge.conversation.create.invoke>[0]['extra'],
        });
        if (!created?.id) throw new Error('create returned no conversation');
        if (text) {
          const storageKey = agent.backend === 'aionrs' ? 'aionrs_initial_message_' : 'acp_initial_message_';
          const input = `${contextPointer(target, root)}\n\n${text}`;
          sessionStorage.setItem(`${storageKey}${created.id}`, JSON.stringify({ input, files: [] }));
        }
        onBind(targetKey(target), created.id);
        emitter.emit('chat.history.refresh');
        return created.id;
      } catch (error) {
        Message.error(t('cockpit.side.startFailed', { message: parseError(error) }));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [agentFor, i18n.language, onBind, root, t]
  );

  return { startChat, agentFor, busy };
}
