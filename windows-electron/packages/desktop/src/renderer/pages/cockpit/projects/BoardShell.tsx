/**
 * Board page shell: the project board (frames of modules) or one project's
 * chat board, with the side-panel chat next to it.
 */

import { ipcBridge } from '@/common';
import { useConversationListSync } from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';
import { Radio } from '@arco-design/web-react';
import type { LanternModule, LanternProject } from '@/common/types/cockpitProjects';
import { useLanternStyle } from '@/renderer/utils/theme/lanternStyle';
import { ReactFlowProvider } from '@xyflow/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BoardActionsContext, type BoardActions } from './ProjectNodes';
import ProjectsCanvas from './ProjectsCanvas';
import styles from './ProjectsBoard.module.css';
import SideChat from './side/SideChat';
import { frameId, moduleNodeId, normalizeTarget, targetKey, type BoardTarget } from './projectsGraph';
import { useDragSize } from './useDragSize';
import { useBoardChatStarter, useProjectBoard } from './useProjectBoard';

/** Board node behind a side-panel target, for the HUD leader line. */
function leaderNodeId(target: BoardTarget): string | null {
  const resolved = normalizeTarget(target);
  // The operator has no card; the frame stands for it.
  if (resolved.kind === 'module' && resolved.module.kind === 'operator') return frameId(resolved.project);
  if (resolved.kind === 'module') return moduleNodeId(resolved.project, resolved.module);
  if (resolved.kind === 'project') return frameId(resolved.project);
  return null;
}

/** The side panel's target outlives the page, so leaving the board and coming back keeps the open chat. */
let lastTarget: BoardTarget = { kind: 'pc' };

type Props = { renderChats: (onOpenChat: (conversationId: string) => void) => React.ReactNode };

const BoardShell: React.FC<Props> = ({ renderChats }) => {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get('view') === 'chats' ? 'chats' : 'projects';
  const board = useProjectBoard();
  const navigate = useNavigate();
  const hud = useLanternStyle() === 'hud';
  const { isConversationGenerating, isConversationWaitingConfirmation } = useConversationListSync();
  const [target, setTarget] = useState<BoardTarget>(() => lastTarget);
  useEffect(() => {
    lastTarget = target;
  }, [target]);
  // A remembered target may hold an older copy of its project; swap in the fresh one.
  useEffect(() => {
    setTarget((prev) => {
      if (prev.kind !== 'module' && prev.kind !== 'project') return prev;
      const project = board.projects.find((item) => item.dir === prev.project.dir);
      if (!project || project === prev.project) return prev;
      if (prev.kind === 'project') return { kind: 'project', project };
      const module = project.modules.find((item) => item.id === prev.module.id);
      return module ? { kind: 'module', project, module } : { kind: 'project', project };
    });
  }, [board.projects]);
  const shellRef = useRef<HTMLDivElement>(null);

  const [sideChats, setSideChats] = useState<Record<string, string>>({});
  useEffect(() => {
    void ipcBridge.cockpit.getSideChats.invoke().then((bindings) => setSideChats(bindings ?? {}));
  }, []);
  const onBind = useCallback((key: string, conversationId: string | null) => {
    setSideChats((prev) => {
      const next = { ...prev };
      if (conversationId) next[key] = conversationId;
      else delete next[key];
      return next;
    });
    void ipcBridge.cockpit.setSideChat.invoke({ target: key, conversation_id: conversationId });
  }, []);

  // Open as full chat from a card: the bound chat, or a new empty one in the module's folder.
  const { startChat } = useBoardChatStarter(board.root, onBind);
  const sideChatsRef = useRef(sideChats);
  sideChatsRef.current = sideChats;
  const actions = useMemo<BoardActions>(
    () => ({
      openFull: (project: LanternProject, module: LanternModule) => {
        const chatTarget: BoardTarget = { kind: 'module', project, module };
        const bound = sideChatsRef.current[targetKey(chatTarget)];
        void (bound ? Promise.resolve(bound) : startChat(chatTarget)).then((id) => {
          if (id) void navigate(`/conversation/${id}`);
        });
      },
    }),
    [navigate, startChat]
  );

  // Drag the panel's left edge to resize it. In HUD it floats over the board.
  const side = useDragSize<HTMLDivElement>({
    storageKey: '__lantern_side_w',
    initial: 440,
    min: 320,
    max: () => (shellRef.current?.clientWidth ?? 1200) - 360,
    axis: 'x',
    invert: true,
    onDragChange: (dragging) => shellRef.current?.classList.toggle(styles.resizing, dragging),
  });

  // HUD leader line from the selected card to the panel. Drawn imperatively, hidden while anything moves.
  const leaderRef = useRef<SVGPathElement>(null);
  const leaderDotRef = useRef<SVGCircleElement>(null);
  const leaderId = hud && view === 'projects' ? leaderNodeId(target) : null;
  const drawLeader = useCallback(() => {
    const path = leaderRef.current;
    const dot = leaderDotRef.current;
    const shell = shellRef.current;
    const panel = side.targetRef.current;
    if (!path || !dot || !shell || !panel) return;
    const node = leaderId
      ? shell.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(leaderId)}"]`)
      : null;
    if (!node) {
      path.setAttribute('d', '');
      dot.setAttribute('r', '0');
      return;
    }
    const base = shell.getBoundingClientRect();
    const card = node.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    const x1 = card.right - base.left;
    const y1 = card.top - base.top + 22;
    const x2 = box.left - base.left;
    const y2 = box.top - base.top + 40;
    if (x1 > x2 - 12 || card.bottom < base.top || card.top > base.bottom) {
      path.setAttribute('d', '');
      dot.setAttribute('r', '0');
      return;
    }
    const mid = (x1 + x2) / 2;
    path.setAttribute('d', `M${x1} ${y1} H${mid} L${x2 - 8} ${y2} H${x2}`);
    dot.setAttribute('cx', String(x1));
    dot.setAttribute('cy', String(y1));
    dot.setAttribute('r', '2.5');
  }, [leaderId, side.targetRef]);
  useEffect(() => {
    if (!leaderId) return;
    const frame = requestAnimationFrame(drawLeader);
    window.addEventListener('resize', drawLeader);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', drawLeader);
    };
  }, [leaderId, drawLeader, side.size]);
  const onMotion = useCallback(
    (moving: boolean) => {
      shellRef.current?.classList.toggle(styles.moving, moving);
      if (!moving) drawLeader();
    },
    [drawLeader]
  );

  // Ctrl+K lands here with ?select=project:<dir> or ?select=module:<dir>#<id>.
  const select = searchParams.get('select');
  useEffect(() => {
    if (!select || board.projects.length === 0) return;
    const [kind, rest] = [select.slice(0, select.indexOf(':')), select.slice(select.indexOf(':') + 1)];
    const [dir, moduleId] =
      kind === 'module' ? [rest.slice(0, rest.lastIndexOf('#')), rest.slice(rest.lastIndexOf('#') + 1)] : [rest, ''];
    const project = board.projects.find((item) => item.dir === dir);
    const module = project?.modules.find((item) => item.id === moduleId);
    if (project && module) setTarget({ kind: 'module', project, module });
    else if (project) setTarget({ kind: 'project', project });
    setSearchParams({}, { replace: true });
  }, [select, board.projects, setSearchParams]);

  const openChat = useCallback((conversationId: string) => setTarget({ kind: 'chat', conversationId }), []);
  const openProjectChats = useCallback(
    (dir: string) => setSearchParams({ view: 'chats', project: dir }),
    [setSearchParams]
  );

  return (
    <BoardActionsContext.Provider value={actions}>
      <div ref={shellRef} className={styles.shell}>
        <div className='relative flex-1 min-w-0 flex flex-col'>
          <div className={styles.viewSwitch}>
            <Radio.Group
              type='button'
              size='small'
              value={view}
              onChange={(value: string) =>
                setSearchParams(value === 'chats' ? { view: 'chats', project: searchParams.get('project') ?? '' } : {})
              }
            >
              <Radio value='projects'>{t('cockpit.projects.viewProjects')}</Radio>
              <Radio value='chats'>{t('cockpit.projects.viewChats')}</Radio>
            </Radio.Group>
          </div>
          {view === 'projects' ? (
            <ReactFlowProvider>
              <ProjectsCanvas
                projects={board.projects}
                git={board.git}
                services={board.services}
                servicesError={board.servicesError}
                sideChats={sideChats}
                isGenerating={isConversationGenerating}
                isWaiting={isConversationWaitingConfirmation}
                onMotion={onMotion}
                onSelect={setTarget}
                onOpenChats={openProjectChats}
              />
            </ReactFlowProvider>
          ) : (
            <ReactFlowProvider>{renderChats(openChat)}</ReactFlowProvider>
          )}
        </div>
        {leaderId && (
          <svg className={styles.leader} aria-hidden='true'>
            <path key={leaderId} ref={leaderRef} className={styles.leaderPath} />
            <circle ref={leaderDotRef} r='0' className={styles.leaderDot} />
          </svg>
        )}
        <div ref={side.targetRef} className={styles.sideWrap} style={{ width: side.size }}>
          <div
            className={styles.splitterX}
            onPointerDown={side.onPointerDown}
            role='separator'
            aria-orientation='vertical'
            aria-label={t('cockpit.side.resize')}
            data-testid='board-side-splitter'
          />
          <SideChat
            target={target}
            root={board.root}
            projects={board.projects}
            sideChats={sideChats}
            onBind={onBind}
            onSelect={setTarget}
          />
        </div>
      </div>
    </BoardActionsContext.Provider>
  );
};

export default BoardShell;
