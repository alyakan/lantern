/**
 * Lantern board: one canvas per project folder. Cards are the project's chats
 * (live agent status), edges show how they came from each other (fork,
 * "Continue in…" handoff, cockpit_delegate, board module, `@@` mention).
 * Click a card to open its chat; "Add module" starts a new chat in the project.
 */

import { ipcBridge } from '@/common';
import { useConversationListSync } from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';
import { resolveConversationLeadingMark } from '@/renderer/pages/conversation/utils/conversationAssistantIdentity';
import { useAgentLogos } from '@/renderer/utils/model/agentLogo';
import { Button, Empty, Select, Space, Tooltip } from '@arco-design/web-react';
import { Plus, Refresh } from '@icon-park/react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import BoardShell from '../projects/BoardShell';
import AddModuleModal from './AddModuleModal';
import {
  buildLinks,
  layoutModules,
  listProjects,
  projectConversations,
  sameCard,
  toModule,
  type BoardEdgeKind,
  type BoardPosition,
} from './boardGraph';
import styles from './BoardPage.module.css';
import ModuleNode, { type ModuleNodeData } from './ModuleNode';
import { useBoardMentions } from './useBoardMentions';

const NODE_TYPES = { module: ModuleNode };
const LAST_PROJECT_KEY = 'cockpit.board.lastProject';

const EDGE_STYLE: Record<BoardEdgeKind, React.CSSProperties> = {
  fork: { stroke: 'var(--bg-5)', strokeDasharray: '6 4' },
  handoff: { stroke: 'rgb(var(--primary-6))' },
  delegate: { stroke: 'var(--agent-qwen)' },
  module: { stroke: 'var(--bg-6)' },
  mention: { stroke: 'var(--agent-remote)', strokeDasharray: '2 4' },
};
const EDGE_KINDS = Object.keys(EDGE_STYLE) as BoardEdgeKind[];

const baseName = (dir: string) => dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;

function readLastProject(): string | undefined {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeLastProject(project: string): void {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, project);
  } catch {
    // Not critical.
  }
}

type BoardCanvasProps = { onOpenChat: (conversationId: string) => void };

const BoardCanvas: React.FC<BoardCanvasProps> = ({ onOpenChat }) => {
  const { t } = useTranslation();
  const { fitView } = useReactFlow();
  const [searchParams, setSearchParams] = useSearchParams();
  const { conversations, isConversationGenerating, isConversationWaitingConfirmation } = useConversationListSync();
  const logos = useAgentLogos();

  const projects = useMemo(() => listProjects(conversations), [conversations]);
  const requested = searchParams.get('project') ?? readLastProject();
  const project = requested || projects[0];

  const chats = useMemo(() => (project ? projectConversations(conversations, project) : []), [conversations, project]);
  const modules = useMemo(
    () =>
      chats.map((chat) => {
        const mark = resolveConversationLeadingMark(chat, undefined, logos);
        return {
          ...toModule(chat, {
            generating: isConversationGenerating(chat.id),
            waiting: isConversationWaitingConfirmation(chat.id),
          }),
          agentAvatar: mark.kind === 'image' || mark.kind === 'emoji' ? mark.value : undefined,
          agentAvatarIsEmoji: mark.kind === 'emoji',
        };
      }),
    [chats, isConversationGenerating, isConversationWaitingConfirmation, logos]
  );
  const [refreshKey, setRefreshKey] = useState(0);
  const mentions = useBoardMentions(
    chats.map((chat) => chat.id),
    `${project}:${refreshKey}`
  );
  const links = useMemo(() => buildLinks(chats, mentions), [chats, mentions]);

  const [saved, setSaved] = useState<Record<string, BoardPosition>>({});
  // Bumped when saved positions must be (re)applied to every card: a project's
  // layout finished loading, or "Re-arrange". Otherwise live updates only add
  // new cards and refresh data, so a card is never moved under the cursor.
  const [layoutVersion, setLayoutVersion] = useState(0);
  useEffect(() => {
    if (!project) return;
    writeLastProject(project);
    let cancelled = false;
    void ipcBridge.cockpit.getBoardLayout.invoke({ project }).then((layout) => {
      if (cancelled) return;
      setSaved(layout ?? {});
      setLayoutVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [project]);

  const positions = useMemo(() => layoutModules(modules, links, saved), [modules, links, saved]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const appliedVersion = useRef(-1);
  useEffect(() => {
    const relayout = appliedVersion.current !== layoutVersion;
    appliedVersion.current = layoutVersion;
    setNodes((current) => {
      const byId = new Map(current.map((node) => [node.id, node]));
      return modules.map((module) => {
        const prev = byId.get(module.id);
        const position = positions[module.id] ?? { x: 0, y: 0 };
        if (!prev) return { id: module.id, type: 'module', position, data: module };
        const data = sameCard(prev.data as unknown as ModuleNodeData, module) ? prev.data : module;
        if (relayout) return { ...prev, data, position };
        return data === prev.data ? prev : { ...prev, data };
      });
    });
  }, [modules, positions, layoutVersion, setNodes]);

  const runningKey = modules
    .filter((m) => m.status === 'running')
    .map((m) => m.id)
    .join(',');
  const edges = useMemo<Edge[]>(() => {
    const running = new Set(runningKey.split(','));
    return links.map((link) => ({
      id: link.id,
      source: link.source,
      target: link.target,
      animated: running.has(link.target),
      style: { strokeWidth: 1.5, ...EDGE_STYLE[link.kind] },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: EDGE_STYLE[link.kind].stroke as string },
      label: t(`cockpit.board.edge.${link.kind}`),
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 6,
    }));
  }, [links, runningKey, t]);

  useEffect(() => {
    const timer = setTimeout(() => void fitView({ padding: 0.25, duration: 300, maxZoom: 1 }), 80);
    return () => clearTimeout(timer);
  }, [project, modules.length, layoutVersion, fitView]);

  const onNodeDragStop = useCallback<OnNodeDrag>(
    (_event, _node, dragged) => {
      if (!project) return;
      setSaved((prev) => {
        const next = { ...prev };
        for (const node of dragged) next[node.id] = node.position;
        void ipcBridge.cockpit.saveBoardLayout.invoke({ project, positions: next });
        return next;
      });
    },
    [project]
  );
  const rearrange = useCallback(() => {
    if (!project) return;
    setSaved({});
    setLayoutVersion((v) => v + 1);
    void ipcBridge.cockpit.saveBoardLayout.invoke({ project, positions: {} });
  }, [project]);
  const onNodeClick = useCallback<NodeMouseHandler>((_event, node) => onOpenChat(node.id), [onOpenChat]);

  const [adding, setAdding] = useState(false);

  const liveCount = runningKey ? runningKey.split(',').length : 0;

  return (
    <div className='size-full flex flex-col'>
      {project ? (
        <div className={styles.canvas}>
          <div className={styles.toolbar}>
            <div className={styles.toolbarGroup}>
              <span className={styles.toolbarTitle}>{t('cockpit.board.title')}</span>
              <Select
                className='w-220px'
                size='small'
                bordered={false}
                value={project}
                placeholder={t('cockpit.board.pickProject')}
                onChange={(value: string) => setSearchParams({ view: 'chats', project: value })}
                showSearch
              >
                {projects.map((dir) => (
                  <Select.Option key={dir} value={dir}>
                    <Tooltip content={dir} position='right'>
                      <span>{baseName(dir)}</span>
                    </Tooltip>
                  </Select.Option>
                ))}
              </Select>
              <span className={styles.counter}>{t('cockpit.board.chatCount', { count: modules.length })}</span>
              {liveCount > 0 && (
                <span className={`${styles.counter} ${styles.counterLive}`}>
                  {t('cockpit.board.liveCount', { count: liveCount })}
                </span>
              )}
            </div>
            <Space className='ms-auto'>
              <Tooltip content={t('cockpit.board.rearrangeHint')}>
                <Button shape='round' icon={<Refresh />} onClick={rearrange}>
                  {t('cockpit.board.rearrange')}
                </Button>
              </Tooltip>
              <Button
                shape='round'
                type='primary'
                icon={<Plus />}
                onClick={() => setAdding(true)}
                data-testid='board-add-module'
              >
                {t('cockpit.board.addModule')}
              </Button>
            </Space>
          </div>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={onNodeClick}
            nodesConnectable={false}
            colorMode='light'
            minZoom={0.2}
            maxZoom={1.6}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} color='var(--bg-4)' />
            <Controls showInteractive={false} position='bottom-right' />
            <MiniMap
              position='bottom-right'
              style={{ marginBottom: 120 }}
              pannable
              zoomable
              nodeBorderRadius={6}
              nodeColor='var(--bg-4)'
            />
          </ReactFlow>
          {links.length > 0 && (
            <div className={styles.legend}>
              {EDGE_KINDS.filter((kind) => links.some((link) => link.kind === kind)).map((kind) => (
                <span key={kind} style={{ color: EDGE_STYLE[kind].stroke as string }}>
                  <span
                    className={styles.legendLine}
                    style={{ borderTopStyle: EDGE_STYLE[kind].strokeDasharray ? 'dashed' : 'solid' }}
                  />
                  <span>{t(`cockpit.board.edge.${kind}`)}</span>
                </span>
              ))}
            </div>
          )}
          {modules.length === 0 && (
            <Empty className='absolute top-1/2 left-1/2 -translate-1/2' description={t('cockpit.board.empty')} />
          )}
        </div>
      ) : (
        <Empty className='mt-120px' description={t('cockpit.board.noProjects')} />
      )}
      {project && (
        <AddModuleModal
          visible={adding}
          project={project}
          modules={modules}
          onClose={() => setAdding(false)}
          onCreated={() => setRefreshKey((key) => key + 1)}
        />
      )}
    </div>
  );
};

const BoardPage: React.FC = () => <BoardShell renderChats={(onOpenChat) => <BoardCanvas onOpenChat={onOpenChat} />} />;

export default BoardPage;
