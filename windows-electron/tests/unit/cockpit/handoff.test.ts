import { describe, expect, it } from 'vitest';
import type { TMessage } from '@/common/chat/chatLib';
import type { IProvider } from '@/common/config/storage';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import {
  buildHandoffPrompt,
  buildHandoffTranscript,
  toHandoffRows,
} from '@/renderer/pages/cockpit/handoff/handoffTranscript';
import { buildHandoffTargets } from '@/renderer/pages/cockpit/handoff/handoffTargets';

const text = (id: string, position: 'left' | 'right', content: string): TMessage =>
  ({ id, msg_id: id, conversation_id: 'c1', type: 'text', position, content: { content } }) as TMessage;

const source = { id: 'c1', name: 'Fix login', agentName: 'Codex CLI', workspace: 'C:/proj' };

describe('handoff transcript', () => {
  it('turns text and tool messages into rows and skips hidden ones', () => {
    const rows = toHandoffRows([
      text('1', 'right', 'hello'),
      { ...text('2', 'left', 'secret'), hidden: true } as TMessage,
      {
        id: '3',
        conversation_id: 'c1',
        type: 'acp_tool_call',
        content: { update: { title: 'Read file', status: 'completed' } },
      } as unknown as TMessage,
      text('4', 'left', 'done'),
    ]);
    expect(rows).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'tool', text: 'Read file (completed)' },
      { role: 'agent', text: 'done' },
    ]);
  });

  it('keeps the first user message and the newest rows when over budget', () => {
    const messages = [text('0', 'right', 'FIRST TASK')];
    for (let i = 1; i <= 50; i++)
      messages.push(text(String(i), i % 2 ? 'left' : 'right', `row ${i} ${'x'.repeat(50)}`));
    const out = buildHandoffTranscript(source, messages, 1500);
    expect(out).toContain('FIRST TASK');
    expect(out).toContain('row 50');
    expect(out).not.toContain('row 2 ');
    expect(out).toMatch(/\d+ earlier rows omitted/);
    expect(out.indexOf('row 49')).toBeLessThan(out.indexOf('row 50'));
    expect(out).toContain('- Workspace: C:/proj');
  });

  it('names the agent and the attached file in the prompt', () => {
    expect(buildHandoffPrompt(source, 'C:/t.md')).toContain('Codex CLI');
    expect(buildHandoffPrompt(source, 'C:/t.md')).toContain('C:/t.md');
  });
});

describe('handoff targets', () => {
  const assistant = (id: string, type: string, backend?: string, extra: Partial<Assistant> = {}): Assistant =>
    ({
      id,
      name: id,
      source: 'generated',
      enabled: true,
      agent_status: 'online',
      agent: { type, acp_backend: backend },
      ...extra,
    }) as unknown as Assistant;
  const providers = [
    { id: 'p1', models: ['qwen3.8:27b', 'off-model'], model_enabled: { 'off-model': false } },
  ] as unknown as IProvider[];

  it('expands Aion CLI per enabled model and skips the current and offline agents', () => {
    const targets = buildHandoffTargets(
      [
        assistant('aion', 'aionrs'),
        assistant('claude', 'acp', 'claude'),
        assistant('codex', 'acp', 'codex'),
        assistant('offline', 'acp', 'x', { agent_status: 'offline' } as Partial<Assistant>),
        assistant('preset', 'acp', 'claude', { source: 'builtin' } as Partial<Assistant>),
      ],
      providers,
      'codex'
    );
    expect(targets.map((t) => t.key)).toEqual(['aion::p1::qwen3.8:27b', 'claude']);
    expect(targets[0].model?.use_model).toBe('qwen3.8:27b');
    expect(targets[0].backend).toBe('aionrs');
  });
});
