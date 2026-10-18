import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/common/adapter/httpBridge', () => ({ httpRequest: vi.fn() }));
vi.mock('@/common/adapter/ipcBridge', () => ({ mcpService: {} }));
vi.mock('@process/utils/initStorage', () => ({ getBuiltinMcpScriptPath: (name: string) => `/out/${name}.js` }));

const { buildHelperInput, resolveInputMode } = await import('@process/resources/builtinMcp/computerUseHost');
const { buildComputerUseMcpServer, findComputerUseHelper } = await import('@process/cockpit/cockpitMcp');

describe('computer use stays in the background', () => {
  it('needs both foreground mode and the user flag', () => {
    expect(resolveInputMode({})).toBe('background');
    expect(resolveInputMode({ mode: 'foreground' })).toBe('background');
    expect(resolveInputMode({ user_asked_for_foreground: true })).toBe('background');
    expect(resolveInputMode({ mode: 'foreground', user_asked_for_foreground: true })).toBe('foreground');
  });

  it('pins the mode on input actions and strips cockpit-only fields', () => {
    expect(buildHelperInput('click', { window: { id: 1 }, x: 1, y: 2, mode: 'foreground' })).toEqual({
      window: { id: 1 },
      x: 1,
      y: 2,
      mode: 'background',
    });
    expect(buildHelperInput('get_window_state', { window: { id: 1 }, user_asked_for_foreground: true })).toEqual({
      window: { id: 1 },
    });
  });
});

describe('computer use MCP registration', () => {
  it('finds the helper on PATH or through the env override', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cu-'));
    const name = process.platform === 'win32' ? 'poracode-computer-use.exe' : 'poracode-computer-use';
    const helper = path.join(dir, name);
    await fs.writeFile(helper, '');
    expect(findComputerUseHelper({ PATH: ['/nope', dir].join(path.delimiter) })).toBe(helper);
    expect(findComputerUseHelper({ COCKPIT_COMPUTER_USE_HELPER: helper, PATH: '' })).toBe(helper);
    expect(findComputerUseHelper({ PATH: '/nope' })).toBeUndefined();
  });

  it('passes the helper path to the server', () => {
    const server = buildComputerUseMcpServer('/out/builtin-mcp-computer-use.js', 'C:/bin/helper.exe');
    expect(server.name).toBe('aionui-computer-use');
    expect(server.transport).toMatchObject({
      type: 'stdio',
      command: 'node',
      args: ['/out/builtin-mcp-computer-use.js'],
      env: { COCKPIT_COMPUTER_USE_HELPER: 'C:/bin/helper.exe' },
    });
  });
});
