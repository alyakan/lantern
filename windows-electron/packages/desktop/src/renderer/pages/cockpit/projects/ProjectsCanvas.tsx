/**
 * Project board canvas: one frame per project under the projects root, with
 * its modules inside. Click a frame or module to chat with it in the side
 * panel; click empty canvas to go back to the PC chat. Double-click a frame
 * to see that project's chats.
 */

import { ipcBridge } from '@/common';
import type { GitStatus, LanternProject, MacService } from '@/common/types/cockpitProjects';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useNodesState,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type OnNodeDrag,
} from '@xyflow/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FrameNode,
  LanternModuleNode,
  RoutedEdge,
  type RoutedEdgeData,
  type FrameNodeData,
  type LanternModuleNodeData,
} from './ProjectNodes';
import styles from './ProjectsBoard.module.css';
import {
  frameId,
  frameLayout,
  frameSize,
  moduleNodeId,
  layoutFrame,
  MODULE_H,
  MODULE_W,
  moduleStatus,
  targetKey,
  type BoardTarget,
} from './projectsGraph';
import { useLanternStyle } from '@/renderer/utils/theme/lanternStyle';

const NODE_TYPES = { frame: FrameNode, lanternModule: LanternModuleNode };
const EDGE_TYPES = { routed: RoutedEdge };
// v2: the layered layout replaced the grid, so grid-era positions are not reused.
const LAYOUT_KEY = '__projects_v2__';

type Props = {
  projects: LanternProject[];
  git: Record<string, GitStatus | null>;
  services: MacService[];
  servicesError?: string;
  sideChats: Record<string, string>;
  isGenerating: (conversationId: string) => boolean;
  isWaiting: (conversationId: string) => boolean;
  /** Called when a drag or pan starts (true) and when it ends (false), so overlays can hide meanwhile. */
  onMotion?: (moving: boolean) => void;
  onSelect: (target: BoardTarget) => void;
  onOpenChats: (dir: string) => void;
};

type Sig = { _sig: string };

const ProjectsCanvas: React.FC<Props> = ({
  projects,
  git,
  services,
  servicesError,
  sideChats,
  isGenerating,
  isWaiting,
  onMotion,
  onSelect,
  onOpenChats,
}) => {
  const { fitView } = useReactFlow();
  const lanternStyle = useLanternStyle();
  const hud = lanternStyle === 'hud';
  const canvasRef = useRef<HTMLDivElement>(null);
  const [saved, setSaved] = useState<Record<string, { x: number; y: number }>>();
  useEffect(() => {
    void ipcBridge.cockpit.getBoardLayout.invoke({ project: LAYOUT_KEY }).then((layout) => setSaved(layout ?? {}));
  }, []);

  // Node data, rebuilt from live inputs; BoardPage-style merge below keeps
  // unchanged objects so cards don't re-render while something else updates.
  const built = useMemo(() => {
    const byLabel = new Map(services.map((service) => [service.label, service]));
    const defaults = frameLayout(projects);
    const nodes: Node[] = [];
    for (const project of projects) {
      const id = frameId(project);
      const size = frameSize(project);
      const gitChips = [project.dir, ...project.members]
        .map((dir) => git[dir])
        .filter((status): status is GitStatus => Boolean(status));
      const ownServices = project.modules.flatMap((module) => module.services ?? []);
      const up = ownServices.filter((label) => byLabel.get(label)?.running).length;
      const perModule = project.modules.map((module) => {
        const chatId = sideChats[targetKey({ kind: 'module', project, module })];
        const moduleServices = (module.services ?? [])
          .map((label) => byLabel.get(label))
          .filter((service): service is MacService => Boolean(service));
        const running = Boolean(chatId && isGenerating(chatId));
        const status = moduleStatus({
          generating: running,
          waiting: Boolean(chatId && isWaiting(chatId)),
          services: moduleServices,
        });
        return { chatId, moduleServices, running, status };
      });
      // The frame is the operator: its lamp goes in the header, the cards are the other modules.
      const operatorIndex = project.modules.findIndex((module) => module.kind === 'operator');
      const operatorStatus = operatorIndex >= 0 ? perModule[operatorIndex].status : undefined;
      const lamps = perModule.filter((_, i) => i !== operatorIndex).map((entry) => entry.status);
      // Grow the frame to fit cards that were dragged below or beside the default layout.
      const fit = project.modules.reduce(
        (box, module, i) => {
          const at = i === operatorIndex ? undefined : saved?.[moduleNodeId(project, module)];
          return at
            ? { width: Math.max(box.width, at.x + MODULE_W + 24), height: Math.max(box.height, at.y + MODULE_H + 24) }
            : box;
        },
        { width: size.width, height: size.height }
      );
      const frameData: FrameNodeData & Sig = {
        project,
        git: gitChips,
        servicesUp: up,
        servicesTotal: ownServices.length,
        servicesError,
        width: fit.width,
        height: fit.height,
        lamps,
        operatorStatus,
        _sig: JSON.stringify([project, gitChips, up, ownServices.length, servicesError, lamps, operatorStatus, fit]),
      };
      nodes.push({
        id,
        type: 'frame',
        position: saved?.[id] ?? defaults[id] ?? { x: 0, y: 0 },
        data: frameData,
        style: { width: fit.width, height: fit.height },
        zIndex: 0,
      });
      const layout = layoutFrame(project);
      project.modules.forEach((module, moduleIndex) => {
        if (moduleIndex === operatorIndex) return;
        const index = operatorIndex >= 0 && moduleIndex > operatorIndex ? moduleIndex - 1 : moduleIndex;
        const moduleId = moduleNodeId(project, module);
        const { chatId, moduleServices, running, status } = perModule[moduleIndex];
        const data: LanternModuleNodeData & Sig = {
          project,
          module,
          services: moduleServices,
          running,
          hasChat: Boolean(chatId),
          status,
          index,
          _sig: JSON.stringify([module, moduleServices, running, Boolean(chatId), status]),
        };
        nodes.push({
          id: moduleId,
          type: 'lanternModule',
          parentId: id,
          extent: 'parent',
          position: saved?.[moduleId] ?? layout.positions[module.id],
          data,
          zIndex: 2,
        });
      });
    }
    return nodes;
  }, [projects, git, services, servicesError, sideChats, isGenerating, isWaiting, saved]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const placed = useRef(false);
  useEffect(() => {
    if (!saved) return;
    setNodes((current) => {
      const byId = new Map(current.map((node) => [node.id, node]));
      return built.map((node) => {
        const prev = byId.get(node.id);
        if (!prev) return node;
        const same = (prev.data as Sig)._sig === (node.data as Sig)._sig;
        return same ? prev : { ...prev, data: node.data, style: node.style };
      });
    });
  }, [built, saved, setNodes]);

  useEffect(() => {
    if (placed.current || nodes.length === 0) return;
    placed.current = true;
    const timer = setTimeout(() => void fitView({ padding: 0.12, duration: 300, maxZoom: 1 }), 60);
    return () => clearTimeout(timer);
  }, [nodes.length, fitView]);

  // All links are drawn under the cards; the selected module's links are lit up.
  const [focus, setFocus] = useState<string | null>(null);
  // A string, so the links only rebuild when the set of running modules really changes.
  const runningKey = useMemo(
    () =>
      built
        .filter(
          (node) =>
            node.type === 'lanternModule' && (node.data as unknown as LanternModuleNodeData).status === 'running'
        )
        .map((node) => node.id)
        .join('|'),
    [built]
  );
  const edges = useMemo<Edge[]>(() => {
    const list: Edge[] = [];
    const runningIds = new Set(runningKey.split('|'));
    for (const project of projects) {
      const layout = layoutFrame(project);
      for (const edge of layout.edges) {
        const source = `${project.dir}#${edge.source}`;
        const target = `${project.dir}#${edge.target}`;
        const lit = focus !== null && (source === focus || target === focus);
        const dim = focus !== null && !lit;
        const from = layout.positions[edge.source];
        const to = layout.positions[edge.target];
        const data: RoutedEdgeData = {
          points: edge.points,
          from: { x: from.x + MODULE_W / 2, y: from.y + MODULE_H },
          to: { x: to.x + MODULE_W / 2, y: to.y },
        };
        if (hud) {
          // HUD: thin dashed links; a link touching a running module carries a moving pulse.
          const live = runningIds.has(source) || runningIds.has(target);
          list.push({
            id: edge.id,
            source,
            target,
            type: 'routed',
            data,
            zIndex: 1,
            className: live ? styles.edgeLive : styles.edgeHud,
            style: { strokeOpacity: dim ? 0.25 : 1, strokeWidth: lit ? 1.6 : live ? 1.2 : 1 },
          });
          continue;
        }
        list.push({
          id: edge.id,
          source,
          target,
          type: 'routed',
          data,
          zIndex: 1,
          animated: lit,
          markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: edge.color ?? 'var(--bg-5)' },
          style: {
            stroke: edge.color ?? 'var(--bg-5)',
            strokeOpacity: dim ? 0.15 : lit ? 1 : 0.6,
            strokeWidth: lit ? 2.2 : 1.4,
          },
        });
      }
    }
    return list;
  }, [projects, focus, hud, runningKey]);

  // Pause link pulses and hide overlays while something moves; nothing animates during a drag.
  const setMoving = useCallback(
    (moving: boolean) => {
      canvasRef.current?.classList.toggle(styles.moving, moving);
      onMotion?.(moving);
    },
    [onMotion]
  );

  const onNodeDragStop = useCallback<OnNodeDrag>(
    (_event, _node, dragged) => {
      setMoving(false);
      setSaved((prev) => {
        const next = { ...prev };
        for (const node of dragged) next[node.id] = node.position;
        void ipcBridge.cockpit.saveBoardLayout.invoke({ project: LAYOUT_KEY, positions: next });
        return next;
      });
    },
    [setMoving]
  );

  const onNodeClick = useCallback<NodeMouseHandler>(
    (_event, node) => {
      setFocus(node.type === 'frame' ? null : node.id);
      if (node.type === 'frame')
        onSelect({ kind: 'project', project: (node.data as unknown as FrameNodeData).project });
      else {
        const data = node.data as unknown as LanternModuleNodeData;
        onSelect({ kind: 'module', project: data.project, module: data.module });
      }
    },
    [onSelect]
  );
  const onNodeDoubleClick = useCallback<NodeMouseHandler>(
    (_event, node) => {
      if (node.type === 'frame') onOpenChats((node.data as unknown as FrameNodeData).project.dir);
    },
    [onOpenChats]
  );

  return (
    <div ref={canvasRef} className={styles.canvas} data-testid='projects-board' data-board-style={lanternStyle}>
      {hud && (
        <svg className={styles.sun} viewBox='0 0 180 180' aria-hidden='true'>
          <clipPath id='lantern-sun'>
            <circle cx='90' cy='90' r='64' />
          </clipPath>
          <circle cx='90' cy='90' r='64' fill='var(--hud-signal)' />
          <g clipPath='url(#lantern-sun)' stroke='var(--hud-space)' strokeWidth='5'>
            <path d='M0 200L200 0M0 220L220 0M0 240L240 0M0 260L260 0' />
          </g>
        </svg>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStart={() => setMoving(true)}
        onNodeDragStop={onNodeDragStop}
        onMoveStart={() => setMoving(true)}
        onMoveEnd={() => setMoving(false)}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={() => {
          setFocus(null);
          onSelect({ kind: 'pc' });
        }}
        nodesConnectable={false}
        zoomOnDoubleClick={false}
        colorMode='light'
        minZoom={0.15}
        maxZoom={1.6}
      >
        <ZoomVar target={canvasRef} />
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} color='var(--board-dot)' />
        <Controls showInteractive={false} position='bottom-right' />
        <MiniMap
          position='bottom-right'
          style={{ marginBottom: 120 }}
          pannable
          zoomable
          nodeBorderRadius={8}
          nodeColor={(node) =>
            node.type === 'frame'
              ? 'transparent'
              : ((node.data as unknown as LanternModuleNodeData).module.color ?? 'var(--bg-4)')
          }
          nodeStrokeColor={(node) =>
            node.type === 'frame'
              ? ((node.data as unknown as FrameNodeData).project.color ?? 'var(--bg-5)')
              : 'transparent'
          }
        />
      </ReactFlow>
    </div>
  );
};

/**
 * Mirrors the board zoom into `--board-zoom` on the canvas so frame titles can
 * counter-scale in CSS. Rounded, so a zoom gesture writes only a few values.
 */
const ZoomVar: React.FC<{ target: React.RefObject<HTMLDivElement | null> }> = ({ target }) => {
  const zoom = useStore((state) => Math.round(state.transform[2] * 50) / 50);
  useEffect(() => {
    target.current?.style.setProperty('--board-zoom', String(zoom));
  }, [target, zoom]);
  return null;
};

export default ProjectsCanvas;
