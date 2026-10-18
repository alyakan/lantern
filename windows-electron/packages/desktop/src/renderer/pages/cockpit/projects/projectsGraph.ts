/**
 * Project board (Phase 3) model: frames per project, module cards inside,
 * side-panel chat targets, and the "continue on <module>" command.
 */

import type { LanternModule, LanternProject, MacService } from '@/common/types/cockpitProjects';
import dagre from '@dagrejs/dagre';
import type { HandoffTarget } from '../handoff/handoffTargets';

export type BoardTarget =
  | { kind: 'pc' }
  | { kind: 'module'; project: LanternProject; module: LanternModule }
  | { kind: 'project'; project: LanternProject }
  | { kind: 'chat'; conversationId: string };

export const MODULE_W = 232;
export const MODULE_H = 118;
const PAD = 24;
const HEADER_H = 108;
const FRAME_GAP = 64;
const EMPTY_FRAME = { width: 320, height: 150 };

export const frameId = (project: LanternProject) => `frame:${project.dir}`;
export const moduleNodeId = (project: LanternProject, module: LanternModule) => `${project.dir}#${module.id}`;

export function operatorOf(project: LanternProject): LanternModule | undefined {
  return project.modules.find((module) => module.kind === 'operator');
}

/** A project's chat is its operator's chat when it has one. */
export function normalizeTarget(target: BoardTarget): BoardTarget {
  if (target.kind !== 'project') return target;
  const operator = operatorOf(target.project);
  return operator ? { kind: 'module', project: target.project, module: operator } : target;
}

/** Stable key a side chat is bound under (see cockpit-side-chats.json). */
export function targetKey(target: BoardTarget): string {
  const t = normalizeTarget(target);
  if (t.kind === 'pc') return 'pc';
  if (t.kind === 'chat') return `chat:${t.conversationId}`;
  if (t.kind === 'project') return `project:${t.project.dir.toLowerCase()}`;
  return `module:${t.project.dir.toLowerCase()}#${t.module.id}`;
}

export type Point = { x: number; y: number };
export type FrameEdge = {
  id: string;
  source: string;
  target: string;
  color?: string;
  /** Route around the cards from the layout, relative to the frame. */
  points: Point[];
};
export type FrameLayout = {
  width: number;
  height: number;
  /** Module positions relative to the frame, keyed by module id. */
  positions: Record<string, { x: number; y: number }>;
  edges: FrameEdge[];
};

const RANK_GAP = 56;
const NODE_GAP = 28;
const layoutCache = new WeakMap<LanternProject, FrameLayout>();

/**
 * Layered layout of a frame's modules (dagre): each module below the ones
 * that feed it, so links run downwards between rows instead of across cards.
 * The operator has no card: the frame itself is the operator (its header
 * carries the operator's lamp, and clicking the frame opens its chat).
 */
export function layoutFrame(project: LanternProject): FrameLayout {
  const cached = layoutCache.get(project);
  if (cached) return cached;
  if (project.modules.length === 0) return { ...EMPTY_FRAME, positions: {}, edges: [] };
  // The operator links to every module, so its links are implied by the frame.
  const operator = operatorOf(project);
  const rest = project.modules.filter((module) => module !== operator);
  const ids = new Set(rest.map((module) => module.id));
  const links: { source: LanternModule; target: string }[] = [];
  for (const module of rest)
    for (const link of module.links ?? [])
      if (ids.has(link) && link !== module.id) links.push({ source: module, target: link });

  const graph = new dagre.graphlib.Graph({ multigraph: false });
  graph.setGraph({ rankdir: 'TB', nodesep: NODE_GAP, ranksep: RANK_GAP, edgesep: 14, marginx: 0, marginy: 0 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const module of rest) graph.setNode(module.id, { width: MODULE_W, height: MODULE_H });
  for (const link of links) graph.setEdge(link.source.id, link.target, { minlen: 1 });
  dagre.layout(graph);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const module of rest) {
    const node = graph.node(module.id);
    minX = Math.min(minX, node.x - MODULE_W / 2);
    minY = Math.min(minY, node.y - MODULE_H / 2);
    maxX = Math.max(maxX, node.x + MODULE_W / 2);
    maxY = Math.max(maxY, node.y + MODULE_H / 2);
  }
  if (rest.length === 0) [minX, minY, maxX, maxY] = [0, 0, MODULE_W, 0];
  const top = HEADER_H;
  const shift = (point: Point): Point => ({ x: PAD + point.x - minX, y: top + point.y - minY });
  const positions: Record<string, { x: number; y: number }> = {};
  for (const module of rest) {
    const node = graph.node(module.id);
    positions[module.id] = shift({ x: node.x - MODULE_W / 2, y: node.y - MODULE_H / 2 });
  }
  const edges: FrameEdge[] = links.map((link) => ({
    id: `${project.dir}#${link.source.id}->${link.target}`,
    source: link.source.id,
    target: link.target,
    color: link.source.color,
    points: (graph.edge(link.source.id, link.target)?.points ?? []).map(shift),
  }));
  const height = rest.length ? top + maxY - minY + PAD : EMPTY_FRAME.height;
  const layout = {
    width: Math.max(EMPTY_FRAME.width, PAD * 2 + maxX - minX),
    height,
    positions,
    edges,
  };
  layoutCache.set(project, layout);
  return layout;
}

export function frameSize(project: LanternProject): { width: number; height: number } {
  const { width, height } = layoutFrame(project);
  return { width, height };
}

/**
 * Default frame layout: the master frame (most modules) at the origin, the
 * rest in two columns to its right, top to bottom.
 */
export function frameLayout(projects: LanternProject[]): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  const [master, ...rest] = projects;
  if (!master) return positions;
  positions[frameId(master)] = { x: 0, y: 0 };
  const left = frameSize(master).width + FRAME_GAP;
  const columnY = [0, 0];
  let columnW = 0;
  for (const project of rest) columnW = Math.max(columnW, frameSize(project).width);
  rest.forEach((project, index) => {
    const col = index % 2;
    positions[frameId(project)] = { x: left + col * (columnW + FRAME_GAP / 2), y: columnY[col] };
    columnY[col] += frameSize(project).height + FRAME_GAP / 2;
  });
  return positions;
}

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, ' ')
    .split(' ')
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
const STOP_WORDS = new Set(['the', 'on', 'with', 'in', 'to', 'of', 'and', 'my', 'module', 'project', 'please', 'work']);

const COMMAND =
  /^(?:let'?s\s+)?(?:continue|resume|switch|go|open|back|pick\s+up)\b\s*(?:to|on|with|in|working\s+on)?\s+(.+)$/i;

/**
 * "continue on the rayak website" → Rayak's Website module. The phrase must
 * name a module (by name or id); the project name narrows it down. Returns
 * null when nothing matches clearly, so ordinary messages go to the agent.
 */
export function matchContinueCommand(
  text: string,
  projects: LanternProject[]
): { project: LanternProject; module: LanternModule } | null {
  const command = COMMAND.exec(text.trim());
  if (!command || text.length > 120) return null;
  const phrase = words(command[1]);
  if (phrase.length === 0) return null;
  let best: { project: LanternProject; module: LanternModule; score: number } | null = null;
  let tie = false;
  for (const project of projects) {
    const projectWords = new Set(words(project.name));
    const projectHit = phrase.some((word) => projectWords.has(word));
    for (const module of project.modules) {
      const moduleWords = new Set([...words(module.name), ...words(module.id)]);
      const hits = phrase.filter((word) => moduleWords.has(word) || moduleWords.has(word.replace(/s$/, ''))).length;
      if (hits === 0) continue;
      const score = hits * 2 + (projectHit ? 1 : 0);
      if (!best || score > best.score) {
        best = { project, module, score };
        tie = false;
      } else if (score === best.score) tie = true;
    }
  }
  return best && !tie ? { project: best.project, module: best.module } : null;
}

export type AgentKind = 'claude' | 'codex' | 'qwen' | 'other';

/** The agent family behind a module, from its `llm` label. No label means Claude Code, like pickAgentTarget. */
export function agentKind(llm: string | undefined): AgentKind {
  const label = (llm ?? '').toLowerCase();
  if (!label || label.includes('claude')) return 'claude';
  if (label.includes('codex') || label.includes('gpt')) return 'codex';
  if (label.includes('qwen') || label.includes('local') || label.includes('ollama')) return 'qwen';
  return 'other';
}

export type ModuleStatus = 'running' | 'waiting' | 'failed' | 'idle';

/** One lamp per module: needs you beats failed beats running. */
export function moduleStatus(input: { generating: boolean; waiting: boolean; services: MacService[] }): ModuleStatus {
  if (input.waiting) return 'waiting';
  if (input.services.some((service) => !service.running && service.lastExit !== 0)) return 'failed';
  if (input.generating || input.services.some((service) => service.running)) return 'running';
  return 'idle';
}

/** Which agent a module's chat runs on, from its `llm` label. */
export function pickAgentTarget(llm: string | undefined, targets: HandoffTarget[]): HandoffTarget | undefined {
  const label = (llm ?? '').toLowerCase();
  const local = targets.filter((target) => !/mac mini/i.test(target.label));
  if (label.includes('codex') || label.includes('gpt')) {
    const codex = local.find((target) => /codex/i.test(target.label));
    if (codex) return codex;
  }
  if (label.includes('qwen') || label.includes('local')) {
    const qwen = local.find((target) => target.backend === 'aionrs' && /qwen/i.test(target.model?.use_model ?? ''));
    if (qwen) return qwen;
  }
  return local.find((target) => /^claude code$/i.test(target.label)) ?? local[0];
}

/** Short pointer to the files that hold a target's context; the agent reads them itself. */
export function contextPointer(target: BoardTarget, root: string): string {
  const t = normalizeTarget(target);
  if (t.kind === 'pc')
    return (
      `[Cockpit] You are the PC operator for every project under ${root}. Each project keeps its context in ` +
      'CLAUDE.md, AGENTS.md and .cockpit/ (CONTEXT.md, project.json, modules/*.md). Read what the task needs.'
    );
  if (t.kind === 'project')
    return `[Cockpit] You work on the ${t.project.name} project (${t.project.dir}). Context: ${t.project.contextFiles.join(', ') || 'none yet'}.`;
  if (t.kind === 'chat') return '';
  const files = [t.module.context, ...t.project.contextFiles].filter(Boolean).join(', ');
  return (
    `[Cockpit] You are the "${t.module.name}" module of the ${t.project.name} project. ` +
    `Read your context first: ${files || 'no notes yet'}. Keep your module notes up to date as you work.`
  );
}
