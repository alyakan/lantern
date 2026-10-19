/**
 * Header button: "Continue in…" another agent with this chat's transcript.
 */

import { ipcBridge } from '@/common';
import type { TChatConversation } from '@/common/config/storage';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import { useProvidersQuery } from '@/renderer/hooks/agent/useModelProviderList';
import { Button, Dropdown, Menu } from '@arco-design/web-react';
import { TransferData } from '@icon-park/react';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { useDispatcher } from '../dispatch/useDispatcher';
import { buildHandoffTargets } from './handoffTargets';
import { useContinueInAgent } from './useContinueInAgent';

const ContinueInAgentButton: React.FC<{ conversation: TChatConversation }> = ({ conversation }) => {
  const { t } = useTranslation();
  const { data: assistants } = useSWR('assistants.list', () =>
    ipcBridge.assistants.list.invoke().catch(() => [] as Assistant[])
  );
  const { data: providers } = useProvidersQuery();
  const { continueIn, busy } = useContinueInAgent(conversation);

  const targets = useMemo(
    () => buildHandoffTargets(assistants ?? [], providers ?? [], conversation.assistant?.id),
    [assistants, providers, conversation.assistant?.id]
  );
  // The chat's title is its first request, which is what the dispatcher judges.
  const { result, record } = useDispatcher(conversation.name ?? '', targets, 'continue');
  // Recommend a different agent from the one this chat already runs on.
  const top = result?.ranked.find((item) => item.candidate.assistantId !== conversation.assistant?.id);
  if (!targets.length) return null;

  return (
    <Dropdown
      trigger={['click']}
      disabled={busy}
      droplist={
        <Menu
          onClickMenuItem={(key) => {
            const target = targets.find((item) => item.key === key.replace(/^rec:/, ''));
            if (!target) return;
            const chosen = result?.ranked.find((item) => item.candidate.key === target.key);
            if (chosen) void record(chosen);
            void continueIn(target);
          }}
        >
          {top ? (
            <Menu.ItemGroup
              title={t('cockpit.handoff.recommended', { kind: t(`cockpit.dispatch.kind.${result.kind}`) })}
            >
              <Menu.Item
                key={`rec:${top.candidate.key}`}
                style={{ height: 'auto', lineHeight: 1.4, padding: '6px 12px' }}
              >
                <span className='flex flex-col'>
                  <span>{top.candidate.label}</span>
                  <span className='text-11px text-t-secondary'>
                    {top.reasons
                      .slice(0, 2)
                      .map((reason) => t(`cockpit.dispatch.reason.${reason.key}`, reason.values))
                      .join(' · ')}
                  </span>
                </span>
              </Menu.Item>
            </Menu.ItemGroup>
          ) : null}
          <Menu.ItemGroup title={t('cockpit.handoff.menuTitle')}>
            {targets.map((target) => (
              <Menu.Item key={target.key}>
                <span className='flex items-center gap-8px'>
                  {target.avatar && <img src={target.avatar} alt='' className='w-14px h-14px' />}
                  {target.label}
                </span>
              </Menu.Item>
            ))}
          </Menu.ItemGroup>
        </Menu>
      }
    >
      <Button
        size='mini'
        loading={busy}
        title={t('cockpit.handoff.tooltip')}
        data-testid='cockpit-continue-in'
        icon={<TransferData theme='outline' size='14' />}
      >
        {t('cockpit.handoff.button')}
      </Button>
    </Dropdown>
  );
};

export default ContinueInAgentButton;
