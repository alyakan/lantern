/**
 * The board's side panel. It is always a chat: the PC operator when nothing
 * is selected, a project's operator, a module, or a chat card. Each target is
 * bound to one conversation (cockpit-side-chats.json); the first message
 * starts it with the right agent in the right folder and a pointer to the
 * context files, which the agent reads itself. Typing "continue on <module>"
 * in any side chat switches to that module.
 */

import type { TChatConversation } from '@/common/config/storage';
import type { LanternProject } from '@/common/types/cockpitProjects';
import { SendInterceptContext } from '@/renderer/components/chat/SendBox/sendIntercept';
import ChatConversation from '@/renderer/pages/conversation/components/ChatConversation';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { Button, Input, Message, Spin, Tooltip } from '@arco-design/web-react';
import { Computer, FullScreenOne, Plus } from '@icon-park/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import classNames from 'classnames';
import useSWR from 'swr';
import ModuleDetails from '../ModuleDetails';
import ModuleIcon, { AgentTile } from '../ModuleIcon';
import { useLanternStyle } from '@/renderer/utils/theme/lanternStyle';
import { useBoardChatStarter } from '../useProjectBoard';
import styles from '../ProjectsBoard.module.css';
import SideStartOptions from './SideStartOptions';
import { useSideStartOptions } from './useSideStartOptions';
import { agentKind, matchContinueCommand, normalizeTarget, targetKey, type BoardTarget } from '../projectsGraph';

/** Unsent text per target, kept while the app runs so switching or leaving the board never drops it. */
const sideDrafts = new Map<string, string>();

type Props = {
  target: BoardTarget;
  root: string;
  projects: LanternProject[];
  sideChats: Record<string, string>;
  onBind: (key: string, conversationId: string | null) => void;
  onSelect: (target: BoardTarget) => void;
};

const SideChat: React.FC<Props> = ({ target, root, projects, sideChats, onBind, onSelect }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const resolved = normalizeTarget(target);
  const key = targetKey(resolved);
  const conversationId = resolved.kind === 'chat' ? resolved.conversationId : sideChats[key];

  const { data: conversation, isLoading } = useSWR(conversationId ? `conversation/${conversationId}` : null, () =>
    getConversationOrNull(conversationId!)
  );

  const title =
    resolved.kind === 'pc'
      ? t('cockpit.side.pcTitle')
      : resolved.kind === 'module'
        ? resolved.module.name
        : resolved.kind === 'project'
          ? resolved.project.name
          : (conversation?.name ?? t('cockpit.side.chatTitle'));
  const subtitle =
    resolved.kind === 'pc'
      ? root
      : resolved.kind === 'module'
        ? `${resolved.project.name} · ${resolved.module.llm ?? ''}`.replace(/ · $/, '')
        : resolved.kind === 'project'
          ? resolved.project.dir
          : ((conversation?.extra as { workspace?: string } | undefined)?.workspace ?? '');

  const { startChat, agentFor, busy } = useBoardChatStarter(root, onBind);
  const startOptions = useSideStartOptions(agentFor(resolved).assistant);

  // "continue on the rayak website": switch to that module; start its chat if it has none.
  const pendingContinue = useRef<string | null>(null);
  const intercept = useCallback(
    (text: string) => {
      const match = matchContinueCommand(text, projects);
      if (!match) return false;
      const next: BoardTarget = { kind: 'module', project: match.project, module: match.module };
      Message.info(t('cockpit.side.switched', { module: match.module.name, project: match.project.name }));
      if (!sideChats[targetKey(next)]) pendingContinue.current = targetKey(next);
      onSelect(next);
      return true;
    },
    [onSelect, projects, sideChats, t]
  );
  useEffect(() => {
    if (pendingContinue.current !== key || resolved.kind !== 'module') return;
    pendingContinue.current = null;
    void startChat(resolved, t('cockpit.side.continueMessage', { module: resolved.module.name }));
  }, [key, resolved, startChat, t]);

  const [draft, setDraftState] = useState(() => sideDrafts.get(key) ?? '');
  useEffect(() => setDraftState(sideDrafts.get(key) ?? ''), [key]);
  const setDraft = (value: string) => {
    if (value) sideDrafts.set(key, value);
    else sideDrafts.delete(key);
    setDraftState(value);
  };
  const submitDraft = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    if (intercept(text)) return;
    void startChat(resolved, text, startOptions.overrides);
  };

  // HUD: replay the scan-open each time the panel switches to another target.
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = asideRef.current;
    if (!el) return;
    el.classList.remove(styles.sideOpen);
    void el.offsetWidth;
    el.classList.add(styles.sideOpen);
  }, [key]);

  const openFull = async () => {
    const id = conversation?.id ?? (await startChat(resolved));
    if (id) void navigate(`/conversation/${id}`);
  };

  const hud = useLanternStyle() === 'hud';
  const icon =
    hud && resolved.kind === 'module' ? (
      <AgentTile kind={agentKind(resolved.module.llm)} size={26} />
    ) : resolved.kind === 'module' ? (
      <ModuleIcon icon={resolved.module.icon} color={resolved.module.color} size={28} />
    ) : resolved.kind === 'project' ? (
      <ModuleIcon icon='compass' color={resolved.project.color} size={28} />
    ) : (
      <ModuleIcon icon='pc' color='rgb(var(--primary-6))' size={28} />
    );

  return (
    <aside ref={asideRef} className={styles.side} data-testid='board-side-chat'>
      <span className={styles.sideScan} aria-hidden='true' />
      <span className={classNames(styles.sideBracket, styles.sideBracketTop)} aria-hidden='true' />
      <span className={classNames(styles.sideBracket, styles.sideBracketBottom)} aria-hidden='true' />
      <div className={styles.sideHeader}>
        {icon}
        <div className='min-w-0 flex-1'>
          <div className={styles.sideTitle}>{title}</div>
          <div className={styles.sideSubtitle}>{subtitle}</div>
        </div>
        {resolved.kind !== 'pc' && (
          <Tooltip content={t('cockpit.side.backToPc')}>
            <Button size='small' shape='circle' icon={<Computer />} onClick={() => onSelect({ kind: 'pc' })} />
          </Tooltip>
        )}
        {conversation && resolved.kind !== 'chat' && (
          <Tooltip content={t('cockpit.side.newChat')}>
            <Button size='small' shape='circle' icon={<Plus />} onClick={() => onBind(key, null)} />
          </Tooltip>
        )}
        <Button
          size='small'
          type='secondary'
          icon={<FullScreenOne />}
          loading={busy && !conversation}
          onClick={() => void openFull()}
          data-testid='board-side-open-full'
        >
          {t('cockpit.side.openFullButton')}
        </Button>
      </div>
      {resolved.kind === 'module' && (
        <ModuleDetails
          project={resolved.project}
          module={resolved.module}
          hasChat={Boolean(conversation)}
          onSelect={onSelect}
        />
      )}
      {resolved.kind === 'project' && (
        <ModuleDetails project={resolved.project} hasChat={Boolean(conversation)} onSelect={onSelect} />
      )}
      <SendInterceptContext.Provider value={intercept}>
        <div className={styles.sideBody}>
          {conversationId && isLoading ? (
            <Spin className='m-auto' />
          ) : conversation ? (
            <ChatConversation key={conversation.id} conversation={conversation as TChatConversation} />
          ) : (
            <div className={styles.sideEmpty}>
              <div className={styles.sideIntro}>
                {resolved.kind === 'module'
                  ? (resolved.module.summary ?? t('cockpit.side.moduleIntro'))
                  : resolved.kind === 'project'
                    ? (resolved.project.summary ?? t('cockpit.side.projectIntro'))
                    : t('cockpit.side.pcIntro')}
              </div>
              <div className={styles.sideHint}>{t('cockpit.side.continueHint')}</div>
              <div className={styles.sideComposer}>
                <Input.TextArea
                  value={draft}
                  onChange={setDraft}
                  autoSize={{ minRows: 2, maxRows: 8 }}
                  placeholder={t('cockpit.side.placeholder', { name: title })}
                  onPressEnter={(event) => {
                    if (event.shiftKey || event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    submitDraft();
                  }}
                  data-testid='board-side-input'
                />
                <div className={styles.sideComposerBar}>
                  <SideStartOptions options={startOptions} />
                  <Button type='primary' shape='round' loading={busy} disabled={!draft.trim()} onClick={submitDraft}>
                    {t('cockpit.side.start')}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </SendInterceptContext.Provider>
    </aside>
  );
};

export default SideChat;
