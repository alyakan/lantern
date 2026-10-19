/**
 * Project board nodes: a frame per project (header with git and service
 * chips) and a card per module (icon, colour, model, tools, live services).
 */

import type { GitStatus, LanternModule, LanternProject, MacService } from '@/common/types/cockpitProjects';
import { Button, Tooltip } from '@arco-design/web-react';
import { FullScreenOne } from '@icon-park/react';
import { BaseEdge, getSmoothStepPath, Handle, Position, type EdgeProps, type NodeProps } from '@xyflow/react';
import classNames from 'classnames';
import React, { createContext, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { useLanternStyle } from '@/renderer/utils/theme/lanternStyle';
import ModuleIcon, { AgentTile } from './ModuleIcon';
import { agentKind, operatorOf, type ModuleStatus, type Point } from './projectsGraph';
import styles from './ProjectsBoard.module.css';

export type FrameNodeData = {
  project: LanternProject;
  git: GitStatus[];
  servicesUp: number;
  servicesTotal: number;
  servicesError?: string;
  width: number;
  height: number;
  /** One status lamp per module card, in module order (the operator is not a card). */
  lamps: ModuleStatus[];
  /** The project's operator, which the frame itself stands for. */
  operatorStatus?: ModuleStatus;
};

export type LanternModuleNodeData = {
  project: LanternProject;
  module: LanternModule;
  services: MacService[];
  running: boolean;
  hasChat: boolean;
  status: ModuleStatus;
  /** Position within the project, for the staggered boot motion. */
  index: number;
};

/** Board-wide actions the memoised cards call without new node data. */
export type BoardActions = { openFull: (project: LanternProject, module: LanternModule) => void };
export const BoardActionsContext = createContext<BoardActions | null>(null);

export const Lamp: React.FC<{ status: ModuleStatus; delay?: number }> = ({ status, delay }) => (
  <span
    className='hud-lamp'
    data-state={status}
    style={delay === undefined ? undefined : { ['--lamp-delay' as string]: `${delay}s` }}
  />
);

const OpenFullButton: React.FC<{ project: LanternProject; module: LanternModule }> = ({ project, module }) => {
  const { t } = useTranslation();
  const actions = useContext(BoardActionsContext);
  if (!actions) return null;
  return (
    <Tooltip content={t('cockpit.side.openFull')}>
      <Button
        size='mini'
        type='text'
        className={classNames('nodrag', styles.openFull)}
        icon={<FullScreenOne />}
        aria-label={t('cockpit.side.openFull')}
        data-testid={`project-module-open-${module.id}`}
        onClick={(event) => {
          event.stopPropagation();
          actions.openFull(project, module);
        }}
      />
    </Tooltip>
  );
};

const AGENT_NAME = { claude: 'Claude Code', codex: 'Codex', qwen: 'Qwen' } as const;

const baseName = (dir: string) => dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;

export const GitChip: React.FC<{ status: GitStatus; label?: string }> = ({ status, label }) => {
  const { t } = useTranslation();
  return (
    <Tooltip content={t('cockpit.projects.gitTooltip', { dir: status.dir, dirty: status.dirty })}>
      <span className={classNames(styles.chip, status.dirty > 0 && styles.chipDirty)}>
        <span className={styles.chipDot} />
        {label ? `${label} · ` : ''}
        {status.branch || 'HEAD'}
        {status.ahead > 0 && ` ↑${status.ahead}`}
        {status.behind > 0 && ` ↓${status.behind}`}
        {status.dirty > 0 && ` ●${status.dirty}`}
      </span>
    </Tooltip>
  );
};

const ServiceChip: React.FC<{ label: string; service?: MacService }> = ({ label, service }) => {
  const { t } = useTranslation();
  const state = !service ? 'unknown' : service.running ? 'up' : service.lastExit !== 0 ? 'failed' : 'idle';
  return (
    <Tooltip
      content={t(`cockpit.projects.service.${state}`, { label, pid: service?.pid ?? '', code: service?.lastExit ?? 0 })}
    >
      <span className={classNames(styles.chip, styles[`service_${state}`])}>
        <span className={styles.chipDot} />
        {label.split('.').slice(-1)[0]}
      </span>
    </Tooltip>
  );
};

const FrameNodeView: React.FC<NodeProps> = ({ data, selected }) => {
  const { t } = useTranslation();
  const frame = data as unknown as FrameNodeData;
  const { project } = frame;
  const operator = operatorOf(project);
  const cards = project.modules.length - (operator ? 1 : 0);
  const operatorKind = operator ? agentKind(operator.llm) : 'other';
  const operatorAgent = operator && operatorKind !== 'other' ? AGENT_NAME[operatorKind] : operator?.llm;
  return (
    <div
      className={classNames(styles.frame, selected && styles.frameSelected)}
      style={{ width: frame.width, height: frame.height, ['--frame-color' as string]: project.color ?? 'var(--bg-6)' }}
      data-testid={`project-frame-${baseName(project.dir)}`}
    >
      <div className={styles.frameHeader}>
        <div className='flex items-center gap-8px min-w-0'>
          {/* Name tab; it grows over the header as the board zooms out so it stays readable. */}
          <span className={classNames(styles.frameTitle, selected && styles.frameTitleSelected)}>
            <span className={styles.frameTitleMark} />
            <span className='truncate'>{project.name}</span>
          </span>
          <span className={styles.frameMeta}>
            {cards > 0 ? t('cockpit.projects.moduleCount', { count: cards }) : t('cockpit.projects.noModules')}
          </span>
          {operator && (
            <span className={styles.frameOperator}>
              <Lamp status={frame.operatorStatus ?? 'idle'} delay={0.9} />
              <span className='truncate'>
                {t('cockpit.projects.kind.operator')}
                {operatorAgent ? ` · ${operatorAgent}` : ''}
              </span>
              <OpenFullButton project={project} module={operator} />
            </span>
          )}
          {(frame.lamps.length > 0 || operator) && (
            <span className={styles.frameLamps}>
              {operator && (
                <>
                  <Lamp status={frame.operatorStatus ?? 'idle'} delay={0.9} />
                  {frame.lamps.length > 0 && <span className={styles.frameLampsSep} />}
                </>
              )}
              {frame.lamps.map((status, i) => (
                <Lamp key={i} status={status} delay={1 + i * 0.1} />
              ))}
            </span>
          )}
        </div>
        {project.summary && <div className={styles.frameSummary}>{project.summary}</div>}
        <div className={styles.chipRow}>
          {frame.git.map((status) => (
            <GitChip
              key={status.dir}
              status={status}
              label={status.dir === project.dir ? undefined : baseName(status.dir)}
            />
          ))}
          {frame.servicesTotal > 0 && (
            <Tooltip content={frame.servicesError ?? t('cockpit.projects.servicesTooltip')}>
              <span
                className={classNames(styles.chip, frame.servicesError ? styles.service_failed : styles.service_up)}
              >
                <span className={styles.chipDot} />
                {frame.servicesError
                  ? t('cockpit.projects.macOffline')
                  : t('cockpit.projects.servicesUp', { up: frame.servicesUp, total: frame.servicesTotal })}
              </span>
            </Tooltip>
          )}
          {project.contextFiles.length > 0 && (
            <Tooltip content={project.contextFiles.join('\n')}>
              <span className={styles.chip}>
                {t('cockpit.projects.contextFiles', { count: project.contextFiles.length })}
              </span>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
};

const STATUS_KEY: Record<ModuleStatus, string> = {
  running: 'cockpit.projects.status.running',
  waiting: 'cockpit.projects.status.waiting',
  failed: 'cockpit.projects.status.failed',
  idle: 'cockpit.projects.status.idle',
};

/** HUD card: cream plate, agent tile, one line on what it does, lamp + what is happening. */
const HudModuleCard: React.FC<{ data: LanternModuleNodeData; selected: boolean }> = ({ data, selected }) => {
  const { t } = useTranslation();
  const { project, module, services, status, index } = data;
  const kind = agentKind(module.llm);
  const agent = kind === 'other' ? (module.llm ?? t(`cockpit.projects.kind.${module.kind}`)) : AGENT_NAME[kind];
  const up = services.filter((service) => service.running).length;
  const failed = services.find((service) => !service.running && service.lastExit !== 0);
  const detail =
    status === 'failed' && failed
      ? failed.label.split('.').slice(-1)[0]
      : services.length > 0
        ? t('cockpit.projects.servicesShort', { up, total: services.length })
        : '';
  return (
    <div
      className={classNames(styles.module, styles.hudCard, selected && styles.moduleSelected)}
      style={{ ['--i' as string]: index, ['--tone' as string]: module.color ?? `var(--agent-${kind})` }}
      data-kind={module.kind}
      data-status={status}
      data-testid={`project-module-${module.id}`}
    >
      <Handle type='target' position={Position.Top} className={styles.handle} />
      <div className={styles.hudHead}>
        <ModuleIcon icon={module.icon} color={module.color ?? `var(--agent-${kind})`} size={30} solid />
        <div className='min-w-0 flex-1'>
          <div className={styles.moduleName}>{module.name}</div>
          <div className={styles.hudAgent}>
            <AgentTile kind={kind} size={12} />
            <span className='truncate'>
              {agent} · {module.runsOn ?? 'PC'}
            </span>
          </div>
        </div>
        <OpenFullButton project={project} module={module} />
      </div>
      <div className={styles.hudDesc}>{module.summary ?? t(`cockpit.projects.kind.${module.kind}`)}</div>
      <div className={styles.hudStatus}>
        <Lamp status={status} delay={0.9 + index * 0.15} />
        <span className='truncate flex-1'>
          {t(STATUS_KEY[status])}
          {detail ? ` · ${detail}` : ''}
        </span>
        <span className={styles.hudCode}>
          {t(`cockpit.projects.kind.${module.kind}`)} · {String(index + 1).padStart(2, '0')}
        </span>
      </div>
      <Handle type='source' position={Position.Bottom} className={styles.handle} />
    </div>
  );
};

const LanternModuleNodeView: React.FC<NodeProps> = ({ data, selected }) => {
  const { t } = useTranslation();
  const style = useLanternStyle();
  const nodeData = data as unknown as LanternModuleNodeData;
  if (style === 'hud') return <HudModuleCard data={nodeData} selected={Boolean(selected)} />;
  const { project, module, services, running, hasChat } = nodeData;
  const byLabel = new Map(services.map((service) => [service.label, service]));
  return (
    <div
      className={classNames(styles.module, selected && styles.moduleSelected, running && styles.moduleRunning)}
      style={{ ['--tone' as string]: module.color ?? 'var(--bg-6)' }}
      data-testid={`project-module-${module.id}`}
    >
      <Handle type='target' position={Position.Top} className={styles.handle} />
      <div className='flex items-start gap-10px min-w-0'>
        <ModuleIcon icon={module.icon} color={module.color} />
        <div className='min-w-0 flex-1'>
          <div className='flex items-center gap-6px min-w-0'>
            <span className={styles.moduleName}>{module.name}</span>
            {hasChat && <span className={styles.chatDot} title={t('cockpit.projects.hasChat')} />}
          </div>
          <div className={styles.moduleMeta}>
            {t(`cockpit.projects.kind.${module.kind}`)} · {module.runsOn ?? 'pc'}
            {module.llm ? ` · ${module.llm}` : ''}
          </div>
        </div>
        <OpenFullButton project={project} module={module} />
      </div>
      <div className={styles.chipRow}>
        {(module.services ?? []).map((label) => (
          <ServiceChip key={label} label={label} service={byLabel.get(label)} />
        ))}
        {(module.services ?? []).length === 0 &&
          (module.tools ?? []).slice(0, 3).map((tool) => (
            <span key={tool} className={styles.chip}>
              {tool}
            </span>
          ))}
      </div>
      <Handle type='source' position={Position.Bottom} className={styles.handle} />
    </div>
  );
};

export const FrameNode = React.memo(FrameNodeView);
export const LanternModuleNode = React.memo(LanternModuleNodeView);

export type RoutedEdgeData = {
  /** Layout route (relative to the frame), from the source's bottom to the target's top. */
  points: Point[];
  /** Where the layout put the two handles, relative to the frame. */
  from: Point;
  to: Point;
};

/** Rounded polyline through the points. */
function roundedPath(points: Point[], radius = 12): string {
  let d = `M ${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [prev, at, next] = [points[i - 1], points[i], points[i + 1]];
    const lenIn = Math.hypot(at.x - prev.x, at.y - prev.y) || 1;
    const lenOut = Math.hypot(next.x - at.x, next.y - at.y) || 1;
    const r = Math.min(radius, lenIn / 2, lenOut / 2);
    const a = { x: at.x - ((at.x - prev.x) / lenIn) * r, y: at.y - ((at.y - prev.y) / lenIn) * r };
    const b = { x: at.x + ((next.x - at.x) / lenOut) * r, y: at.y + ((next.y - at.y) / lenOut) * r };
    d += ` L ${a.x},${a.y} Q ${at.x},${at.y} ${b.x},${b.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${last.x},${last.y}`;
}

/**
 * Edge that follows the layout's route around the cards. When a card has
 * been moved by hand the route no longer fits, so it falls back to a step path.
 */
const RoutedEdgeView: React.FC<EdgeProps> = ({ id, sourceX, sourceY, targetX, targetY, data, style, markerEnd }) => {
  const route = data as unknown as RoutedEdgeData | undefined;
  const dx = sourceX - (route?.from.x ?? 0);
  const dy = sourceY - (route?.from.y ?? 0);
  const fits =
    route &&
    route.points.length >= 2 &&
    Math.abs(targetX - route.to.x - dx) < 1 &&
    Math.abs(targetY - route.to.y - dy) < 1;
  const path = fits
    ? roundedPath([
        { x: sourceX, y: sourceY },
        ...route.points.slice(1, -1).map((point) => ({ x: point.x + dx, y: point.y + dy })),
        { x: targetX, y: targetY },
      ])
    : getSmoothStepPath({
        sourceX,
        sourceY,
        targetX,
        targetY,
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        borderRadius: 12,
      })[0];
  return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />;
};

export const RoutedEdge = React.memo(RoutedEdgeView);
