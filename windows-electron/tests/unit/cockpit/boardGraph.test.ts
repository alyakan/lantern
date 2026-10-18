import { describe, expect, it } from 'vitest';
import type { TChatConversation } from '@/common/config/storage';
import {
  agentTone,
  buildLinks,
  layoutModules,
  listProjects,
  moduleStatus,
  normalizeWorkspace,
  parseSessionMentions,
  projectConversations,
  sameCard,
  toModule,
} from '@renderer/pages/cockpit/board/boardGraph';

const chat = (
  id: string,
  extra: Record<string, unknown>,
  modified_at = 1,
  runtime?: Record<string, unknown>
): TChatConversation =>
  ({ id, name: `chat ${id}`, type: 'acp', extra, modified_at, created_at: 0, runtime }) as unknown as TChatConversation;

describe('normalizeWorkspace', () => {
  it('normalizes backslashes and trailing slashes', () => {
    expect(normalizeWorkspace('C:\\a\\b\\')).toBe('c:/a/b');
  });
});

describe('listProjects', () => {
  it('dedupes paths and orders by latest modified_at', () => {
    const c1 = chat('1', { workspace: 'C:\\p', custom_workspace: true }, 1);
    const c2 = chat('2', { workspace: 'c:/p/', custom_workspace: true }, 2);
    const c3 = chat('3', { workspace: 'D:\\q', custom_workspace: true }, 3);
    expect(listProjects([c1, c2, c3])).toEqual(['D:\\q', 'C:\\p']);
  });
});

describe('projectConversations', () => {
  it('filters by workspace', () => {
    const c1 = chat('1', { workspace: 'C:\\p' }, 1);
    const c2 = chat('2', { workspace: 'D:\\q' }, 2);
    expect(projectConversations([c1, c2], 'c:/p')).toEqual([c1]);
  });
});

describe('parseSessionMentions', () => {
  it('extracts ids from AION_SESSIONS block', () => {
    const text =
      'hello\n\n[[AION_SESSIONS]]\nhint line\nFoo\tid-1\tworkspace: same\nBar\tid-2\tworkspace: C:/x\n[[/AION_SESSIONS]]';
    expect(parseSessionMentions(text)).toEqual(['id-1', 'id-2']);
  });

  it('returns empty array for plain text', () => {
    expect(parseSessionMentions('plain text')).toEqual([]);
  });
});

describe('buildLinks', () => {
  it('creates fork, handoff, delegate, module, and mention links', () => {
    const parent = chat('parent', {}, 1);
    const forkChild = chat('forkChild', { fork: { parent_conversation_id: 'parent' } }, 2);
    const handoffChild = chat('handoffChild', { handoff_from: 'parent' }, 3);
    const delegateChild = chat('delegateChild', { delegated_from: 'parent' }, 4);
    const moduleChild = chat('moduleChild', { board_parent: 'parent' }, 5);
    const mentionSource = chat('mentionSource', {}, 6);
    const mentionTarget = chat('mentionTarget', {}, 7);

    const conversations = [parent, forkChild, handoffChild, delegateChild, moduleChild, mentionSource, mentionTarget];
    const mentions = { mentionSource: ['mentionTarget'] };

    const links = buildLinks(conversations, mentions);
    const linkIds = links.map((l) => `${l.source}->${l.target}:${l.kind}`).toSorted();

    expect(linkIds).toContain('parent->forkChild:fork');
    expect(linkIds).toContain('parent->handoffChild:handoff');
    expect(linkIds).toContain('parent->delegateChild:delegate');
    expect(linkIds).toContain('parent->moduleChild:module');
    expect(linkIds).toContain('mentionSource->mentionTarget:mention');
  });

  it('drops links to chats not on the board and self links', () => {
    const a = chat('a', { handoff_from: 'b' }, 1);
    const b = chat('b', { handoff_from: 'a' }, 2);
    const c = chat('c', { handoff_from: 'd' }, 3); // d is not on board
    const d = chat('d', { handoff_from: 'c' }, 4); // c is on board, but d is not in the list passed? No, d is in the list.
    // Let's make a case where target is not in the list.
    const e = chat('e', { handoff_from: 'f' }, 5); // f is not in the list

    const conversations = [a, b, c, e];
    const links = buildLinks(conversations);
    const linkIds = links.map((l) => `${l.source}->${l.target}`).toSorted();

    // a->b is valid (both in list)
    // b->a is valid (both in list)
    // c->d is invalid (d not in list)
    // e->f is invalid (f not in list)
    expect(linkIds).toEqual(['a->b', 'b->a']);
  });

  it('keeps only the first link per pair', () => {
    const a = chat('a', {}, 1);
    const b = chat('b', { handoff_from: 'a', fork: { parent_conversation_id: 'a' } }, 2);
    const conversations = [a, b];
    const links = buildLinks(conversations);
    expect(links).toHaveLength(1);
    expect(links[0].kind).toBe('fork');
  });
});

describe('moduleStatus', () => {
  it('returns waiting if waiting flag is true', () => {
    const c = chat('1', {}, 1);
    expect(moduleStatus(c, { generating: false, waiting: true })).toBe('waiting');
  });

  it('returns running if generating flag is true', () => {
    const c = chat('1', {}, 1);
    expect(moduleStatus(c, { generating: true, waiting: false })).toBe('running');
  });

  it('returns running if runtime.state is running', () => {
    const c = chat('1', {}, 1, { state: 'running' });
    expect(moduleStatus(c, { generating: false, waiting: false })).toBe('running');
  });

  it('returns waiting if runtime.state is waiting_confirmation', () => {
    const c = chat('1', {}, 1, { state: 'waiting_confirmation' });
    expect(moduleStatus(c, { generating: false, waiting: false })).toBe('waiting');
  });

  it('returns idle otherwise', () => {
    const c = chat('1', {}, 1, { state: 'idle' });
    expect(moduleStatus(c, { generating: false, waiting: false })).toBe('idle');
  });
});

describe('layoutModules', () => {
  it('puts a child below its parent (greater y)', () => {
    const parent = toModule(chat('parent', {}, 1), { generating: false, waiting: false });
    const child = toModule(chat('child', { board_parent: 'parent' }, 2), { generating: false, waiting: false });
    const links = buildLinks([chat('parent', {}, 1), chat('child', { board_parent: 'parent' }, 2)]);
    const positions = layoutModules([parent, child], links);
    expect(positions['child'].y).toBeGreaterThan(positions['parent'].y);
  });

  it('puts two roots side by side (same y, different x)', () => {
    const root1 = toModule(chat('root1', {}, 1), { generating: false, waiting: false });
    const root2 = toModule(chat('root2', {}, 2), { generating: false, waiting: false });
    const links = buildLinks([chat('root1', {}, 1), chat('root2', {}, 2)]);
    const positions = layoutModules([root1, root2], links);
    expect(positions['root1'].y).toBe(positions['root2'].y);
    expect(positions['root1'].x).not.toBe(positions['root2'].x);
  });

  it('ignores mention links for the tree', () => {
    const a = toModule(chat('a', {}, 1), { generating: false, waiting: false });
    const b = toModule(chat('b', {}, 2), { generating: false, waiting: false });
    const mentions = { a: ['b'] };
    const links = buildLinks([chat('a', {}, 1), chat('b', {}, 2)], mentions);
    const positions = layoutModules([a, b], links);
    // Both should be roots, so same y
    expect(positions['a'].y).toBe(positions['b'].y);
  });

  it('saved positions override but only for modules on the board', () => {
    const a = toModule(chat('a', {}, 1), { generating: false, waiting: false });
    const b = toModule(chat('b', {}, 2), { generating: false, waiting: false });
    const links = buildLinks([chat('a', {}, 1), chat('b', {}, 2)]);
    const saved = { a: { x: 100, y: 100 }, c: { x: 200, y: 200 } };
    const positions = layoutModules([a, b], links, saved);
    expect(positions['a']).toEqual({ x: 100, y: 100 });
    expect(positions['c']).toBeUndefined();
  });
});

describe('agentTone', () => {
  it('maps agents to their board colour family', () => {
    expect(agentTone({ agentName: 'Claude Code', backend: 'claude' })).toBe('claude');
    expect(agentTone({ agentName: 'Codex CLI', backend: 'codex' })).toBe('codex');
    expect(agentTone({ agentName: 'Aion CLI', backend: 'aionrs' })).toBe('qwen');
    expect(agentTone({ agentName: 'Claude Code · Mac mini', backend: 'claude' })).toBe('remote');
    expect(agentTone({ agentName: 'Gemini', backend: 'gemini' })).toBe('other');
  });
});

describe('sameCard', () => {
  const base = { id: 'a', name: 'Chat', agentName: 'Claude Code', status: 'idle' as const, modifiedAt: 1 };
  it('ignores modifiedAt so streaming does not re-render cards', () => {
    expect(sameCard(base, { ...base, modifiedAt: 99 })).toBe(true);
  });
  it('detects visible changes', () => {
    expect(sameCard(base, { ...base, status: 'running' })).toBe(false);
    expect(sameCard(base, { ...base, name: 'Renamed' })).toBe(false);
  });
});
