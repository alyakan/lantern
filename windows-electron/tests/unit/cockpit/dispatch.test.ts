import { describe, expect, it } from 'vitest';
import type { PulseSnapshot } from '@/common/types/cockpitPulse';
import {
  classifyTask,
  dispatch,
  learn,
  toneOf,
  type DispatchCandidate,
} from '@renderer/pages/cockpit/dispatch/dispatch';

const candidates: DispatchCandidate[] = [
  { key: 'claude', label: 'Claude Code', tone: 'claude', assistantId: 'c' },
  { key: 'codex', label: 'Codex CLI', tone: 'codex', assistantId: 'x' },
  { key: 'qwen', label: 'Aion CLI · qwen3.8:27b', tone: 'qwen', assistantId: 'a' },
];

const pulse = (over: Partial<PulseSnapshot> = {}): PulseSnapshot => ({
  claude: { fiveHour: { usedPercent: 10 }, week: { usedPercent: 40 }, seenAt: 0 },
  codex: { fiveHour: { usedPercent: 4 }, week: { usedPercent: 2 }, seenAt: 0 },
  qwen: { running: true, loaded: [], installed: ['qwen3.8:27b'] },
  gameMode: false,
  at: 0,
  ...over,
});

const pick = (text: string, goal: Parameters<typeof dispatch>[1] = 'auto', snapshot = pulse()) =>
  dispatch(text, goal, candidates, snapshot).ranked[0].candidate.tone;

describe('classifyTask', () => {
  it.each([
    ['Refactor the board across the codebase', 'codeLarge'],
    ["Write this month's Supernova blog post", 'writing'],
    ['rename the keys from camelCase to kebab-case', 'mechanical'],
    ["I feel stressed and I'm sleeping badly", 'personal'],
    ['why is the service failing on the mac mini', 'ops'],
    ['fix this TypeError in the component', 'codeSmall'],
    ['compare the latest pricing of grocery apps', 'research'],
    ["What's the capital of Peru?", 'quick'],
  ])('%s → %s', (text, kind) => {
    expect(classifyTask(text)).toBe(kind);
  });
});

describe('dispatch', () => {
  it('sends big code changes to Claude on Auto (best)', () => {
    expect(pick('Refactor the board so frames share one layout engine across the codebase')).toBe('claude');
  });

  it('keeps personal tasks on the local model', () => {
    const result = dispatch('I feel stressed, help me reflect on this week', 'auto', candidates, pulse());
    expect(result.ranked[0].candidate.tone).toBe('qwen');
    expect(result.ranked[0].reasons[0].key).toBe('private');
  });

  it('prefers the free local model for quick questions on Auto (thrifty)', () => {
    expect(pick("What's the capital of Peru?")).toBe('qwen');
  });

  it('skips the local model in game mode', () => {
    expect(pick('I feel stressed, help me reflect', 'auto', pulse({ gameMode: true }))).not.toBe('qwen');
  });

  it('avoids a plan that is nearly out', () => {
    const tight = pulse({ claude: { fiveHour: { usedPercent: 95 }, week: { usedPercent: 50 }, seenAt: 0 } });
    expect(pick("Write this month's blog post about design tokens", 'best', tight)).not.toBe('claude');
  });

  it('labels only the top-quality agent as strong and the runner-up as close', () => {
    const result = dispatch('Refactor the app across the codebase', 'best', candidates, pulse());
    expect(result.ranked[0].reasons[0].key).toBe('strong.codeLarge');
    expect(result.ranked[1].reasons[0].key).toBe('close');
  });

  it('learns from repeated overrides', () => {
    let prefs = {};
    for (let i = 0; i < 6; i++) prefs = learn(prefs, 'codeLarge', 'claude', 'codex');
    const result = dispatch('Refactor the app across the codebase', 'best', candidates, pulse(), prefs);
    expect(result.ranked[0].candidate.tone).toBe('codex');
    expect(result.ranked[0].reasons.some((r) => r.key === 'learned')).toBe(true);
  });

  it('maps agent names to tones', () => {
    expect(toneOf('Claude Code · Mac mini')).toBe('remote');
    expect(toneOf('Codex CLI')).toBe('codex');
    expect(toneOf('Aion CLI · qwen3.8:27b')).toBe('qwen');
  });
});
