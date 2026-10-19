import { describe, expect, it } from 'vitest';
import type { LanternModule, LanternProject } from '@/common/types/cockpitProjects';
import type { HandoffTarget } from '@renderer/pages/cockpit/handoff/handoffTargets';
import {
  agentKind,
  contextPointer,
  frameLayout,
  frameSize,
  layoutFrame,
  matchContinueCommand,
  moduleStatus,
  pickAgentTarget,
  targetKey,
} from '@renderer/pages/cockpit/projects/projectsGraph';

const mod = (id: string, name: string, extra: Partial<LanternModule> = {}): LanternModule => ({
  id,
  name,
  kind: 'agent',
  folder: 'C:/P/Rayak',
  ...extra,
});
const project = (name: string, modules: LanternModule[]): LanternProject => ({
  dir: `C:/P/${name}`,
  name,
  members: [],
  servicePrefixes: [],
  contextFiles: [`C:/P/${name}/CLAUDE.md`],
  modules,
});

const rayak = project('Rayak', [
  mod('operator', 'Operator', { kind: 'operator' }),
  mod('website', 'Website', { context: 'C:/P/Rayak/.lantern/modules/website.md' }),
  mod('scraping', 'Daily scraping', { kind: 'service' }),
]);
const lantern = project('Lantern', [mod('operator', 'Operator', { kind: 'operator' }), mod('usage', 'Usage tracker')]);

describe('matchContinueCommand', () => {
  it('finds a module by project and module name', () => {
    const match = matchContinueCommand('continue on the rayak website', [rayak, lantern]);
    expect(match?.project.name).toBe('Rayak');
    expect(match?.module.id).toBe('website');
  });
  it('uses the project name to break ties between operators', () => {
    expect(matchContinueCommand('switch to lantern operator', [rayak, lantern])?.project.name).toBe('Lantern');
  });
  it('is ambiguous without the project name', () => {
    expect(matchContinueCommand('continue with the operator', [rayak, lantern])).toBeNull();
  });
  it('ignores ordinary messages', () => {
    expect(matchContinueCommand('what is the website doing?', [rayak, lantern])).toBeNull();
    expect(matchContinueCommand('continue', [rayak, lantern])).toBeNull();
  });
});

describe('targets and layout', () => {
  it('maps a project to its operator chat', () => {
    expect(targetKey({ kind: 'project', project: rayak })).toBe('module:c:/p/rayak#operator');
    expect(targetKey({ kind: 'pc' })).toBe('pc');
  });
  it('places the master frame at the origin and the rest to its right', () => {
    const layout = frameLayout([rayak, lantern]);
    expect(layout[`frame:${rayak.dir}`]).toEqual({ x: 0, y: 0 });
    expect(layout[`frame:${lantern.dir}`].x).toBeGreaterThan(frameSize(rayak).width);
  });
  it('points module chats at their context files instead of inlining them', () => {
    const text = contextPointer({ kind: 'module', project: rayak, module: rayak.modules[1] }, 'C:/P');
    expect(text).toContain('website.md');
    expect(text).toContain('CLAUDE.md');
  });
});

describe('pickAgentTarget', () => {
  const targets: HandoffTarget[] = [
    { key: 'cc', assistantId: 'cc', label: 'Claude Code', backend: 'acp' },
    { key: 'mac', assistantId: 'mac', label: 'Claude Code · Mac mini', backend: 'acp' },
    { key: 'cx', assistantId: 'cx', label: 'Codex CLI', backend: 'acp' },
    {
      key: 'q',
      assistantId: 'aion',
      label: 'Aion CLI · qwen3.8:27b',
      backend: 'aionrs',
      model: { use_model: 'qwen3.8:27b' } as HandoffTarget['model'],
    },
  ];
  it('follows the module llm label', () => {
    expect(pickAgentTarget('Codex', targets)?.key).toBe('cx');
    expect(pickAgentTarget('Qwen 3.8 (local)', targets)?.key).toBe('q');
    expect(pickAgentTarget('Claude Sonnet', targets)?.key).toBe('cc');
    expect(pickAgentTarget(undefined, targets)?.key).toBe('cc');
  });
});

describe('layoutFrame', () => {
  const chain = project('Chain', [
    mod('operator', 'Operator', { kind: 'operator', links: ['design', 'website', 'repo'] }),
    mod('design', 'Design', { links: ['website'] }),
    mod('website', 'Website', { links: ['repo'] }),
    mod('repo', 'Repository'),
  ]);
  it('gives the operator no card and puts each module below the ones that feed it', () => {
    const { positions } = layoutFrame(chain);
    expect(positions.operator).toBeUndefined();
    expect(positions.design.y).toBe(108);
    expect(positions.design.y).toBeLessThan(positions.website.y);
    expect(positions.website.y).toBeLessThan(positions.repo.y);
  });
  it('routes module links but leaves the operator links implied', () => {
    const { edges } = layoutFrame(chain);
    expect(edges.map((edge) => `${edge.source}->${edge.target}`).toSorted()).toEqual([
      'design->website',
      'website->repo',
    ]);
    expect(edges.every((edge) => edge.points.length >= 2)).toBe(true);
  });
});

describe('agentKind', () => {
  it('maps llm labels to agent families, Claude by default', () => {
    expect(agentKind(undefined)).toBe('claude');
    expect(agentKind('Claude Opus')).toBe('claude');
    expect(agentKind('Codex')).toBe('codex');
    expect(agentKind('GPT-5')).toBe('codex');
    expect(agentKind('Qwen 27B (local)')).toBe('qwen');
    expect(agentKind('Gemini')).toBe('other');
  });
});

describe('moduleStatus', () => {
  const svc = (running: boolean, lastExit = 0) => ({ label: 'x', pid: running ? 1 : null, lastExit, running });
  it('ranks needs you over failed over running over idle', () => {
    expect(moduleStatus({ generating: true, waiting: true, services: [svc(false, 1)] })).toBe('waiting');
    expect(moduleStatus({ generating: true, waiting: false, services: [svc(false, 1)] })).toBe('failed');
    expect(moduleStatus({ generating: true, waiting: false, services: [] })).toBe('running');
    expect(moduleStatus({ generating: false, waiting: false, services: [svc(true)] })).toBe('running');
    expect(moduleStatus({ generating: false, waiting: false, services: [svc(false)] })).toBe('idle');
  });
});
