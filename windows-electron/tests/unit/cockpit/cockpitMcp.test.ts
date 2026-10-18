import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { Assistant } from '@/common/types/agent/assistantTypes';

vi.mock('@/common/adapter/httpBridge', () => ({ httpRequest: vi.fn() }));
vi.mock('@/common/adapter/ipcBridge', () => ({ mcpService: {} }));
vi.mock('@process/utils/initStorage', () => ({ getBuiltinMcpScriptPath: (name: string) => `/out/${name}.js` }));
vi.mock('@/common', () => ({ ipcBridge: {} }));

const { buildAgentAliases, buildCockpitMcpServer } = await import('@process/cockpit/cockpitMcp');
const { listSkillFolders, sharedSkillsDir, writeHandoffTranscript, safeFileStem } =
  await import('@process/cockpit/cockpitBridge');
const { buildDelegateMessage, missingRuntimeEnv, parseAgentAliases, aioncoreBin } =
  await import('@process/resources/builtinMcp/cockpitCli');

const assistant = (id: string, name: string, agent: Record<string, string>, source = 'generated'): Assistant =>
  ({ id, name, source, enabled: true, agent }) as unknown as Assistant;

describe('cockpit MCP registration', () => {
  it('maps bare agents to short aliases', () => {
    const aliases = buildAgentAliases([
      assistant('bare:a', 'Aion CLI', { type: 'aionrs', source: 'internal' }),
      assistant('bare:c', 'Claude Code', { type: 'acp', source: 'builtin', acp_backend: 'claude' }),
      assistant('bare:x', 'Codex CLI', { type: 'acp', source: 'builtin', acp_backend: 'codex' }),
      assistant('bare:m', 'Claude Code · Mac mini', { type: 'acp', source: 'custom', acp_backend: 'custom' }),
      assistant('preset', 'Butler', { type: 'acp' }, 'builtin'),
    ]);
    expect(aliases).toEqual({
      aion: 'bare:a',
      qwen: 'bare:a',
      claude: 'bare:c',
      codex: 'bare:x',
      'claude-code-mac-mini': 'bare:m',
    });
  });

  it('builds an enabled builtin stdio server with the aliases in env', () => {
    const server = buildCockpitMcpServer('/out/x.js', { claude: 'bare:c' });
    expect(server.enabled).toBe(true);
    expect(server.builtin).toBe(true);
    expect(server.transport).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['/out/x.js'],
      env: { COCKPIT_AGENT_ALIASES: '{"claude":"bare:c"}' },
    });
  });
});

describe('cockpit MCP helpers', () => {
  it('reports missing runtime env and resolves the aioncore binary', () => {
    expect(missingRuntimeEnv({ AIONUI_BASE_URL: 'x', AIONUI_USER_ID: 'u' })).toEqual([
      'AIONUI_CONVERSATION_ID',
      'AIONUI_RUNTIME_TOKEN',
    ]);
    expect(aioncoreBin({ AIONUI_HELPER_BIN: ' C:/a/aioncore.exe ' })).toBe('C:/a/aioncore.exe');
    expect(aioncoreBin({})).toBe('aioncore');
  });

  it('parses aliases defensively', () => {
    expect(parseAgentAliases('{"a":"1","b":2}')).toEqual({ a: '1' });
    expect(parseAgentAliases('not json')).toEqual({});
    expect(parseAgentAliases('[1]')).toEqual({});
  });

  it('asks the delegate to report back to the caller', () => {
    const message = buildDelegateMessage('  Fix the bug ', 'conv-9');
    expect(message.startsWith('Fix the bug')).toBe(true);
    expect(message).toContain('session_send_message (to: "conv-9")');
    expect(buildDelegateMessage('task', '')).toBe('task');
  });
});

describe('cockpit main-process files', () => {
  it('uses AIONUI_SHARED_SKILLS_DIR or ~/.agents/skills', () => {
    expect(sharedSkillsDir({ AIONUI_SHARED_SKILLS_DIR: 'D:/s' }, '/home/u')).toBe('D:/s');
    expect(sharedSkillsDir({}, '/home/u')).toBe(path.join('/home/u', '.agents', 'skills'));
  });

  it('lists only folders with a SKILL.md and writes handoff files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-'));
    await fs.mkdir(path.join(dir, 'b-skill'));
    await fs.writeFile(path.join(dir, 'b-skill', 'SKILL.md'), '---\nname: b\n---');
    await fs.mkdir(path.join(dir, 'a-skill'));
    await fs.writeFile(path.join(dir, 'a-skill', 'SKILL.md'), '');
    await fs.mkdir(path.join(dir, 'empty'));
    expect(await listSkillFolders(dir)).toEqual(['a-skill', 'b-skill']);
    expect(await listSkillFolders(path.join(dir, 'missing'))).toEqual([]);

    const file = await writeHandoffTranscript(dir, 'conv/../1', 'hello');
    expect(path.dirname(file)).toBe(path.join(dir, 'handoff'));
    expect(path.basename(file).startsWith(safeFileStem('conv/../1'))).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('hello');
    await fs.rm(dir, { recursive: true, force: true });
  });
});
