/**
 * Pure model for the Lantern board: which chats belong to a project, how they
 * link to each other, and where each card sits.
 */

import type { TChatConversation } from '@/common/config/storage';

export type BoardEdgeKind = 'fork' | 'handoff' | 'delegate' | 'module' | 'mention';
export type BoardStatus = 'running' | 'waiting' | 'idle';
export type BoardPosition = { x: number; y: number };

export type BoardModule = {
  id: string;
  name: string;
  agentName: string;
  agentAvatar?: string;
  backend?: string;
  status: BoardStatus;
  modifiedAt: number;
};

export type BoardLink = { id: string; source: string; target: string; kind: BoardEdgeKind };

const SESSIONS_START = '[[AION_SESSIONS]]';
const SESSIONS_END = '[[/AION_SESSIONS]]';

export const NODE_WIDTH = 272;
export const NODE_GAP_X = 60;
export const NODE_GAP_Y = 90;
const NODE_HEIGHT = 96;

type Extra = {
  workspace?: string;
  custom_workspace?: boolean;
  handoff_from?: string;
  delegated_from?: string;
  board_parent?: string;
  fork?: { parent_conversation_id?: string };
};

const extraOf = (conversation: TChatConversation): Extra => (conversation.extra ?? {}) as Extra;

/** Normalize a workspace path so `C:\a\b\` and `c:/a/b` compare equal. */
export function normalizeWorkspace(dir: string | undefined): string {
  if (!dir) return '';
  const unified = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-zA-Z]:/.test(unified) ? unified[0].toLowerCase() + unified.slice(1) : unified;
}

/** Distinct project folders (user-picked, not per-chat temp folders), most recently used first. */
export function listProjects(conversations: TChatConversation[]): string[] {
  const latest = new Map<string, { dir: string; at: number }>();
  for (const conversation of conversations) {
    const { workspace: dir, custom_workspace } = extraOf(conversation);
    if (!dir || custom_workspace !== true) continue;
    const key = normalizeWorkspace(dir);
    const at = conversation.modified_at ?? 0;
    const current = latest.get(key);
    if (!current || at > current.at) latest.set(key, { dir: current?.dir ?? dir, at });
  }
  return [...latest.values()].toSorted((a, b) => b.at - a.at).map((entry) => entry.dir);
}

export function projectConversations(conversations: TChatConversation[], project: string): TChatConversation[] {
  const key = normalizeWorkspace(project);
  return conversations.filter((conversation) => normalizeWorkspace(extraOf(conversation).workspace) === key);
}

/** Conversation ids referenced with `@@` in one message's text. */
export function parseSessionMentions(text: string): string[] {
  const ids: string[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf(SESSIONS_START, from);
    if (start < 0) return ids;
    const end = text.indexOf(SESSIONS_END, start);
    const block = text.slice(start + SESSIONS_START.length, end < 0 ? undefined : end);
    for (const line of block.split('\n')) {
      const parts = line.split('\t');
      if (parts.length >= 3 && parts[2].startsWith('workspace:') && parts[1].trim()) ids.push(parts[1].trim());
    }
    if (end < 0) return ids;
    from = end + SESSIONS_END.length;
  }
}

export function moduleStatus(
  conversation: TChatConversation,
  flags: { generating: boolean; waiting: boolean }
): BoardStatus {
  if (flags.waiting) return 'waiting';
  if (flags.generating) return 'running';
  const state = conversation.runtime?.state;
  if (state === 'waiting_confirmation') return 'waiting';
  return state && state !== 'idle' ? 'running' : 'idle';
}

export function toModule(
  conversation: TChatConversation,
  flags: { generating: boolean; waiting: boolean }
): BoardModule {
  return {
    id: conversation.id,
    name: conversation.name,
    agentName: conversation.assistant?.name ?? conversation.type,
    agentAvatar: conversation.assistant?.avatar,
    backend: conversation.assistant?.backend,
    status: moduleStatus(conversation, flags),
    modifiedAt: conversation.modified_at ?? 0,
  };
}

/**
 * Edges between chats on the board. Only edges whose both ends are on the
 * board are kept; the first kind wins when two chats are linked twice.
 */
export function buildLinks(conversations: TChatConversation[], mentions: Record<string, string[]> = {}): BoardLink[] {
  const ids = new Set(conversations.map((conversation) => conversation.id));
  const links = new Map<string, BoardLink>();
  const add = (source: string | undefined, target: string, kind: BoardEdgeKind) => {
    if (!source || source === target || !ids.has(source)) return;
    const id = `${source}->${target}`;
    if (!links.has(id)) links.set(id, { id, source, target, kind });
  };
  for (const conversation of conversations) {
    const extra = extraOf(conversation);
    add(extra.fork?.parent_conversation_id, conversation.id, 'fork');
    add(extra.handoff_from, conversation.id, 'handoff');
    add(extra.delegated_from, conversation.id, 'delegate');
    add(extra.board_parent, conversation.id, 'module');
  }
  for (const [source, targets] of Object.entries(mentions)) {
    if (!ids.has(source)) continue;
    for (const target of targets) if (ids.has(target)) add(source, target, 'mention');
  }
  return [...links.values()];
}

/**
 * Default tree layout: roots (no incoming tree edge) in a row ordered by age,
 * children below their parent. `@@` mentions do not shape the tree. Saved
 * positions win.
 */
export function layoutModules(
  modules: BoardModule[],
  links: BoardLink[],
  saved: Record<string, BoardPosition> = {}
): Record<string, BoardPosition> {
  const parentOf = new Map<string, string>();
  for (const link of links)
    if (link.kind !== 'mention' && !parentOf.has(link.target)) parentOf.set(link.target, link.source);
  const byAge = modules.toSorted((a, b) => a.modifiedAt - b.modifiedAt);
  const children = new Map<string, string[]>();
  for (const module of byAge) {
    const parent = parentOf.get(module.id);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), module.id]);
  }
  const positions: Record<string, BoardPosition> = {};
  let column = 0;
  const place = (id: string, depth: number, seen: Set<string>) => {
    if (seen.has(id)) return;
    seen.add(id);
    const kids = children.get(id) ?? [];
    const start = column;
    for (const kid of kids) place(kid, depth + 1, seen);
    if (kids.length === 0) column += 1;
    const span = Math.max(column - start, 1);
    positions[id] = {
      x: (start + (span - 1) / 2) * (NODE_WIDTH + NODE_GAP_X),
      y: depth * (NODE_HEIGHT + NODE_GAP_Y),
    };
  };
  const seen = new Set<string>();
  for (const module of byAge)
    if (!parentOf.has(module.id) || !modules.some((m) => m.id === parentOf.get(module.id))) place(module.id, 0, seen);
  // Cycles: anything not reached yet becomes its own root.
  for (const module of byAge) place(module.id, 0, seen);
  return { ...positions, ...Object.fromEntries(Object.entries(saved).filter(([id]) => id in positions)) };
}

export type AgentTone = 'claude' | 'codex' | 'qwen' | 'remote' | 'other';

/** Colour family of an agent on the board (see docs/cockpit/DESIGN.md). */
export function agentTone(module: Pick<BoardModule, 'backend' | 'agentName'>): AgentTone {
  const name = module.agentName.toLowerCase();
  if (name.includes('mac mini') || name.includes('remote')) return 'remote';
  const backend = (module.backend ?? '').toLowerCase();
  if (backend.includes('claude') || name.includes('claude')) return 'claude';
  if (backend.includes('codex') || name.includes('codex')) return 'codex';
  if (backend.includes('aionrs') || name.includes('aion') || name.includes('qwen')) return 'qwen';
  return 'other';
}

/** True when two modules render the same card (ignores modifiedAt). */
export function sameCard(a: BoardModule, b: BoardModule): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.agentName === b.agentName &&
    a.agentAvatar === b.agentAvatar &&
    a.backend === b.backend &&
    a.status === b.status
  );
}
